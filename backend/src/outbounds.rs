//! Разовый пинг аутбаунда Xray из GUI Outbounds.
//!
//! Как передаётся конфиг (выбор способа по актуальным исходникам XTLS/Xray-core):
//! - gRPC-загрузка конфига в уже запущенный процесс существует только через Commander
//!   (`app/commander` + `app/proxyman/command::AddInbound/AddOutbound`), но она требует
//!   ЗАРАНЕЕ сконфигурированного API-inbound в рабочем конфиге — использовать её для проверки
//!   произвольного аутбаунда нельзя.
//! - Тестовый конфиг на диск не пишется вообще: мы держим одноразовый HTTP-сервер на
//!   абстрактном unix-сокете, а xray сам из него забирает конфиг — `xray run -c '@name'`
//!   это remote-источник: `main/confloader/external::isRemoteSource` трактует любой
//!   аргумент `-c` с ведущим `@` как HTTP поверх unix-сокета, делает ровно один GET на `/`
//!   (`common/utils::SplitHTTPUnixURL` — без `:/` в аргументе путь по умолчанию «/») и ждёт
//!   статус 200 с JSON-телом (строгий парсер `DecodeJSONConfigStrict`, см. `infra/conf/serial`).
//!   Одиночный `@` — непаддированный абстрактный сокет Linux (`common/utils::ResolveSocketPath`).
//!   Сам remote-HTTP-лоадер появился в #5200 (unix socket HTTP config loader), абстрактные
//!   имена — #6111 (май 2026, т.е. нужна сборка не старее этого).
//!
//! Поэтому путь такой: одноразовый процесс `xray run -c '@cfg-socket'` с минимальным
//! конфигом — HTTP-прокси inbound БЕЗ ТЕГА на втором абстрактном unix-сокете `@name`
//! и единственный outbound, присланный фронтендом (первый outbound в Xray становится
//! дефолтным — весь трафик с inbound идёт в него, см. `app/proxyman/outbound/outbound.go`).
//! Абстрактный сокет вместо случайного TCP-порта, потому что socks-инбаунд Xray слушает
//! только TCP, а HTTP-инбаунд умеет unix (`Network = [TCP, UNIX]`) — и порты в принципе
//! не занимаются (нет гонки за эфемерный порт). Через полученный прокси отправляется
//! HEAD-запрос на URL (для https — CONNECT-туннель, TLS через rustls руками). По умолчанию
//! замеряется один запрос целиком, включая рукопожатие. С включённым «двойным пингом» первый
//! запрос прогревочный (DNS и TCP/TLS до цели), замеряется второй: по тому же TLS-соединению
//! для https, по новому соединению с прокси для http. Запуск ядра ограничен `STARTUP_TIMEOUT`,
//! а таймаут из настроек отсчитывается отдельно для каждого запроса.

use crate::types::{AppState};
use axum::extract::{Json, State};
use axum::response::IntoResponse;
use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::future::Future;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_rustls::TlsConnector;
use reqwest::Url;

/// На Keenetic-железе параллельный запуск нескольких xray — лишняя нагрузка, пинги обрабатываем
/// по одному.
static PING_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const MIN_TIMEOUT_MS: u64 = 500;
const MAX_TIMEOUT_MS: u64 = 30_000;

/// Лимит на запуск xray и готовность inbound — в таймаут пинга не входит.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Шаг опроса готовности абстрактного сокета (xray обычно стартует за 0.1–1 c).
const READINESS_POLL: Duration = Duration::from_millis(25);

/// История замеров — только в памяти (на диск не сохраняется, после рестарта сервиса
/// начинается с нуля): тег аутбаунда → последние N замеров.
#[derive(Serialize, Clone)]
struct PingHistoryEntry {
    time: String,
    delay: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Храним последние 10 замеров для каждого тега аутбаунда.
const PING_HISTORY_KEEP: usize = 10;

static PING_HISTORY: LazyLock<Mutex<BTreeMap<String, Vec<PingHistoryEntry>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// Дописывает замер в историю тега (0 — неуспешный/таймаут), обрезая до последних N.
async fn record_ping_history(tag: &str, delay: u64, error: Option<String>) {
    let mut history = PING_HISTORY.lock().await;
    let entries = history.entry(tag.to_string()).or_default();
    entries.push(PingHistoryEntry {
        time: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        delay,
        error,
    });
    if entries.len() > PING_HISTORY_KEEP {
        entries.drain(..entries.len() - PING_HISTORY_KEEP);
    }
}

pub async fn get_outbound_ping_history() -> impl IntoResponse {
    let history = PING_HISTORY.lock().await;
    Json(serde_json::json!({ "success": true, "history": &*history }))
}

#[derive(Deserialize)]
pub struct OutboundPingReq {
    /// Ровно тот объект outbound, который выбрал пользователь во вкладке фронтенда.
    pub outbound: serde_json::Value,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Copy)]
struct PingParams<'a> {
    url: &'a str,
    budget: Duration,
    label: &'a str,
    double_ping: bool,
}

#[derive(Debug, Clone, Copy)]
struct PingReply {
    latency_ms: u64,
    status: u16,
}

pub async fn post_outbound_ping(State(state): State<AppState>, Json(request): Json<OutboundPingReq>) -> impl IntoResponse {
    if !request.outbound.is_object() {
        return Json(serde_json::json!({ "success": false, "error": "Outbound не является объектом" }));
    }
    let tag = request
        .outbound
        .get("tag")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    let (settings_url, settings_timeout, double_ping) = {
        let settings = state.settings.read().unwrap();
        (
            settings.clash_api.ping_url.clone(),
            u64::from(settings.clash_api.ping_timeout),
            settings.clash_api.double_ping,
        )
    };
    let url = request
        .url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .unwrap_or(&settings_url)
        .to_string();
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(settings_timeout)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

    let label = if timeout_ms % 1000 == 0 {
        format!("{} с", timeout_ms / 1000)
    } else {
        format!("{timeout_ms} мс")
    };

    let _guard = PING_LOCK.lock().await;
    let params = PingParams {
        url: &url,
        budget: Duration::from_millis(timeout_ms),
        label: &label,
        double_ping,
    };
    let result = ping_outbound(&request.outbound, params).await;
    if !tag.is_empty() {
        let (delay, error) = match &result {
            Ok(reply) => (reply.latency_ms, None),
            Err(error) => (0, Some(error.clone())),
        };
        record_ping_history(&tag, delay, error).await;
    }
    match result {
        Ok(reply) => Json(serde_json::json!({
            "success": true,
            "latency_ms": reply.latency_ms,
            "status": reply.status,
        })),
        Err(error) => Json(serde_json::json!({ "success": false, "error": error })),
    }
}

type PingResult = Result<PingReply, String>;

/// Уникальное основание имени абстрактных сокетов одного запуска: два сокета на пинг —
/// выдача конфига (`-cfg`) и HTTP-прокси инбаунд xray (`-px`).
fn unique_socket_base() -> String {
    format!(
        "xkeen-ui-ping-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    )
}

async fn ping_outbound(outbound: &serde_json::Value, params: PingParams<'_>) -> PingResult {
    let startup_deadline = Instant::now() + STARTUP_TIMEOUT;

    // Абстрактный unix-сокет с уникальным именем: портов вообще нет — нет и TOCTOU-гонки
    // за эфемерный порт между биндом инбаунда и исходящими соединениями xray.
    let base = unique_socket_base();
    let config_socket = format!("{base}-cfg");
    let socket_name = format!("{base}-px");

    // Единственный outbound в тестовом конфиге — присланный фронтендом. Инбаунд без тега.
    // Прокси — HTTP (не socks): socks-инбаунд Xray слушает только TCP (`proxy/socks/server.go
    // ::Network`, unix не объявляет), а HTTP-инбаунд умеет (`Network = [TCP, UNIX]`, dsWorker
    // создаётся при PortList == nil) — значит listen `@name` даёт абстрактный unix-сокет.
    let config = serde_json::to_vec(&serde_json::json!({
        "log": { "loglevel": "none" },
        "inbounds": [{
            "protocol": "http",
            "listen": format!("@{socket_name}"),
            "settings": {}
        }],
        "outbounds": [outbound]
    }))
    .map_err(|e| e.to_string())?;

    // Конфиговыдающий сервер готовим ДО запуска xray: тот читает конфиг сразу на старте.
    // Имя ведёт себя как путь — ведущий `\0` собирается tokio в абстрактный адрес.
    let listener = UnixListener::bind(format!("\0{config_socket}"))
        .map_err(|e| format!("Не удалось открыть сокет выдачи конфига: {e}"))?;
    let config_task = tokio::spawn(serve_config(listener, config, startup_deadline));

    let result = run_ping(&config_socket, &socket_name, startup_deadline, params).await;

    // Конфиг уже выдан (или xray умер): сервер больше не нужен, абстрактное имя
    // освобождается при закрытии листенера.
    config_task.abort();
    result
}

/// Одноразовый HTTP-сервер конфига на абстрактном unix-сокете для remote-лоадера Xray
/// (`xray run -c '@name'`, `main/confloader/external::FetchHTTPContent`): тот делает
/// ровно один GET и ждёт статус 200 с JSON-телом; клиент живёт не дольше 30 c.
/// Ждём подключения до общего дедлайна (пинга или валидации) — дольше держать сокет незачем.
/// Переиспользуется также в `configs.rs` для валидации конфигов без временных файлов.
pub(crate) async fn serve_config(listener: UnixListener, config: Vec<u8>, deadline: Instant) {
    let (mut stream, _) = tokio::select! {
        accepted = listener.accept() => match accepted {
            Ok(stream) => stream,
            Err(_) => return,
        },
        _ = tokio::time::sleep_until(deadline.into()) => return,
    };
    // Тело запроса не интересует (GET без тела) — достаточно дождаться конца заголовков,
    // заодно гарантируя, что клиент успел всё отправить до того, как мы стали писать.
    if read_headers(&mut stream).await.is_err() {
        return;
    }
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        config.len()
    )
    .into_bytes();
    response.extend_from_slice(&config);
    _ = stream.write_all(&response).await;
    // EOF сигнализирует клиенту, что тело прочитано целиком (`buf.ReadAllToBytes`).
    _ = stream.shutdown().await;
}

/// Жизненный цикл одноразового xray: запуск → ожидание готовности → запрос → kill.
async fn run_ping(config_socket: &str, socket_name: &str, startup_deadline: Instant, params: PingParams<'_>) -> PingResult {
    let mut cmd = Command::new("xray");
    // `-format json` обязателен: автоопределение формата (`core::GetFormat`) смотрит на
    // расширение аргумента, а у абстрактного сокета его нет (`Failed to get format of @…`).
    cmd.args(["run", "-format", "json", "-c"])
        .arg(format!("@{config_socket}"));
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить xray: {e}"))?;
    let mut output = child.stdout.take();
    let mut error = child.stderr.take();
    // Ошибки Xray (в т.ч. кривой конфиг) падают и в stdout, и в stderr — читаем оба
    // в один буфер фоново, чтобы вне ветки смерти процесса не блокировать опрос готовности.
    let output_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(s) = output.as_mut() {
            _ = s.read_to_end(&mut buf).await;
        }
        if let Some(s) = error.as_mut() {
            _ = s.read_to_end(&mut buf).await;
        }
        buf
    });
    let result = ping_via_child(&mut child, socket_name, startup_deadline, params, output_task).await;

    // Гарантированно убиваем и забираем zombie, даже если выше случился таймаут/ошибка.
    _ = child.kill().await;
    _ = child.wait().await;
    result
}

async fn ping_via_child(
    child: &mut Child, socket_name: &str, startup_deadline: Instant, params: PingParams<'_>,
    output_task: tokio::task::JoinHandle<Vec<u8>>,
) -> PingResult {
    let mut stream = None;
    let mut failure = None;
    while Instant::now() < startup_deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                let buffer = match tokio::time::timeout(Duration::from_millis(500), output_task).await {
                    Ok(Ok(buffer)) => buffer,
                    _ => Vec::new(),
                };
                let output = String::from_utf8_lossy(&buffer);
                failure = Some(
                    output
                        .lines()
                        .rev()
                        .find(|line| !line.trim().is_empty())
                        .map_or_else(|| format!("xray завершился ({status})"), |line| line.chars().take(500).collect()),
                );
                break;
            }
            Ok(None) => {}
            Err(error) => {
                failure = Some(error.to_string());
                break;
            }
        }
        match UnixStream::connect(format!("\0{socket_name}")).await {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(_) => tokio::time::sleep(READINESS_POLL).await,
        }
    }

    let Some(stream) = stream else {
        return Err(failure.unwrap_or_else(|| format!("xray не запустился за {} с", STARTUP_TIMEOUT.as_secs())));
    };

    execute_request(stream, socket_name, params).await
}

/// TLS-конфиг с публичными корневыми сертификатами (как у reqwest: rustls) — строится один раз.
static TLS_CONFIG: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
});

async fn execute_request(mut stream: UnixStream, socket_name: &str, params: PingParams<'_>) -> PingResult {
    let PingParams { url, budget, label, double_ping } = params;
    let target = Url::parse(url).map_err(|e| format!("Некорректный URL пинга: {e}"))?;
    let scheme = target.scheme();
    let host = target.host_str().ok_or("В URL пинга нет хоста")?.to_string();
    let port = target.port_or_known_default().unwrap_or(80);
    let mut path = target.path().to_string();
    if path.is_empty() {
        path = "/".into();
    }
    if let Some(q) = target.query() {
        path = format!("{path}?{q}");
    }

    let started = Instant::now();
    let (status, elapsed) = if scheme == "https" {
        let connect_request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n");
        let connection = if double_ping { "keep-alive" } else { "close" };
        let request = format!("HEAD {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: XKeen-UI\r\nConnection: {connection}\r\n\r\n");
        let (mut tls, status) = within(budget, label, async {
            write_all(&mut stream, &connect_request).await?;
            let connect_status = parse_status(&read_headers(&mut stream).await?)?;
            if !(200..300).contains(&connect_status) {
                return Err(format!("Xray не открыл CONNECT-туннель (код {connect_status})"));
            }
            let server_name = rustls::pki_types::ServerName::try_from(host.clone())
                .map_err(|e| format!("Некорректный хост для TLS: {e}"))?;
            let mut tls = TlsConnector::from(TLS_CONFIG.clone())
                .connect(server_name, stream)
                .await
                .map_err(|e| format!("TLS-рукопожатие не удалось: {e}"))?;
            let status = head(&mut tls, &request).await?;
            Ok((tls, status))
        })
        .await?;
        if double_ping {
            reject_server_error(status)?;
            measure_head(&mut tls, &request, budget, label).await?
        } else {
            (status, started.elapsed())
        }
    } else {
        let request = format!(
            "HEAD http://{host}:{port}{path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: XKeen-UI\r\nConnection: close\r\n\r\n"
        );
        let status = within(budget, label, head(&mut stream, &request)).await?;
        if double_ping {
            reject_server_error(status)?;
            let mut second = UnixStream::connect(format!("\0{socket_name}"))
                .await
                .map_err(|e| format!("Не удалось подключиться к прокси xray: {e}"))?;
            measure_head(&mut second, &request, budget, label).await?
        } else {
            (status, started.elapsed())
        }
    };

    reject_server_error(status)?;
    Ok(PingReply {
        latency_ms: (elapsed.as_secs_f64() * 1000.0).round().max(1.0) as u64,
        status,
    })
}

async fn within<T>(budget: Duration, label: &str, future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(budget, future)
        .await
        .unwrap_or_else(|_| Err(format!("Таймаут {label}")))
}

async fn head<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S, request: &str) -> Result<u16, String> {
    write_all(stream, request).await?;
    parse_status(&read_headers(stream).await?)
}

async fn measure_head<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S, request: &str, budget: Duration, label: &str,
) -> Result<(u16, Duration), String> {
    let started = Instant::now();
    let status = within(budget, label, head(stream, request)).await?;
    Ok((status, started.elapsed()))
}

fn reject_server_error(status: u16) -> Result<u16, String> {
    if status >= 500 {
        return Err(format!("Ошибка на пути до цели (HTTP {status})"));
    }
    Ok(status)
}

async fn write_all<S: AsyncWrite + Unpin>(s: &mut S, buf: &str) -> Result<(), String> {
    s.write_all(buf.as_bytes())
        .await
        .map_err(|e| format!("Не удалось отправить запрос: {e}"))
}

/// Читает начало HTTP-ответа до конца заголовков (`\r\n\r\n`).
async fn read_headers<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::with_capacity(1024);
    loop {
        let read = reader
            .read_buf(&mut buffer)
            .await
            .map_err(|error| format!("Не удалось прочитать ответ: {error}"))?;
        if read == 0 {
            return Err("Соединение закрыто до конца HTTP-заголовков".into());
        }
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(buffer);
        }
        if buffer.len() > 32 * 1024 {
            return Err("Слишком большие HTTP-заголовки".into());
        }
    }
}

/// Статус из первой строки HTTP-ответа (`HTTP/1.1 204 No Content` → 204).
fn parse_status(headers: &[u8]) -> Result<u16, String> {
    let first_line = headers.split(|b| *b == b'\n').next().unwrap_or_default();
    let text = String::from_utf8_lossy(first_line);
    text.split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<u16>().ok())
        .ok_or_else(|| format!("Некорректный HTTP-статус: {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Выдача конфига по HTTP поверх абстрактного сокета: статус 200, тело — как есть.
    #[tokio::test]
    async fn config_is_served_over_abstract_socket() {
        let listener = UnixListener::bind(format!("\0xkeen-ui-test-cfg-{}", std::process::id())).unwrap();
        let config = b"{\"log\":{\"loglevel\":\"none\"}}".to_vec();
        tokio::spawn(serve_config(
            listener,
            config.clone(),
            Instant::now() + Duration::from_secs(5),
        ));

        let mut client = UnixStream::connect(format!("\0xkeen-ui-test-cfg-{}", std::process::id()))
            .await
            .unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();

        let text = String::from_utf8(response).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
        assert!(text.ends_with(String::from_utf8(config).unwrap().as_str()), "{text}");
    }

    // Требует xray в PATH; без него просто пропускается.
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_ping_freedom() {
        let Ok(out) = tokio::process::Command::new("xray").arg("version").output().await else {
            eprintln!("xray not in PATH, skipping");
            return;
        };
        if !out.status.success() {
            eprintln!("xray not runnable, skipping");
            return;
        }
        let outbound = serde_json::json!({
            "tag": "ping-test",
            "protocol": "freedom",
            "settings": {},
        });
        for double_ping in [false, true] {
            let params = PingParams {
                url: "https://cp.cloudflare.com/generate_204",
                budget: Duration::from_millis(8000),
                label: "8 с",
                double_ping,
            };
            let res = ping_outbound(&outbound, params).await;
            eprintln!("RESULT (double_ping={double_ping}): {res:?}");
        }
    }

    fn test_params(url: &str, double_ping: bool) -> PingParams<'_> {
        PingParams {
            url,
            budget: Duration::from_secs(5),
            label: "5 с",
            double_ping,
        }
    }

    async fn xray_available() -> bool {
        tokio::process::Command::new("xray")
            .arg("version")
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    }

    async fn spawn_no_content_server() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buffer = [0u8; 2048];
                    _ = socket.read(&mut buffer).await;
                    _ = socket
                        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                        .await;
                });
            }
        });
        port
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn local_target_reachable_through_untagged_outbound() {
        if !xray_available().await {
            return;
        }
        let port = spawn_no_content_server().await;
        let outbound = serde_json::json!({ "protocol": "freedom", "settings": {} });
        let url = format!("http://127.0.0.1:{port}/");
        for double_ping in [false, true] {
            let reply = ping_outbound(&outbound, test_params(&url, double_ping)).await.unwrap();
            assert_eq!(reply.status, 204);
            assert!(reply.latency_ms >= 1);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unreachable_target_is_failure_not_latency() {
        if !xray_available().await {
            return;
        }
        let outbound = serde_json::json!({ "tag": "dead", "protocol": "freedom", "settings": {} });
        for double_ping in [false, true] {
            let result = ping_outbound(&outbound, test_params("http://127.0.0.1:1/", double_ping)).await;
            assert!(result.unwrap_err().contains("503"));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn broken_outbound_reports_xray_error() {
        if !xray_available().await {
            return;
        }
        let outbound = serde_json::json!({ "tag": "broken", "protocol": "nonsense" });
        let result = ping_outbound(&outbound, test_params("http://127.0.0.1:1/", false)).await;
        assert!(result.unwrap_err().contains("nonsense"));
    }

    #[test]
    fn status_is_parsed_from_first_line() {
        assert_eq!(parse_status(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap(), 204);
        assert!(parse_status(b"garbage\r\n\r\n").is_err());
    }
}
