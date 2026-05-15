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
use std::env;
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Stdio, exit};
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

fn run_ui_script(cmd: &str) {
    let _ = std::process::Command::new(S99XKEEN_UI)
        .arg(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[tokio::main]
async fn main() {
    let (mut port, mut debug) = ("1000".to_string(), false);
    let mut args = env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-p" => {
                if let Some(p) = args.next() {
                    port = p
                }
            }
            "-d" => debug = true,
            "-v" | "-V" => {
                println!("XKeen UI {} ({})", VERSION, get_arch());
                exit(0);
            }
            "--restart" | "--start" | "--stop" => {
                run_ui_script(arg.trim_start_matches("--"));
                exit(0);
            }
            "--reset-password" => {
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

                let current_pid = std::process::id() as i32;
                if controller::get_pid("xkeen-ui")
                    .into_iter()
                    .any(|pid| pid != current_pid)
                    && Path::new(S99XKEEN_UI).exists()
                {
                    run_ui_script("restart");
                }
                println!("Пароль сброшен, установить новый можно при открытии панели");
                exit(0);
            }
            _ => {}
        }
    }
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
        debug,
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

    let addr: SocketAddr = format!("0.0.0.0:{}", port).parse().unwrap();
    println!("{} [INFO] Listening on http://{}", ts(), addr);
    axum::serve(
        tokio::net::TcpListener::bind(&addr).await.unwrap(),
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .unwrap();
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
