use axum::{
    body::{Body, to_bytes},
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderName, Request, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::Deserialize;
use std::path::Path as FsPath;
use std::pin::Pin;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};
use tokio::net::UnixStream;
use tokio_tungstenite::{
    client_async, connect_async,
    tungstenite::{Error as TError, Message as TMessage},
};

use crate::types::{ApiResponse, AppState, MIHOMO_CONF};

#[derive(Clone)]
enum ClashTarget {
    Tcp {
        host: String,
        port: String,
        secret: Option<String>,
    },
    Unix {
        path: String,
    },
}

const CLASH_TARGET_TTL: Duration = Duration::from_secs(5);
static CLASH_TARGET_CACHE: LazyLock<RwLock<Option<(ClashTarget, Instant)>>> =
    LazyLock::new(|| RwLock::new(None));

pub fn invalidate_clash_target_cache() {
    *CLASH_TARGET_CACHE.write().unwrap() = None;
}

#[derive(Deserialize)]
pub struct ClashWsQuery {
    pub port: Option<String>,
    pub secret: Option<String>,
    #[serde(rename = "unix")]
    pub unix: Option<String>,
}

pub async fn proxy_http(
    State(state): State<AppState>,
    Path(path): Path<String>,
    req: Request<Body>,
) -> Response {
    let (parts, body) = req.into_parts();
    let port_override = header_value(&parts.headers, "x-clash-port");
    let secret_override = header_value(&parts.headers, "x-clash-secret");
    let unix_override = header_value(&parts.headers, "x-clash-unix");

    let target =
        match resolve_clash_target(&state, port_override, secret_override, unix_override).await {
            Ok(t) => t,
            Err(e) => return make_bad_gateway(e),
        };

    let body_bytes = match to_bytes(body, usize::MAX).await {
        Ok(b) => b,
        Err(e) => return make_bad_gateway(e.to_string()),
    };

    match target {
        ClashTarget::Tcp { host, port, secret } => {
            let url = build_url("http", &host, &port, &path, parts.uri.query());
            do_proxy_http(state.http_client.clone(), parts, body_bytes, url, secret).await
        }
        ClashTarget::Unix { path: socket_path } => {
            let url = build_url("http", "localhost", "80", &path, parts.uri.query());
            let client = match reqwest::Client::builder()
                .unix_socket(socket_path)
                .user_agent("XKeen-UI")
                .timeout(std::time::Duration::from_secs(120))
                .build()
            {
                Ok(c) => c,
                Err(e) => return make_bad_gateway(e.to_string()),
            };
            do_proxy_http(client, parts, body_bytes, url, None).await
        }
    }
}

pub async fn proxy_ws(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Query(q): Query<ClashWsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let target = match resolve_clash_target(&state, q.port, q.secret, q.unix).await {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(ApiResponse::<()> {
                    success: false,
                    error: Some(e),
                    data: None,
                }),
            )
                .into_response();
        }
    };

    ws.on_upgrade(move |socket| async move {
        if let Err(e) = proxy_ws_inner(socket, path, target).await {
            eprintln!("Clash WS proxy error: {}", e);
        }
    })
}

async fn proxy_ws_inner(
    client_ws: WebSocket,
    path: String,
    target: ClashTarget,
) -> Result<(), String> {
    type UpstreamSink = Pin<Box<dyn Sink<TMessage, Error = TError> + Send>>;
    type UpstreamStream = Pin<Box<dyn Stream<Item = Result<TMessage, TError>> + Send>>;

    let (mut upstream_tx, mut upstream_rx): (UpstreamSink, UpstreamStream) = match target {
        ClashTarget::Tcp { host, port, secret } => {
            let mut url = build_url("ws", &host, &port, &path, None);
            if let Some(secret) = secret {
                url.push_str(&format!("?token={}", urlencoding::encode(&secret)));
            }
            let (ws, _) = connect_async(url).await.map_err(|e| e.to_string())?;
            let (tx, rx) = ws.split();
            (Box::pin(tx), Box::pin(rx))
        }
        ClashTarget::Unix { path: socket_path } => {
            let url = build_url("ws", "localhost", "80", &path, None);
            let stream = UnixStream::connect(socket_path)
                .await
                .map_err(|e| e.to_string())?;
            let (ws, _) = client_async(url, stream).await.map_err(|e| e.to_string())?;
            let (tx, rx) = ws.split();
            (Box::pin(tx), Box::pin(rx))
        }
    };

    let (mut client_tx, mut client_rx) = client_ws.split();

    let client_to_upstream = async {
        while let Some(Ok(msg)) = client_rx.next().await {
            let t_msg = match msg {
                Message::Text(t) => TMessage::Text(t.to_string().into()),
                Message::Binary(b) => TMessage::Binary(b),
                Message::Ping(p) => TMessage::Ping(p),
                Message::Pong(p) => TMessage::Pong(p),
                Message::Close(_) => {
                    let _ = upstream_tx.send(TMessage::Close(None)).await;
                    break;
                }
            };
            if upstream_tx.send(t_msg).await.is_err() {
                break;
            }
        }
    };

    let upstream_to_client = async {
        while let Some(Ok(msg)) = upstream_rx.next().await {
            let a_msg = match msg {
                TMessage::Text(t) => Message::Text(t.to_string().into()),
                TMessage::Binary(b) => Message::Binary(b),
                TMessage::Ping(p) => Message::Ping(p),
                TMessage::Pong(p) => Message::Pong(p),
                TMessage::Close(_) => {
                    let _ = client_tx.send(Message::Close(None)).await;
                    break;
                }
                _ => continue,
            };
            if client_tx.send(a_msg).await.is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = client_to_upstream => {},
        _ = upstream_to_client => {},
    }

    Ok(())
}

fn should_forward_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    !matches!(
        n,
        "host"
            | "connection"
            | "upgrade"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-protocol"
            | "content-length"
            | "x-clash-port"
            | "x-clash-secret"
            | "x-clash-unix"
            | "authorization"
    )
}

fn should_forward_response_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    !matches!(
        n,
        "connection"
            | "upgrade"
            | "sec-websocket-accept"
            | "sec-websocket-protocol"
            | "transfer-encoding"
            | "content-length"
    )
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn make_bad_gateway(err: String) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(ApiResponse::<()> {
            success: false,
            error: Some(err),
            data: None,
        }),
    )
        .into_response()
}

async fn do_proxy_http(
    client: reqwest::Client,
    parts: http::request::Parts,
    body_bytes: axum::body::Bytes,
    url: String,
    secret: Option<String>,
) -> Response {
    let mut builder = client.request(parts.method.clone(), url);
    for (name, value) in parts.headers.iter() {
        if should_forward_header(name) {
            builder = builder.header(name, value);
        }
    }
    if let Some(secret) = secret {
        builder = builder.header("Authorization", format!("Bearer {}", secret));
    }

    match builder.body(body_bytes).send().await {
        Ok(upstream) => build_http_response(upstream).await,
        Err(e) => make_bad_gateway(e.to_string()),
    }
}

async fn build_http_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let bytes = match upstream.bytes().await {
        Ok(b) => b,
        Err(_) => axum::body::Bytes::new(),
    };

    let mut response = Response::builder().status(status);
    for (name, value) in headers.iter() {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn resolve_clash_target(
    _state: &AppState,
    port_override: Option<String>,
    secret_override: Option<String>,
    unix_override: Option<String>,
) -> Result<ClashTarget, String> {
    let has_override = port_override.is_some() || secret_override.is_some() || unix_override.is_some();
    if !has_override {
        let cache = CLASH_TARGET_CACHE.read().unwrap();
        if let Some((target, ts)) = cache.as_ref() {
            if ts.elapsed() < CLASH_TARGET_TTL {
                return Ok(target.clone());
            }
        }
    }

    let mut host = "127.0.0.1".to_string();
    let mut port = port_override;
    let mut secret = secret_override;
    let mut unix_path: Option<String> = None;

    if let Some(u) = unix_override {
        unix_path = sanitize_unix_name(u);
    } else if let Ok(content) = read_mihomo_config().await {
        unix_path = parse_external_controller_unix(&content).map(resolve_unix_path);
        if port.is_none() {
            if let Some((h, p)) = parse_external_controller(&content) {
                host = h;
                port = Some(p);
            }
        }
        if secret.is_none() {
            secret = parse_secret(&content);
        }
    }

    let resolved = if let Some(path) = unix_path {
        if tokio::fs::metadata(&path).await.is_ok() {
            Some(ClashTarget::Unix { path })
        } else if let Some(port) = port {
            Some(ClashTarget::Tcp { host, port, secret })
        } else {
            None
        }
    } else if let Some(port) = port {
        Some(ClashTarget::Tcp { host, port, secret })
    } else {
        None
    };

    match resolved {
        Some(target) => {
            if !has_override {
                *CLASH_TARGET_CACHE.write().unwrap() = Some((target.clone(), Instant::now()));
            }
            Ok(target)
        }
        None => Err("Не найден порт external-controller".into()),
    }
}

async fn read_mihomo_config() -> Result<String, String> {
    let candidates = [
        format!("{}/config.yaml", MIHOMO_CONF),
        format!("{}/config.yml", MIHOMO_CONF),
    ];
    for path in candidates {
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            return Ok(content);
        }
    }
    Err("Не найден конфиг mihomo".into())
}

fn parse_external_controller(content: &str) -> Option<(String, String)> {
    let raw = parse_yaml_value(content, "external-controller:")?;
    parse_host_port(&raw)
}

fn parse_external_controller_unix(content: &str) -> Option<String> {
    parse_yaml_value(content, "external-controller-unix:")
}

fn parse_secret(content: &str) -> Option<String> {
    parse_yaml_value(content, "secret:")
}

fn parse_yaml_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let clean = line.split('#').next().unwrap_or("").trim_start();
        if let Some(rest) = clean.strip_prefix(key) {
            let value = rest.trim().trim_matches(&['"', '\''][..]).trim();
            if value.is_empty() {
                return None;
            }
            return Some(value.to_string());
        }
    }
    None
}

fn parse_host_port(raw: &str) -> Option<(String, String)> {
    let value = raw.trim().trim_matches(&['"', '\''][..]).trim();
    if value.is_empty() {
        return None;
    }

    if value.starts_with('[') {
        if let Some(end) = value.find(']') {
            let host = value[1..end].to_string();
            let rest = value[end + 1..].trim();
            if let Some(port) = rest.strip_prefix(':') {
                return Some((normalize_host(host), port.trim().to_string()));
            }
        }
    }

    if let Some((host, port)) = value.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            let host = if host.is_empty() {
                "127.0.0.1".to_string()
            } else {
                host.to_string()
            };
            return Some((normalize_host(host), port.to_string()));
        }
    }

    if value.chars().all(|c| c.is_ascii_digit()) {
        return Some(("127.0.0.1".to_string(), value.to_string()));
    }

    None
}

fn normalize_host(host: String) -> String {
    match host.as_str() {
        "0.0.0.0" | "::" => "127.0.0.1".to_string(),
        _ => host,
    }
}

fn resolve_unix_path(raw: String) -> String {
    let p = FsPath::new(&raw);
    if p.is_absolute() {
        raw
    } else {
        format!("{}/{}", MIHOMO_CONF, raw)
    }
}

fn sanitize_unix_name(raw: String) -> Option<String> {
    let name = FsPath::new(raw.trim())
        .file_name()?
        .to_string_lossy()
        .to_string();
    if name.is_empty() {
        return None;
    }
    Some(format!("{}/{}", MIHOMO_CONF, name))
}

fn build_url(scheme: &str, host: &str, port: &str, path: &str, query: Option<&str>) -> String {
    let mut url = format!(
        "{}://{}:{}/{}",
        scheme,
        host,
        port,
        path.trim_start_matches('/')
    );
    if let Some(q) = query {
        url.push('?');
        url.push_str(q);
    }
    url
}
