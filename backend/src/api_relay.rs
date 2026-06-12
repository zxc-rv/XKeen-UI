use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::Deserialize;
use std::path::Path as FsPath;
use std::pin::Pin;
use std::time::Duration;
use tokio::net::UnixStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{Error as TError, Message as TMessage};
use tokio_tungstenite::{client_async, connect_async};

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

#[derive(Deserialize)]
pub struct ClashWsQuery {
    pub port: Option<String>,
    pub secret: Option<String>,
    pub unix: Option<String>,
}

pub async fn get_device_list(State(state): State<AppState>) -> impl IntoResponse {
    let response = match state
        .http_client
        .get("http://127.0.0.1:79/rci/show/device-list")
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => return Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    };

    if !response.status().is_success() {
        return Json(serde_json::json!({
            "success": false,
            "error": format!("RCI вернул {}", response.status()),
        }));
    }

    match response.json::<serde_json::Value>().await {
        Ok(data) => Json(serde_json::json!({
            "success": true,
            "host": data.get("host").cloned().unwrap_or_else(|| serde_json::json!([])),
        })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}

pub async fn proxy_http(State(state): State<AppState>, Path(path): Path<String>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let port_override = header_value(&parts.headers, "x-clash-port");
    let secret_override = header_value(&parts.headers, "x-clash-secret");
    let unix_override = header_value(&parts.headers, "x-clash-unix");

    let target = match resolve_clash_target(port_override, secret_override, unix_override).await {
        Ok(t) => t,
        Err(e) => return make_error(StatusCode::BAD_GATEWAY, e),
    };

    const CLASH_BODY_LIMIT: usize = 16 * 1024 * 1024;
    let body_bytes = match to_bytes(body, CLASH_BODY_LIMIT).await {
        Ok(b) => b,
        Err(e) => return make_error(StatusCode::BAD_GATEWAY, e.to_string()),
    };

    match target {
        ClashTarget::Tcp { host, port, secret } => {
            let url = build_url("http", &host, &port, &path, parts.uri.query());
            do_proxy_http(state.http_client.clone(), parts, body_bytes, url, secret).await
        }
        ClashTarget::Unix { path: socket_path } => {
            let url = build_url("http", "127.0.0.1", "80", &path, parts.uri.query());
            let client = match reqwest::Client::builder()
                .unix_socket(socket_path)
                .user_agent("XKeen-UI")
                .timeout(Duration::from_secs(120))
                .build()
            {
                Ok(c) => c,
                Err(e) => return make_error(StatusCode::BAD_GATEWAY, e.to_string()),
            };
            do_proxy_http(client, parts, body_bytes, url, None).await
        }
    }
}

pub async fn proxy_ws(
    Path(path): Path<String>, Query(q): Query<ClashWsQuery>, ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let target = match resolve_clash_target(q.port, q.secret, q.unix).await {
        Ok(t) => t,
        Err(e) => return make_error(StatusCode::BAD_REQUEST, e),
    };

    ws.on_upgrade(move |socket| async move {
        if let Err(e) = proxy_ws_inner(socket, path, target).await {
            eprintln!("Clash WS proxy error: {}", e);
        }
    })
}

async fn proxy_ws_inner(client_ws: WebSocket, path: String, target: ClashTarget) -> Result<(), String> {
    type UpstreamSink = Pin<Box<dyn Sink<TMessage, Error = TError> + Send>>;
    type UpstreamStream = Pin<Box<dyn Stream<Item = Result<TMessage, TError>> + Send>>;

    let (mut upstream_tx, mut upstream_rx): (UpstreamSink, UpstreamStream) = match target {
        ClashTarget::Tcp { host, port, secret } => {
            let mut url = build_url("ws", &host, &port, &path, None);
            if let Some(secret) = secret {
                url.push_str(&format!("?token={}", urlencoding::encode(&secret)));
            }
            let (ws, _) = timeout(Duration::from_secs(5), connect_async(url))
                .await
                .map_err(|_| "Upstream connect timeout".to_string())?
                .map_err(|e| e.to_string())?;
            let (tx, rx) = ws.split();
            (Box::pin(tx), Box::pin(rx))
        }
        ClashTarget::Unix { path: socket_path } => {
            let url = build_url("ws", "127.0.0.1", "80", &path, None);
            let (ws, _) = timeout(Duration::from_secs(5), async {
                let stream = UnixStream::connect(socket_path).await?;
                client_async(url, stream).await.map_err(|e| std::io::Error::other(e.to_string()))
            })
            .await
            .map_err(|_| "Upstream connect timeout".to_string())?
            .map_err(|e| e.to_string())?;
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

fn make_error(status: StatusCode, err: String) -> Response {
    (
        status,
        axum::Json(ApiResponse::<()> {
            success: false,
            error: Some(err),
            data: None,
        }),
    )
        .into_response()
}

async fn do_proxy_http(
    client: reqwest::Client, parts: http::request::Parts, body_bytes: axum::body::Bytes, url: String,
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
        Err(e) => make_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn build_http_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let bytes = upstream.bytes().await.unwrap_or_default();

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
    port_override: Option<String>, secret_override: Option<String>, unix_override: Option<String>,
) -> Result<ClashTarget, String> {
    if let Some(u) = unix_override {
        if let Some(path) = sanitize_unix_name(&u) {
            if tokio::fs::metadata(&path).await.is_ok() {
                return Ok(ClashTarget::Unix { path });
            }
            return Err("Unix сокет не найден на диске".into());
        }
    }

    if let Some(port) = port_override {
        return Ok(ClashTarget::Tcp {
            host: "127.0.0.1".to_string(),
            port,
            secret: secret_override,
        });
    }

    Err("Фронт не передал данные для подключения".into())
}

fn sanitize_unix_name(raw: &str) -> Option<String> {
    let name = FsPath::new(raw.trim()).file_name()?.to_string_lossy();
    if name.is_empty() {
        return None;
    }
    Some(format!("{}/{}", MIHOMO_CONF, name))
}

fn build_url(scheme: &str, host: &str, port: &str, path: &str, query: Option<&str>) -> String {
    let mut url = format!("{}://{}:{}/{}", scheme, host, port, path.trim_start_matches('/'));
    if let Some(q) = query {
        url.push('?');
        url.push_str(q);
    }
    url
}
