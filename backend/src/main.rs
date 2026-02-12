mod types; mod settings; mod logs; mod controller; mod configs; mod version; mod websocket; mod updater;
use std::{env, path::Path, sync::{Arc, RwLock}, net::SocketAddr, process::exit};
use axum::{Router, routing::{get, get_service}};
use axum::http::{header::CACHE_CONTROL, HeaderValue};
use tower_http::{cors::CorsLayer, services::{ServeDir, ServeFile}, set_header::SetResponseHeaderLayer};
use crate::types::*;

#[tokio::main]
async fn main() {
    let (mut port, mut _debug) = ("1000".to_string(), false);
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-p" => if let Some(p) = args.next() { port = p },
            "-d" => _debug = true,
            "-v" | "-V" => { println!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, get_arch()); exit(0); }
            _ => {}
        }
    }
    println!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, get_arch());

    let init_file = if Path::new(S99XKEEN).exists() { S99XKEEN } else { S24XRAY }.to_string();
    let state = AppState {
        core: Arc::new(RwLock::new(detect_core(&init_file))),
        settings: Arc::new(RwLock::new(load_settings())),
        init_file: Arc::new(RwLock::new(init_file)),
        http_client: reqwest::Client::builder().user_agent("XKeen-UI").timeout(std::time::Duration::from_secs(120)).build().unwrap(),
        update_checker: UpdateChecker::default(),
        _debug,
    };
    version::start_update_checker(state.clone());

    let cache = SetResponseHeaderLayer::overriding(CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    let no_cache = SetResponseHeaderLayer::overriding(CACHE_CONTROL, HeaderValue::from_static("no-store"));

    let app = Router::new()
        .route("/api/control", get(controller::get_control).post(controller::post_control))
        .route("/api/configs", get(configs::get_configs).post(configs::post_configs))
        .route("/api/settings", get(settings::get_settings).post(settings::post_settings))
        .route("/api/version", get(version::version_handler))
        .route("/api/update", get(updater::get_releases).post(updater::post_update))
        .route("/ws", get(websocket::ws_handler))
        .route("/", get_service(ServeFile::new(format!("{}/index.html", STATIC_DIR))).layer(no_cache.clone()))
        .route("/local_mode.js", get_service(ServeFile::new(format!("{}/local_mode.js", STATIC_DIR))).layer(no_cache))
        .fallback_service(get_service(ServeDir::new(STATIC_DIR)).layer(cache))
        .layer(CorsLayer::permissive()).with_state(state);

    let addr: SocketAddr = format!("0.0.0.0:{}", port).parse().unwrap();
    println!("Listening on http://{}", addr);
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app).await.unwrap();
}

fn get_arch() -> &'static str {
    if std::env::consts::ARCH == "mips" && cfg!(target_endian = "little") { "mipsle" } else { std::env::consts::ARCH }
}

fn detect_core(init_file: &str) -> CoreInfo {
    if std::fs::read_to_string(init_file).unwrap_or_default().contains("name_client=\"mihomo\"") {
        CoreInfo { name: "mihomo".into(), conf_dir: MIHOMO_CONF.into(), is_json: false }
    } else {
        CoreInfo { name: "xray".into(), conf_dir: XRAY_CONF.into(), is_json: true }
    }
}

fn load_settings() -> AppSettings {
    let mut s: AppSettings = std::fs::read_to_string(APP_CONFIG).ok().and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
    s.normalize_proxies(); s
}