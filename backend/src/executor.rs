use crate::types::{AppState, UpdateSession};
use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde::Deserialize;
use std::process::Stdio;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc};

const XKEEN_BIN: &str = "/opt/sbin/xkeen";
const MAX_CUSTOM_COMMAND_LENGTH: usize = 2048;
const MAX_CUSTOM_ARGUMENTS: usize = 64;

static COMMAND_STDIN: LazyLock<Mutex<Option<tokio::process::ChildStdin>>> = LazyLock::new(|| Mutex::new(None));
static COMMAND_NUMERIC_INPUT: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    command: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandInputRequest {
    input: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandControlRequest {
    action: String,
}

pub async fn post_input(Json(req): Json<CommandInputRequest>) -> impl IntoResponse {
    let input = req.input.trim();
    if input.is_empty() || input.len() > 1024 || input.chars().any(|ch| matches!(ch, '\n' | '\r' | '\0')) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "success": false, "error": "Введите одну строку ответа (до 1024 байт)" })),
        );
    }
    if COMMAND_NUMERIC_INPUT.load(Ordering::Relaxed)
        && (input.len() != 1 || !input.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "success": false, "error": "Введите одну цифру" })),
        );
    }
    let mut stdin = COMMAND_STDIN.lock().await;
    let Some(stdin) = stdin.as_mut() else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "success": false, "error": "Команда сейчас не ожидает ввода" })),
        );
    };
    if let Err(error) = stdin.write_all(format!("{input}\n").as_bytes()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                serde_json::json!({ "success": false, "error": format!("Не удалось передать ответ команде: {error}") }),
            ),
        );
    }
    if let Err(error) = stdin.flush().await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(
                serde_json::json!({ "success": false, "error": format!("Не удалось передать ответ команде: {error}") }),
            ),
        );
    }
    (StatusCode::OK, Json(serde_json::json!({ "success": true })))
}

pub async fn post_command(State(state): State<AppState>, Json(req): Json<CommandRequest>) -> impl IntoResponse {
    if let Err(error) = parse_exec_command(&req.command) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "success": false, "error": error })),
        );
    }
    if !state.exec_session.try_begin() {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "success": false, "error": "Другая операция уже выполняется" })),
        );
    }
    tokio::spawn(run_command(state, req));
    (StatusCode::OK, Json(serde_json::json!({ "success": true })))
}

pub async fn post_control(State(state): State<AppState>, Json(req): Json<CommandControlRequest>) -> impl IntoResponse {
    if req.action != "cancel" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "success": false, "error": "Неизвестное действие" })),
        );
    }
    state.exec_session.cancel();
    (StatusCode::OK, Json(serde_json::json!({ "success": true })))
}

async fn run_command(state: AppState, req: CommandRequest) {
    let session = state.exec_session.clone();
    let result = run_command_inner(&req.command, &session).await;
    *COMMAND_STDIN.lock().await = None;
    COMMAND_NUMERIC_INPUT.store(false, Ordering::Relaxed);
    match result {
        Ok(()) => session.done(true, None),
        Err(error) => {
            session.log("error", format!("⨯ {error}"));
            session.done(false, Some(error));
        }
    }
    session.finish();
}

async fn run_command_inner(command: &str, session: &UpdateSession) -> Result<(), String> {
    let parsed = parse_exec_command(command)?;
    let args = parsed.into_iter().skip(1).collect::<Vec<_>>();
    let (label, stage, numeric_input) = command_info(&args);
    let display_args = std::iter::once("xkeen".to_owned())
        .chain(args.iter().map(|arg| quote_argument(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    session.stage(stage);
    session.log("info", format!("$ {display_args}"));
    let mut ctl = session.ctl_rx.clone();

    let mut child = Command::new(XKEEN_BIN)
        .args(&args)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Не удалось запустить {label}: {e}"))?;

    COMMAND_NUMERIC_INPUT.store(numeric_input, Ordering::Relaxed);
    let interactive = numeric_input || stage == "custom";
    if interactive {
        *COMMAND_STDIN.lock().await = child.stdin.take();
    } else {
        drop(child.stdin.take());
    }

    let stdout = child.stdout.take().ok_or("Не удалось открыть stdout процесса")?;
    let stderr = child.stderr.take().ok_or("Не удалось открыть stderr процесса")?;
    let (tx, mut rx) = mpsc::unbounded_channel::<(bool, String)>();
    let out_tx = tx.clone();
    let out_reader = tokio::spawn(async move {
        let mut reader = stdout;
        let mut buf = [0u8; 4096];
        while let Ok(size) = reader.read(&mut buf).await {
            if size == 0 {
                break;
            }
            if out_tx
                .send((false, String::from_utf8_lossy(&buf[..size]).into_owned()))
                .is_err()
            {
                break;
            }
        }
    });
    let err_reader = tokio::spawn(async move {
        let mut reader = stderr;
        let mut buf = [0u8; 4096];
        while let Ok(size) = reader.read(&mut buf).await {
            if size == 0 {
                break;
            }
            if tx
                .send((true, String::from_utf8_lossy(&buf[..size]).into_owned()))
                .is_err()
            {
                break;
            }
        }
    });

    let mut output_closed = false;
    let mut output_started = false;
    let mut first_output_chunk = true;
    let mut cancelled = session.cancelled();
    let mut force_killed = false;
    let force_kill_timeout = tokio::time::sleep(Duration::from_secs(0));
    tokio::pin!(force_kill_timeout);
    if cancelled {
        signal_command_group(&mut child, Signal::SIGTERM).await;
        force_kill_timeout
            .as_mut()
            .reset(tokio::time::Instant::now() + Duration::from_secs(3));
    }
    while !output_closed {
        tokio::select! {
            output = rx.recv() => match output {
                Some((is_stderr, mut chunk)) => {
                    if !chunk.is_empty() {
                        if first_output_chunk {
                            first_output_chunk = false;
                            if let Some(rest) = chunk.strip_prefix("\r\n") {
                                chunk = rest.to_owned();
                            } else if let Some(rest) = chunk.strip_prefix('\n') {
                                chunk = rest.to_owned();
                            }
                        }
                        if chunk.is_empty() {
                            continue;
                        }
                        if output_started {
                            session.log_append(if is_stderr { "warn" } else { "info" }, chunk);
                        } else {
                            session.log(if is_stderr { "warn" } else { "info" }, chunk);
                            output_started = true;
                        }
                    }
                }
                None => output_closed = true,
            },
            changed = ctl.changed(), if !cancelled => {
                if changed.is_ok() && session.cancelled() {
                    cancelled = true;
                    signal_command_group(&mut child, Signal::SIGTERM).await;
                    force_kill_timeout
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_secs(3));
                }
            },
            _ = &mut force_kill_timeout, if cancelled && !force_killed => {
                force_killed = true;
                signal_command_group(&mut child, Signal::SIGKILL).await;
            }
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|e| format!("Не удалось дождаться завершения {label}: {e}"))?;
    let _ = out_reader.await;
    let _ = err_reader.await;

    if cancelled {
        return Err("Операция прервана пользователем".into());
    }

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{label} завершилась с кодом {}",
            status
                .code()
                .map_or_else(|| "неизвестно".into(), |code| code.to_string())
        ))
    }
}

async fn signal_command_group(child: &mut tokio::process::Child, signal: Signal) {
    let signalled = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .is_some_and(|pid| kill(Pid::from_raw(-pid), signal).is_ok());
    if !signalled {
        let _ = child.kill().await;
    }
}

fn command_info(args: &[String]) -> (&'static str, &'static str, bool) {
    match args {
        [flag] if flag == "-status" => ("Статус XKeen", "status", false),
        [flag] if flag == "-v" => ("Версия XKeen", "status", false),
        [flag] if flag == "-diag" => ("Диагностика XKeen", "diagnostics", false),
        [flag] if flag == "-channel" => ("Канал обновлений XKeen", "update", true),
        [flag, auto] if flag == "-uk" && auto == "auto" => ("Обновление XKeen", "update", false),
        [flag] if flag == "-ug" => ("Обновление GeoFile и GeoIPSET", "update", false),
        _ => ("Своя команда", "custom", false),
    }
}

fn parse_exec_command(command: &str) -> Result<Vec<String>, String> {
    if command.len() > MAX_CUSTOM_COMMAND_LENGTH {
        return Err("Команда слишком длинная".into());
    }

    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut started = false;

    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            started = true;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            started = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                started = true;
            }
            c if c.is_whitespace() => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            _ => {
                current.push(ch);
                started = true;
            }
        }
        if args.len() > MAX_CUSTOM_ARGUMENTS {
            return Err("Слишком много аргументов в команде".into());
        }
    }

    if escaped {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("Проверьте парные кавычки в команде".into());
    }
    if started {
        args.push(current);
    }
    if args.first().map(String::as_str) != Some("xkeen") {
        return Err("Команда должна начинаться с xkeen".into());
    }
    if args.len() < 2 {
        return Err("После xkeen укажите команду или аргумент".into());
    }
    if args.len() > MAX_CUSTOM_ARGUMENTS {
        return Err("Слишком много аргументов в команде".into());
    }
    Ok(args)
}

fn quote_argument(arg: &str) -> String {
    if arg.chars().any(char::is_whitespace) {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_owned()
    }
}
