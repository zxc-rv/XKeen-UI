//! Пинг аутбаундов Xray из GUI Outbounds: одиночный (`/api/healthcheck`) и «тест всех»
//! (`/api/healthcheck/all`).
//!
//! На каждый запуск поднимается одноразовый `xray -c '@<сокет>'`. Конфиг на диск не пишется:
//! remote-лоадер xray сам забирает его по HTTP с абстрактного unix-сокета (`serve_config`;
//! лоадер появился в #5200, абстрактные имена — в #6111, нужна сборка не старее мая 2026).
//! В конфиге только присланный фронтом outbound и inbound `tunnel` на втором абстрактном
//! сокете с `rewriteAddress`/`rewritePort` (хост и порт из URL пинга). Порты не занимаются.
//!
//! Замер — HEAD-запрос по сырой трубе tunnel (для https TLS поверх неё через rustls).
//! Режимы (`PingMode`):
//! - `Single`: один запрос, в замер входит рукопожатие;
//! - `Double`: первый запрос прогревает DNS, замеряется второй на новом соединении
//!   (рукопожатие в замере);
//! - `DoubleKeepAlive`: замеряется второй запрос по тому же соединению, без рукопожатия.
//!
//! Запуск ядра ограничен `STARTUP_TIMEOUT` и в таймаут пинга не входит, таймаут из настроек
//! отсчитывается отдельно на каждый запрос. Если xray не запустился, замера не было и
//! история не меняется.
//!
//! «Тест всех» — один процесс xray на весь список: на каждый аутбаунд свой tunnel-инбаунд с
//! тегом на отдельном сокете и правило `inboundTag → outboundTag` (без правил весь трафик
//! ушёл бы в первый outbound — он в Xray дефолтный). Замеры идут параллельно, не более
//! `PING_CONCURRENCY` сразу, у каждого свой бюджет.

use crate::logger::log;
use crate::types::{AppState, PingMode};
use axum::extract::{Json, State};
use axum::response::IntoResponse;
use chrono::SecondsFormat;
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{Mutex, oneshot};
use tokio_rustls::TlsConnector;
use reqwest::Url;

/// Пинги идут по одному запуску xray за раз: на Keenetic несколько ядер сразу — лишняя нагрузка.
static PING_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const MIN_TIMEOUT_MS: u64 = 500;
const MAX_TIMEOUT_MS: u64 = 30_000;

/// Лимит на запуск xray и готовность inbound — в таймаут пинга не входит.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Сколько замеров «теста всех» идут одновременно: на слабом ARM-железе лавина TLS-рукопожатий
/// завышает задержки.
const PING_CONCURRENCY: usize = 8;

/// Убирает сервер выдачи конфига и при отмене запроса (клиент оборвал соединение).
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Префикс ошибки подключения к сокету tunnel-инбаунда: сбой ядра, а не замера, поэтому
/// поднимается наверх как ошибка запуска.
const SOCKET_ERROR: &str = "Не удалось подключиться к сокету Xray";

/// История замеров — только в памяти (на диск не сохраняется, после рестарта сервиса
/// начинается с нуля): тег аутбаунда → последние N замеров.
#[derive(Serialize, Clone)]
struct PingHistoryEntry {
    time: String,
    delay: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

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

pub async fn get_healthcheck_history() -> impl IntoResponse {
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

#[derive(Deserialize)]
pub struct HealthcheckAllReq {
    /// Аутбаунды активного конфига — проверяются параллельно одним процессом xray.
    pub outbounds: Vec<serde_json::Value>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone)]
struct PingParams {
    target: Url,
    budget: Duration,
    label: String,
    mode: PingMode,
}

#[derive(Debug, Clone, Copy)]
struct PingReply {
    latency_ms: u64,
    status: u16,
}

pub async fn post_healthcheck(State(state): State<AppState>, Json(request): Json<OutboundPingReq>) -> impl IntoResponse {
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

    let params = match resolve_ping_params(&state, request.url.as_deref(), request.timeout_ms) {
        Ok(params) => params,
        Err(error) => return Json(serde_json::json!({ "success": false, "error": error })),
    };

    let _guard = PING_LOCK.lock().await;
    let result = match ping_outbound(&request.outbound, params).await {
        Ok(result) => result,
        Err(error) => return startup_failure(error),
    };
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
        Err(error) => Json(serde_json::json!({ "success": true, "latency_ms": 0, "error": error })),
    }
}

/// «Тест всех»: список аутбаундов → один процесс xray, замеры по всем параллельно.
/// Ответ — по одному элементу на тег; если xray не запустился, отдаётся `success: false`,
/// причина пишется в лог, а история замеров не меняется.
pub async fn post_healthcheck_all(State(state): State<AppState>, Json(request): Json<HealthcheckAllReq>) -> impl IntoResponse {
    let params = match resolve_ping_params(&state, request.url.as_deref(), request.timeout_ms) {
        Ok(params) => params,
        Err(error) => return Json(serde_json::json!({ "success": false, "error": error })),
    };

    let _guard = PING_LOCK.lock().await;
    let results = match ping_all(&request.outbounds, params).await {
        Ok(results) => results,
        Err(error) => return startup_failure(error),
    };
    let mut reply = Vec::with_capacity(results.len());
    for (tag, result) in results {
        match result {
            Ok(measured) => {
                record_ping_history(&tag, measured.latency_ms, None).await;
                reply.push(serde_json::json!({
                    "tag": tag,
                    "success": true,
                    "latency_ms": measured.latency_ms,
                }));
            }
            Err(error) => {
                record_ping_history(&tag, 0, Some(error.clone())).await;
                reply.push(serde_json::json!({
                    "tag": tag,
                    "success": false,
                    "latency_ms": 0,
                    "error": error,
                }));
            }
        }
    }
    Json(serde_json::json!({ "success": true, "results": reply }))
}

/// Ошибка запуска xray: полный текст — в лог. До фронта доходит только ошибка про сокет,
/// остальные случаи он показывает общим сообщением.
fn startup_failure(error: String) -> Json<serde_json::Value> {
    log("ERROR", error.clone());
    if error.starts_with(SOCKET_ERROR) {
        return Json(serde_json::json!({ "success": false, "error": SOCKET_ERROR }));
    }
    Json(serde_json::json!({ "success": false }))
}

/// URL цели и бюджет замера: приоритет у значений из запроса, иначе — настройки clash_api.
fn resolve_ping_params(state: &AppState, url: Option<&str>, timeout_ms: Option<u64>) -> Result<PingParams, String> {
    let (settings_url, settings_timeout, mode) = {
        let settings = state.settings.read().unwrap();
        (
            settings.clash_api.ping_url.clone(),
            u64::from(settings.clash_api.ping_timeout),
            settings.clash_api.ping_mode,
        )
    };
    let url = url.map(str::trim).filter(|url| !url.is_empty()).unwrap_or(&settings_url);
    let target = match Url::parse(url) {
        Ok(target) if target.host_str().is_some() => target,
        Ok(_) => return Err("В URL пинга нет хоста".into()),
        Err(error) => return Err(format!("Некорректный URL пинга: {error}")),
    };
    let timeout_ms = timeout_ms.unwrap_or(settings_timeout).clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let label = if timeout_ms % 1000 == 0 {
        format!("{} с", timeout_ms / 1000)
    } else {
        format!("{timeout_ms} мс")
    };
    Ok(PingParams {
        target,
        budget: Duration::from_millis(timeout_ms),
        label,
        mode,
    })
}

type PingResult = Result<PingReply, String>;

/// Основание имён абстрактных сокетов одного запуска: `-cfg` — выдача конфига,
/// `-px` (в «тесте всех» `-px-N`) — tunnel-инбаунды.
fn unique_socket_base() -> String {
    format!(
        "healthcheck-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    )
}

/// `Err` — xray не запустился (кривой конфиг, нет бинарника, сокет не открылся): замера не было.
/// `Ok` — ядро поднялось, внутри результат самого замера.
async fn ping_outbound(outbound: &serde_json::Value, params: PingParams) -> Result<PingResult, String> {
    let startup_deadline = Instant::now() + STARTUP_TIMEOUT;

    let base = unique_socket_base();
    let config_socket = format!("{base}-cfg");
    let socket_name = format!("{base}-px");

    // Единственный outbound — присланный фронтом: он первый, а значит дефолтный, поэтому
    // правила маршрутизации не нужны. Ведущий `@` в `listen` даёт абстрактный unix-сокет.
    let host = params.target.host_str().ok_or("В URL пинга нет хоста")?;
    let port = params.target.port_or_known_default().unwrap_or(80);
    let config = serde_json::to_vec(&serde_json::json!({
        "log": { "access": "none", "loglevel": "warning" },
        "inbounds": [{
            "protocol": "tunnel",
            "listen": format!("@{socket_name}"),
            "settings": { "rewriteAddress": host.trim_matches(['[', ']']), "rewritePort": port }
        }],
        "outbounds": [outbound]
    }))
    .map_err(|e| e.to_string())?;

    // Сервер конфига готовим ДО запуска xray: он читает конфиг сразу на старте.
    // Ведущий `\0` tokio собирает в абстрактный адрес.
    let listener = UnixListener::bind(format!("\0{config_socket}"))
        .map_err(|e| format!("Не удалось открыть сокет выдачи конфига: {e}"))?;
    let _config_task = AbortOnDrop(tokio::spawn(serve_config(listener, config, startup_deadline)));

    run_ping(&config_socket, &socket_name, startup_deadline, params).await
}

/// Параллельный пинг всех присланных аутбаундов одним процессом xray: на каждый аутбаунд —
/// свой tunnel-инбаунд на отдельном абстрактном сокете и правило `inboundTag → outboundTag`.
/// Возвращает замер по каждому непустому тегу; `Err` — xray не запустился (один битый аутбаунд
/// валит запуск всего списка: строгий парсер конфига отвергает его целиком).
async fn ping_all(outbounds: &[serde_json::Value], params: PingParams) -> Result<Vec<(String, PingResult)>, String> {
    // История и ответ ключуются тегом — пингуем только объекты с непустым тегом.
    let mut items: Vec<(String, serde_json::Value)> = outbounds
        .iter()
        .filter(|outbound| outbound.is_object())
        .map(|outbound| {
            (
                outbound
                    .get("tag")
                    .and_then(|tag| tag.as_str())
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string(),
                outbound.clone(),
            )
        })
        .filter(|(tag, _)| !tag.is_empty())
        .collect();
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let host = params.target.host_str().unwrap_or_default().to_string();
    let port = params.target.port_or_known_default().unwrap_or(80);

    let startup_deadline = Instant::now() + STARTUP_TIMEOUT;
    let base = unique_socket_base();
    let config_socket = format!("{base}-cfg");

    let mut inbounds = Vec::with_capacity(items.len());
    let mut rules = Vec::with_capacity(items.len());
    let mut sockets = Vec::with_capacity(items.len());
    let mut used_tags: HashSet<String> = HashSet::new();
    for (index, (tag, outbound)) in items.iter_mut().enumerate() {
        let socket = format!("{base}-px-{index}");
        let inbound_tag = format!("chk-in-{index}");
        inbounds.push(serde_json::json!({
            "tag": inbound_tag,
            "protocol": "tunnel",
            "listen": format!("@{socket}"),
            "settings": { "rewriteAddress": host, "rewritePort": port }
        }));
        // Направление в «свой» аутбаунд задаём правилом по тегу инбаунда; тег аутбаунда
        // делаем уникальным — конфиг с дубликатами Xray отвергает целиком.
        let mut outbound_tag = tag.clone();
        let mut suffix = 0;
        while !used_tags.insert(outbound_tag.clone()) {
            suffix += 1;
            outbound_tag = format!("{tag}-{suffix}");
        }
        outbound["tag"] = serde_json::Value::String(outbound_tag.clone());
        rules.push(serde_json::json!({
            "inboundTag": [inbound_tag],
            "outboundTag": outbound_tag,
        }));
        sockets.push(socket);
    }

    let mut outbounds_list = vec![serde_json::json!({ "tag": "chk-default", "protocol": "blackhole", "settings": {} })];
    outbounds_list.extend(items.iter().map(|(_, outbound)| outbound.clone()));
    let config = match serde_json::to_vec(&serde_json::json!({
        "log": { "access": "none", "loglevel": "warning" },
        "inbounds": inbounds,
        "outbounds": outbounds_list,
        "routing": { "rules": rules },
    })) {
        Ok(config) => config,
        Err(error) => return Err(error.to_string()),
    };

    let listener = match UnixListener::bind(format!("\0{config_socket}")) {
        Ok(listener) => listener,
        Err(error) => return Err(format!("Не удалось открыть сокет выдачи конфига: {error}")),
    };
    let _config_task = AbortOnDrop(tokio::spawn(serve_config(listener, config, startup_deadline)));

    let outcome = match start_xray(&config_socket).await {
        Ok((mut child, ready, output_task)) => {
            let measurements = match wait_xray_ready(&mut child, startup_deadline, ready, output_task).await {
                Ok(()) => {
                    // `buffered` сохраняет порядок: результаты зипуются с тегами по позиции.
                    let futures = sockets.iter().cloned().map(|socket| {
                        let params = params.clone();
                        async move { execute_request(&socket, params).await }
                    });
                    let measurements = stream::iter(futures).buffered(PING_CONCURRENCY).collect::<Vec<_>>().await;
                    match measurements.iter().find_map(|result| result.as_ref().err().filter(|error| error.starts_with(SOCKET_ERROR))) {
                        Some(error) => Err(error.clone()),
                        None => Ok(measurements),
                    }
                }
                Err(error) => Err(error),
            };
            _ = child.kill().await;
            _ = child.wait().await;
            measurements
        }
        Err(error) => Err(error),
    };

    Ok(items
        .into_iter()
        .zip(outcome?)
        .map(|((tag, _), result)| (tag, result))
        .collect())
}

/// Одноразовый HTTP-сервер конфига на абстрактном unix-сокете для remote-лоадера Xray
/// (`xray -c '@name'`): тот делает ровно один GET и ждёт статус 200 с JSON-телом.
/// Ждёт подключения не дольше `deadline`. Используется и в `configs.rs` для валидации
/// конфигов без временных файлов.
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
async fn run_ping(
    config_socket: &str, socket_name: &str, startup_deadline: Instant, params: PingParams,
) -> Result<PingResult, String> {
    let (mut child, ready, output_task) = start_xray(config_socket).await?;
    let result = match wait_xray_ready(&mut child, startup_deadline, ready, output_task).await {
        Ok(()) => match execute_request(socket_name, params).await {
            Err(error) if error.starts_with(SOCKET_ERROR) => Err(error),
            result => Ok(result),
        },
        Err(error) => Err(error),
    };

    _ = child.kill().await;
    _ = child.wait().await;
    result
}

/// Запуск xray с конфигом из `config_socket`: процесс, канал готовности и задача сбора вывода.
async fn start_xray(config_socket: &str) -> Result<(Child, oneshot::Receiver<()>, tokio::task::JoinHandle<Vec<u8>>), String> {
    let mut cmd = Command::new("xray");
    // `-format json` обязателен: автоопределение формата (`core::GetFormat`) смотрит на
    // расширение аргумента, а у абстрактного сокета его нет (`Failed to get format of @…`).
    cmd.args(["-format", "json", "-c"])
        .arg(format!("@{config_socket}"));
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить Xray: {e}"))?;
    let (ready_sender, ready_receiver) = oneshot::channel();
    let output_task = tokio::spawn(collect_output(child.stdout.take(), child.stderr.take(), ready_sender));
    Ok((child, ready_receiver, output_task))
}

/// Читает вывод xray: копит его для текста ошибки и по строке `core: Xray … started` шлёт
/// сигнал готовности. Её xray пишет на уровне warning после старта всех inbound, поэтому в
/// тестовом конфиге `loglevel: warning`; при смене формата строки все пинги упадут по
/// таймауту запуска — ловят e2e-тесты с настоящим xray.
async fn collect_output(stdout: Option<ChildStdout>, stderr: Option<ChildStderr>, ready: oneshot::Sender<()>) -> Vec<u8> {
    let read_stdout = async {
        let mut buffer = Vec::new();
        let Some(stdout) = stdout else {
            return buffer;
        };
        let mut ready = Some(ready);
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            buffer.extend_from_slice(line.as_bytes());
            buffer.push(b'\n');
            if line.trim_end().ends_with("started") {
                _ = ready.take().map(|sender| sender.send(()));
            }
        }
        buffer
    };
    let read_stderr = async {
        let mut buffer = Vec::new();
        if let Some(mut stderr) = stderr {
            _ = stderr.read_to_end(&mut buffer).await;
        }
        buffer
    };
    let (mut buffer, error_buffer) = tokio::join!(read_stdout, read_stderr);
    buffer.extend(error_buffer);
    buffer
}

/// Ждёт готовности ядра. Ранний выход xray — ошибка с последней строкой вывода, отсутствие
/// сигнала до `startup_deadline` — таймаут запуска.
async fn wait_xray_ready(
    child: &mut Child,
    startup_deadline: Instant,
    ready: oneshot::Receiver<()>,
    output_task: tokio::task::JoinHandle<Vec<u8>>,
) -> Result<(), String> {
    let exit = tokio::select! {
        Ok(()) = ready => None,
        status = child.wait() => Some(status),
        _ = tokio::time::sleep_until(startup_deadline.into()) => {
            return Err(format!("Xray не запустился за {} с", STARTUP_TIMEOUT.as_secs()));
        }
    };

    if let Some(status) = exit {
        let buffer = match tokio::time::timeout(Duration::from_millis(500), output_task).await {
            Ok(Ok(buffer)) => buffer,
            _ => Vec::new(),
        };
        let output = String::from_utf8_lossy(&buffer);
        return Err(match status {
            Ok(status) => output
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map_or_else(|| format!("Xray завершился ({status})"), |line| line.chars().take(500).collect()),
            Err(error) => error.to_string(),
        });
    }

    Ok(())
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

async fn execute_request(socket_name: &str, params: PingParams) -> PingResult {
    let target = &params.target;
    let host = target.host_str().ok_or("В URL пинга нет хоста")?;
    let host_header = target.port().map_or_else(|| host.to_string(), |port| format!("{host}:{port}"));
    let mut path = target.path().to_string();
    if let Some(query) = target.query() {
        path = format!("{path}?{query}");
    }
    let connection = if params.mode == PingMode::DoubleKeepAlive { "keep-alive" } else { "close" };
    let request = format!("HEAD {path} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: XKeen-UI\r\nConnection: {connection}\r\n\r\n");

    let connect_plain = move || async move {
        UnixStream::connect(format!("\0{socket_name}"))
            .await
            .map_err(|e| format!("{SOCKET_ERROR}: {e}"))
    };
    let (status, elapsed) = if target.scheme() == "https" {
        let server_name = rustls::pki_types::ServerName::try_from(host.trim_matches(['[', ']']).to_string())
            .map_err(|e| format!("Некорректный хост для TLS: {e}"))?;
        let connect_tls = move || {
            let server_name = server_name.clone();
            async move {
                TlsConnector::from(TLS_CONFIG.clone())
                    .connect(server_name, connect_plain().await?)
                    .await
                    .map_err(|e| format!("TLS-рукопожатие не удалось: {e}"))
            }
        };
        probe(connect_tls, &request, &params).await?
    } else {
        probe(connect_plain, &request, &params).await?
    };

    reject_server_error(status)?;
    Ok(PingReply {
        latency_ms: (elapsed.as_secs_f64() * 1000.0).round().max(1.0) as u64,
        status,
    })
}

async fn probe<S, F, Fut>(connect: F, request: &str, params: &PingParams) -> Result<(u16, Duration), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn() -> Fut,
    Fut: Future<Output = Result<S, String>>,
{
    let (mut tunnel, status, elapsed) = open_and_head(&connect, request, params).await?;
    if params.mode == PingMode::Single {
        return Ok((status, elapsed));
    }
    reject_server_error(status)?;
    if params.mode == PingMode::DoubleKeepAlive {
        return measure_head(&mut tunnel, request, params.budget, &params.label).await;
    }
    drop(tunnel);
    let (_, status, elapsed) = open_and_head(&connect, request, params).await?;
    Ok((status, elapsed))
}

async fn open_and_head<S, F, Fut>(connect: &F, request: &str, params: &PingParams) -> Result<(S, u16, Duration), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn() -> Fut,
    Fut: Future<Output = Result<S, String>>,
{
    let started = Instant::now();
    let (tunnel, status) = within(params.budget, &params.label, async {
        let mut tunnel = connect().await?;
        let status = head(&mut tunnel, request).await?;
        Ok((tunnel, status))
    })
    .await?;
    Ok((tunnel, status, started.elapsed()))
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
            eprintln!("Xray not in PATH, skipping");
            return;
        };
        if !out.status.success() {
            eprintln!("Xray not runnable, skipping");
            return;
        }
        let outbound = serde_json::json!({
            "tag": "ping-test",
            "protocol": "freedom",
            "settings": {},
        });
        for mode in PING_MODES {
            let params = PingParams {
                target: Url::parse("https://cp.cloudflare.com/generate_204").unwrap(),
                budget: Duration::from_millis(8000),
                label: "8 с".into(),
                mode,
            };
            let res = ping_outbound(&outbound, params).await;
            eprintln!("RESULT ({mode:?}): {res:?}");
        }
    }

    const PING_MODES: [PingMode; 3] = [PingMode::Single, PingMode::Double, PingMode::DoubleKeepAlive];

    // Параллельный «тест всех»: один процесс xray, инбаунд+правило на каждый аутбаунд,
    // дубликат тега переименовывается, уникальный живёт под своим именем.
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_ping_all_parallel() {
        if !xray_available().await {
            return;
        }
        let port = spawn_no_content_server().await;
        let outbounds = vec![
            serde_json::json!({ "tag": "a", "protocol": "freedom", "settings": {} }),
            serde_json::json!({ "tag": "a", "protocol": "freedom", "settings": {} }),
            serde_json::json!({ "tag": "b", "protocol": "freedom", "settings": {} }),
        ];
        let results = ping_all(&outbounds, test_params(&format!("http://127.0.0.1:{port}/"), PingMode::Single))
            .await
            .unwrap();
        assert_eq!(results.len(), 3);
        for (tag, result) in results {
            let reply = result.unwrap_or_else(|error| panic!("«{tag}»: {error}"));
            assert_eq!(reply.status, 204);
            assert!(reply.latency_ms >= 1);
        }
    }

    // Битый аутбаунд валит запуск ядра целиком: это ошибка запуска, а не замеры по тегам.
    #[tokio::test(flavor = "multi_thread")]
    async fn e2e_ping_all_broken_outbound_is_startup_failure() {
        if !xray_available().await {
            return;
        }
        let port = spawn_no_content_server().await;
        let outbounds = vec![
            serde_json::json!({ "tag": "broken", "protocol": "nonsense" }),
            serde_json::json!({ "tag": "good", "protocol": "freedom", "settings": {} }),
        ];
        let error = ping_all(&outbounds, test_params(&format!("http://127.0.0.1:{port}/"), PingMode::Single))
            .await
            .unwrap_err();
        assert!(error.contains("nonsense"), "{error}");
    }

    fn test_params(url: &str, mode: PingMode) -> PingParams {
        PingParams {
            target: Url::parse(url).unwrap(),
            budget: Duration::from_secs(5),
            label: "5 с".into(),
            mode,
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
                    while socket.read(&mut buffer).await.is_ok_and(|read| read > 0) {
                        _ = socket.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").await;
                    }
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
        for mode in PING_MODES {
            let reply = ping_outbound(&outbound, test_params(&url, mode)).await.unwrap().unwrap();
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
        for mode in PING_MODES {
            let result = ping_outbound(&outbound, test_params("http://127.0.0.1:1/", mode)).await.unwrap();
            assert!(result.is_err());
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn broken_outbound_reports_xray_error() {
        if !xray_available().await {
            return;
        }
        let outbound = serde_json::json!({ "tag": "broken", "protocol": "nonsense" });
        let error = ping_outbound(&outbound, test_params("http://127.0.0.1:1/", PingMode::Single))
            .await
            .unwrap_err();
        assert!(error.contains("nonsense"), "{error}");
    }

    #[tokio::test]
    async fn missing_tunnel_socket_is_socket_error() {
        for mode in PING_MODES {
            let error = execute_request("no-such-socket", test_params("http://127.0.0.1:1/", mode))
                .await
                .unwrap_err();
            assert!(error.starts_with(SOCKET_ERROR), "{error}");
        }
    }

    #[test]
    fn status_is_parsed_from_first_line() {
        assert_eq!(parse_status(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap(), 204);
        assert!(parse_status(b"garbage\r\n\r\n").is_err());
    }
}
