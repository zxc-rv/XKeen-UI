mod api_relay;
mod auth;
mod backuper;
mod configs;
mod controller;
mod frontend_embedder;
mod geo;
mod logger;
mod ruleset_inspector;
mod settings;
mod types;
mod updater;
mod version;
mod websocket;
use crate::logger::{log, ts};
use crate::types::*;
use axum::routing::{any, get, post};
use axum::{Router, middleware};

use clap::builder::styling::{AnsiColor, Styles};
use clap::{FromArgMatches, Parser, Subcommand};
use colored::Colorize;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::exit;
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

const STYLES: Styles = Styles::styled()
    .header(AnsiColor::Yellow.on_default().bold())
    .usage(AnsiColor::Yellow.on_default().bold())
    .literal(AnsiColor::Cyan.on_default().bold())
    .placeholder(AnsiColor::Cyan.on_default());

#[derive(Parser)]
#[command(name = "xkeen-ui", before_help = "", about = "Веб-панель управления сервисом XKeen", disable_version_flag = true, disable_help_subcommand = true, styles = STYLES)]
struct Cli {
    #[arg(
        short = 'p',
        long = "port",
        default_value = "1000",
        help = "Запуск сервиса с указанием порта"
    )]
    port: String,

    #[arg(short = 'd', long = "debug", help = "Режим отладки")]
    debug: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Создать init скрипт
    CreateInit,
    /// Запустить сервис (трeбуется init скрипт)
    Start,
    /// Остановить сервис (трeбуется init скрипт)
    Stop,
    /// Перезапустить сервис (трeбуется init скрипт)
    Restart,
    /// Статус сервиса (трeбуется init скрипт)
    Status,
    /// Сбросить пароль и перезапустить сервис (трeбуется init скрипт)
    ResetPassword,
    /// Запустить установочный скрипт
    Setup,
}

const XKEEN_UI_INIT_CONTENT: &str = r#"#!/bin/sh

ENABLED=yes
PROCS=xkeen-ui
ARGS="-p 1000"
PREARGS=""
DESC="$PROCS"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
"#;

const XKEEN_UI_LOG_C: &[u8] = b"/opt/var/log/xkeen-ui.log\0";

fn create_init() -> std::io::Result<()> {
    if let Some(dir) = Path::new(S99XKEEN_UI).parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(S99XKEEN_UI, XKEEN_UI_INIT_CONTENT)?;
    std::fs::set_permissions(S99XKEEN_UI, std::fs::Permissions::from_mode(0o755))
}

fn exec_init(cmd: &str) -> ! {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(S99XKEEN_UI).arg(cmd).exec();
    eprintln!("{} {}", " Ошибка выполнения команды:".red().bold(), err);
    exit(1);
}

fn open_process_log() -> io::Result<std::fs::File> {
    if let Some(dir) = Path::new(XKEEN_UI_LOG).parent() {
        std::fs::create_dir_all(dir)?;
    }
    OpenOptions::new().create(true).append(true).open(XKEEN_UI_LOG)
}

fn setup_process_logging() {
    if let Err(e) = open_process_log() {
        eprintln!("{} {}: {}", " Не удалось открыть лог".red().bold(), XKEEN_UI_LOG, e);
    }

    install_panic_logger();
    install_crash_signal_handlers();

    if !stdio_is_interactive() {
        if let Err(e) = redirect_stderr_to_process_log() {
            eprintln!(
                "{} {}: {}",
                " Не удалось перенаправить stderr в".red().bold(),
                XKEEN_UI_LOG,
                e
            );
        }
    }
}

fn stdio_is_interactive() -> bool {
    unsafe { nix::libc::isatty(nix::libc::STDOUT_FILENO) == 1 || nix::libc::isatty(nix::libc::STDERR_FILENO) == 1 }
}

fn redirect_stderr_to_process_log() -> io::Result<()> {
    let file = open_process_log()?;
    nix::unistd::dup2_stderr(&file).map_err(io::Error::from)?;
    Ok(())
}

fn write_process_log(level: &str, msg: &str) {
    if let Ok(mut file) = open_process_log() {
        let _ = writeln!(file, "{} [{}] {}", ts(), level, msg);
    }
}

fn report_process_error(msg: &str) -> ! {
    eprintln!("{} [ERROR] {}", ts(), msg);
    if stdio_is_interactive() {
        write_process_log("ERROR", msg);
    }
    exit(1);
}

fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("<non-string panic payload>");
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "unknown".into());
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("unnamed");
        if let Ok(mut file) = open_process_log() {
            let _ = writeln!(
                file,
                "{} [PANIC] thread={} location={} payload={}",
                ts(),
                thread_name,
                location,
                payload
            );
            let backtrace = std::backtrace::Backtrace::capture();
            if matches!(backtrace.status(), std::backtrace::BacktraceStatus::Captured) {
                let _ = writeln!(file, "Backtrace:\n{}", backtrace);
            }
        }

        default_hook(info);
    }));
}

fn install_crash_signal_handlers() {
    use nix::sys::signal::{SaFlags, SigAction, SigHandler, SigSet, Signal, sigaction};

    let action = SigAction::new(
        SigHandler::Handler(fatal_signal_handler),
        SaFlags::SA_RESETHAND,
        SigSet::empty(),
    );

    for signal in [
        Signal::SIGABRT,
        Signal::SIGBUS,
        Signal::SIGFPE,
        Signal::SIGILL,
        Signal::SIGSEGV,
        Signal::SIGTERM,
    ] {
        unsafe {
            let _ = sigaction(signal, &action);
        }
    }
}

extern "C" fn fatal_signal_handler(sig: i32) {
    let msg = fatal_signal_message(sig);
    unsafe {
        let fd = nix::libc::open(
            XKEEN_UI_LOG_C.as_ptr().cast(),
            nix::libc::O_WRONLY | nix::libc::O_CREAT | nix::libc::O_APPEND,
            0o644,
        );
        if fd >= 0 {
            let _ = nix::libc::write(fd, msg.as_ptr().cast(), msg.len());
            let _ = nix::libc::close(fd);
        }
        let _ = nix::libc::kill(nix::libc::getpid(), sig);
    }
}

fn fatal_signal_message(sig: i32) -> &'static [u8] {
    match sig {
        x if x == nix::libc::SIGABRT => b"[FATAL] received SIGABRT\n",
        x if x == nix::libc::SIGBUS => b"[FATAL] received SIGBUS\n",
        x if x == nix::libc::SIGFPE => b"[FATAL] received SIGFPE\n",
        x if x == nix::libc::SIGILL => b"[FATAL] received SIGILL\n",
        x if x == nix::libc::SIGSEGV => b"[FATAL] received SIGSEGV\n",
        x if x == nix::libc::SIGTERM => b"[FATAL] received SIGTERM\n",
        _ => b"[FATAL] received fatal signal\n",
    }
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "-v" || arg == "-V" || arg == "--version") {
        let router_info = std::process::Command::new("curl")
            .args(["-sf", "http://127.0.0.1:79/rci/show/version"])
            .output()
            .ok()
            .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok());

        let device = router_info
            .as_ref()
            .and_then(|i| i["description"].as_str())
            .unwrap_or("");
        let os = router_info.as_ref().and_then(|i| i["title"].as_str()).unwrap_or("");

        println!("  {}", format!("XKeen UI {}", VERSION).cyan().bold());
        println!("  {} {}", "Target:".cyan().bold(), env!("BUILD_TARGET"));
        if !device.is_empty() {
            println!("  {} {}", "Device:".cyan().bold(), device);
        }
        if !os.is_empty() {
            println!("  {} {}", "Keenetic OS:".cyan().bold(), os);
        }
        exit(0);
    }

    let version: &'static str = Box::leak(format!("{} ({})", VERSION, get_arch()).into_boxed_str());
    let mut command = <Cli as clap::CommandFactory>::command().version(version);

    if std::env::args().any(|arg| arg == "-h" || arg == "--help") {
        command.print_help().unwrap();
        println!();
        exit(0);
    }
    let matches = command.get_matches();
    let cli = Cli::from_arg_matches(&matches).unwrap_or_else(|e| e.exit());

    if let Some(command) = cli.command {
        match command {
            Command::Setup => {
                use std::os::unix::process::CommandExt;
                let err = std::process::Command::new("sh")
                    .args([
                        "-c",
                        "curl -L https://raw.githubusercontent.com/zxc-rv/XKeen-UI/main/setup.sh | sh",
                    ])
                    .exec();
                eprintln!(" {} {}", " Ошибка запуска setup:".red().bold(), err);
                exit(1);
            }
            Command::Start | Command::Stop | Command::Restart | Command::Status => {
                if !Path::new(S99XKEEN_UI).exists() {
                    eprintln!(
                        "\n{} отсутствует init скрипт\n Создайте скрипт командой: {}\n",
                        " Ошибка:".red().bold(),
                        "xkeen-ui create-init".green().bold()
                    );
                    exit(1);
                }
                let cmd = match command {
                    Command::Start => "start",
                    Command::Stop => "stop",
                    Command::Restart => "restart",
                    Command::Status => "status",
                    _ => unreachable!(),
                };
                exec_init(cmd);
            }
            Command::CreateInit => {
                if let Err(e) = create_init() {
                    eprintln!("{} {}: {}", " Не удалось создать".red().bold(), S99XKEEN_UI, e);
                    exit(1);
                }
                println!("\n{} создан {}\n", " Успех:".green().bold(), S99XKEEN_UI);
                exit(0);
            }
            Command::ResetPassword => {
                let content = std::fs::read_to_string(APP_CONFIG).unwrap_or_default();
                let mut json: serde_json::Value =
                    serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

                if !json.is_object() {
                    json = serde_json::json!({});
                }

                let auth = json
                    .as_object_mut()
                    .unwrap()
                    .entry("auth")
                    .or_insert_with(|| serde_json::json!({}));
                if !auth.is_object() {
                    *auth = serde_json::json!({});
                }

                let auth_obj = auth.as_object_mut().unwrap();
                auth_obj.remove("password_hash");
                auth_obj.insert("session_ids".into(), serde_json::json!([]));

                std::fs::write(APP_CONFIG, serde_json::to_string_pretty(&json).unwrap()).unwrap();

                if !Path::new(S99XKEEN_UI).exists() {
                    eprintln!(
                        "\n{} отсутствует init скрипт\n Создайте скрипт командой: {}\n",
                        " Ошибка:".red().bold(),
                        "xkeen-ui create-init".green().bold()
                    );
                    exit(1);
                }
                let current_pid = std::process::id() as i32;
                if controller::get_pid("xkeen-ui")
                    .into_iter()
                    .any(|pid| pid != current_pid)
                {
                    println!("\n{} пароль сброшен\n", " Успех:".green().bold());
                    exec_init("restart");
                }
                println!("\n{} пароль сброшен\n", " Успех:".green().bold());
                exit(0);
            }
        }
    }

    setup_process_logging();
    println!("XKeen UI {} ({})", VERSION, get_arch());

    refresh_xray_log_paths();
    let error_log = error_log_path();
    let access_log = access_log_path();

    for path in [&error_log, &access_log] {
        if let Some(p) = Path::new(path).parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(path);
    }

    println!(
        "{} [INFO] Defined xray logs: access={}, error={}",
        ts(),
        access_log,
        error_log
    );

    let init_file = tokio::task::spawn_blocking(|| controller::find_init_file(true))
        .await
        .unwrap()
        .or_else(|| {
            log("ERROR", "Не удалось найти файл инициализации XKeen".into());
            None
        });

    let geo_cache = Arc::new(RwLock::new(std::collections::HashMap::new()));
    let gc_clone = geo_cache.clone();
    tokio::task::spawn_blocking(move || {
        let _ = crate::geo::list_geo_files(gc_clone);
    });

    let (log_tx, _) = broadcast::channel::<String>(16);
    let log_tx_arc = Arc::new(log_tx);

    let state = AppState {
        core: Arc::new(RwLock::new(detect_core(init_file.as_deref()))),
        settings: Arc::new(RwLock::new(load_settings())),
        init_file: Arc::new(RwLock::new(init_file)),
        http_client: reqwest::Client::builder()
            .user_agent("XKeen-UI")
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap(),
        update_checker: UpdateChecker::default(),
        geo_cache,
        log_tx: log_tx_arc,
        log_watcher: Arc::new(tokio::sync::Mutex::new(None)),
        app_config_lock: Arc::new(tokio::sync::Mutex::new(())),
        service_op_lock: Arc::new(tokio::sync::Mutex::new(())),
        debug: cli.debug,
    };
    version::start_update_checker(state.clone());

    let secure_api = Router::new()
        .route(
            "/api/control",
            get(controller::get_control).post(controller::post_control),
        )
        .route(
            "/api/configs",
            get(configs::get_configs)
                .put(configs::put_config)
                .post(configs::post_config)
                .delete(configs::delete_config)
                .patch(configs::patch_config),
        )
        .route(
            "/api/backup",
            get(backuper::get_backups)
                .put(backuper::put_backup)
                .post(backuper::post_backup)
                .delete(backuper::delete_backup),
        )
        .route(
            "/api/settings",
            get(settings::get_settings).patch(settings::patch_settings),
        )
        .route("/api/version", get(version::version_handler))
        .route("/api/ruleset", get(ruleset_inspector::get_ruleset_content))
        .route("/api/device-list", get(api_relay::get_device_list))
        .route("/api/update", post(updater::post_update))
        .route("/api/geo", get(geo::get_geo))
        .route("/api/geo/site", get(geo::get_geosite))
        .route("/api/geo/ip", get(geo::get_geoip))
        .route("/api/auth/logout", post(auth::post_logout))
        .route("/api/auth/reset", post(auth::post_auth_reset))
        .route("/clash/{*path}", any(api_relay::proxy_http))
        .route("/clash-ws/{*path}", get(api_relay::proxy_ws))
        .route("/ws", get(websocket::ws_handler))
        .route_layer(middleware::from_fn({
            let state = state.clone();
            move |req, next| {
                let state = state.clone();
                async move { auth::auth_middleware(state, req, next).await }
            }
        }));

    let unsecure_api = Router::new()
        .route("/api/auth/setup", post(auth::post_setup))
        .route("/api/auth/login", get(auth::get_login_info).post(auth::post_login));

    let app = Router::new()
        .merge(secure_api)
        .merge(unsecure_api)
        .fallback(frontend_embedder::serve)
        .layer(CorsLayer::permissive())
        .with_state(state);
    let addr: SocketAddr = format!("0.0.0.0:{}", cli.port)
        .parse()
        .unwrap_or_else(|e| report_process_error(&format!("Error listening on 0.0.0.0:{}: {}", cli.port, e)));
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| report_process_error(&format!("Error listening on {}: {}", addr, e)));
    println!("{} [INFO] Listening on {}", ts(), addr);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .unwrap_or_else(|e| report_process_error(&format!("HTTP server error: {}", e)));
}

fn get_arch() -> String {
    let arch = if std::env::consts::ARCH == "mips" && cfg!(target_endian = "little") {
        "mipsle"
    } else {
        std::env::consts::ARCH
    };
    let libc = if cfg!(target_env = "musl") { "musl" } else { "gnu" };
    format!("{}/{}", arch, libc)
}

fn detect_core(init_file: Option<&str>) -> CoreInfo {
    let content = init_file
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    if content.contains("name_client=\"mihomo\"") {
        CoreInfo {
            name: "mihomo".into(),
            conf_dir: MIHOMO_CONF.into(),
            is_json: false,
        }
    } else {
        CoreInfo {
            name: "xray".into(),
            conf_dir: XRAY_CONF.into(),
            is_json: true,
        }
    }
}

fn load_settings() -> AppSettings {
    let (content, path) = match std::fs::read_to_string(APP_CONFIG) {
        Ok(c) => (c, APP_CONFIG),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Ok(c) = std::fs::read_to_string(APP_CONFIG_LEGACY) {
                if let Err(e) = std::fs::create_dir_all(XKEEN_CONF) {
                    log("WARN", format!("Не удалось создать {}: {}", XKEEN_CONF, e));
                }
                if std::fs::rename(APP_CONFIG_LEGACY, APP_CONFIG).is_ok() {
                    log(
                        "INFO",
                        format!("Успешная миграция конфига: {} -> {}", APP_CONFIG_LEGACY, APP_CONFIG),
                    );
                } else {
                    log("WARN", "Не удалось выполнить миграцию конфига".into());
                }
                (c, APP_CONFIG_LEGACY)
            } else {
                return AppSettings::default();
            }
        }
        Err(e) => {
            log("ERROR", format!("Ошибка чтения {}: {}", APP_CONFIG, e));
            return AppSettings::default();
        }
    };

    match serde_json::from_str::<AppSettings>(&content) {
        Ok(mut s) => {
            s.normalize_proxies();
            s
        }
        Err(e) => {
            log("ERROR", format!("Ошибка парсинга {}: {}", path, e));
            AppSettings::default()
        }
    }
}
