mod types; mod settings; mod logger; mod controller; mod configs; mod version; mod websocket; mod updater; mod geo; mod clash; mod auth;
use std::{env, sync::{Arc, RwLock}, net::SocketAddr, process::exit, path::Path};
use axum::{Router, middleware, response::Response, routing::{get, get_service, any, post}};
use axum::http::{header::CACHE_CONTROL, HeaderValue};
use tower_http::{cors::CorsLayer, services::{ServeDir, ServeFile}, set_header::SetResponseHeaderLayer};
use crate::types::*;
use crate::logger::{log, ts};
use tokio::sync::broadcast;

#[tokio::main]
async fn main() {
    let (mut port, mut debug) = ("1000".to_string(), false);
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-p" => if let Some(p) = args.next() { port = p },
            "-d" => debug = true,
            "-v" | "-V" => { println!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, get_arch()); exit(0); }
            "--reset-password" => {
                let content = std::fs::read_to_string(APP_CONFIG).unwrap_or_default();
                let mut json: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
                if let Some(auth) = json["auth"].as_object_mut() {
                    auth.remove("password_hash");
                    auth.remove("session_ids");
                }
                std::fs::write(APP_CONFIG, serde_json::to_string_pretty(&json).unwrap()).unwrap();
                println!("Пароль сброшен, установить новый можно при открытии панели");
                exit(0);
            }
            _ => {}
        }
    }
    println!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, get_arch());

    if let Some(p) = Path::new(ERROR_LOG).parent() { let _ = std::fs::create_dir_all(p); }
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG);

    let init_file: Option<String> = tokio::task::spawn_blocking(|| controller::find_init_file(true)).await.unwrap()
        .or_else(|| {
            log("ERROR", format!("Не удалось найти файл инициализации XKeen"));
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
        http_client: reqwest::Client::builder().user_agent("XKeen-UI").connect_timeout(std::time::Duration::from_secs(5)).timeout(std::time::Duration::from_secs(120)).build().unwrap(),
        update_checker: UpdateChecker::default(),
        geo_cache,
        log_tx: log_tx_arc,
        log_watcher: Arc::new(tokio::sync::Mutex::new(None)),
        debug,
    };
    version::start_update_checker(state.clone());

    let no_cache = SetResponseHeaderLayer::overriding(CACHE_CONTROL, HeaderValue::from_static("no-store"));

    let protected = Router::new()
        .route("/api/control", get(controller::get_control).post(controller::post_control))
        .route("/api/configs", get(configs::get_configs).put(configs::put_config).post(configs::post_config).delete(configs::delete_config).patch(configs::patch_config))
        .route("/api/settings", get(settings::get_settings).patch(settings::patch_settings))
        .route("/api/version", get(version::version_handler))
        .route("/api/update", post(updater::post_update))
        .route("/api/geo", get(geo::get_geo))
        .route("/api/geo/site", get(geo::get_geosite))
        .route("/api/geo/ip", get(geo::get_geoip))
        .route("/api/auth/logout", post(auth::post_logout))
        .route("/api/auth/reset", post(auth::post_auth_reset))
        .route("/clash/{*path}", any(clash::proxy_http))
        .route("/clash-ws/{*path}", get(clash::proxy_ws))
        .route("/ws", get(websocket::ws_handler))
        .route_layer(middleware::from_fn({
            let state = state.clone();
            move |req: axum::extract::Request, next: middleware::Next| {
                let state = state.clone();
                async move { auth::auth_middleware(state, req, next).await }
            }
        }));

    let public_api = Router::new()
        .route("/api/auth/setup", post(auth::post_setup))
        .route("/api/auth/login", get(auth::get_login_info).post(auth::post_login));

    let app = Router::new()
        .merge(protected)
        .merge(public_api)
        .route("/", get_service(ServeFile::new(format!("{}/index.html", STATIC_DIR))).layer(no_cache))
        .fallback_service(get_service(ServeDir::new(STATIC_DIR)).layer(SetResponseHeaderLayer::overriding(
            CACHE_CONTROL,
            |res: &Response| {
                res.status().is_success().then_some(
                    HeaderValue::from_static("public, max-age=31536000, immutable")
                )
            }
        )))
        .layer(CorsLayer::permissive()).with_state(state);

    let addr: SocketAddr = format!("0.0.0.0:{}", port).parse().unwrap();
    println!("{} [INFO] Listening on http://{}", ts(), addr);
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}

fn get_arch() -> &'static str {
    if std::env::consts::ARCH == "mips" && cfg!(target_endian = "little") { "mipsle" } else { std::env::consts::ARCH }
}

fn detect_core(init_file: Option<&str>) -> CoreInfo {
    let content = init_file.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    if content.contains("name_client=\"mihomo\"") {
        CoreInfo { name: "mihomo".into(), conf_dir: MIHOMO_CONF.into(), is_json: false }
    } else {
        CoreInfo { name: "xray".into(), conf_dir: XRAY_CONF.into(), is_json: true }
    }
}

fn load_settings() -> AppSettings {
    match std::fs::read_to_string(APP_CONFIG) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            log("WARN", format!("Файл {} не найден, используются значения по умолчанию", APP_CONFIG));
            AppSettings::default()
        }
        Err(e) => {
            log("ERROR", format!("Ошибка чтения {}: {}", APP_CONFIG, e));
            AppSettings::default()
        }
        Ok(content) => match serde_json::from_str::<AppSettings>(&content) {
            Err(e) => {
                log("ERROR", format!("Ошибка чтения {}: {}", APP_CONFIG, e));
                AppSettings::default()
            }
            Ok(mut s) => { s.normalize_proxies(); s }
        }
    }
}