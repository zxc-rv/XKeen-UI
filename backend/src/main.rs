mod types;
mod settings;
mod logs;
mod controller;
mod configs;
mod version;
mod websocket;
mod updater;

use std::{env, fs, path::Path, sync::{Arc, RwLock}};
use axum::{Router, routing::get};
use axum::http::{header::CACHE_CONTROL, HeaderValue};
use tower_http::{cors::CorsLayer, services::{ServeDir, ServeFile}, set_header::SetResponseHeaderLayer};
use crate::types::*;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    let mut port = "1000".to_string();
    let mut _debug = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-p" => {
                if i + 1 < args.len() {
                    port = args[i+1].clone();
                    i += 1;
                }
            }
            "-d" => _debug = true,
            "-v" | "-V" => {
                println!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, get_arch());
                std::process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }

    let info = format!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, get_arch());
    println!("{}", info);
    if _debug { println!("Debug mode enabled"); }

    let init_file = if Path::new(S99XKEEN).exists() { S99XKEEN.to_string() } else { S24XRAY.to_string() };
    let http_client = reqwest::Client::builder().user_agent("XKeen-UI").timeout(std::time::Duration::from_secs(120)).build().unwrap();
    let state = AppState {
        core: Arc::new(RwLock::new(detect_core(&init_file))),
        settings: Arc::new(RwLock::new(load_settings())),
        init_file: Arc::new(RwLock::new(init_file)),
        http_client,
        _debug,
    };

    let serve_no_cache = |file: &str| {
        axum::routing::get_service(ServeFile::new(format!("{}/{}", STATIC_DIR, file)))
            .layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            ))
    };

    let serve_assets = axum::routing::get_service(ServeDir::new(STATIC_DIR))
        .layer(SetResponseHeaderLayer::if_not_present(
            CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        ));

    let app = Router::new()
        .route("/api/control", get(controller::get_control).post(controller::post_control))
        .route("/api/configs", get(configs::get_configs).post(configs::post_configs))
        .route("/api/settings", get(settings::get_settings).post(settings::post_settings))
        .route("/api/version", get(version::version_handler))
        .route("/api/update", get(updater::get_releases).post(updater::post_update))
        .route("/ws", get(websocket::ws_handler))
        .route("/", serve_no_cache("index.html"))
        .route("/local_mode.js", serve_no_cache("local_mode.js"))
        .fallback_service(serve_assets)
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    println!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn get_arch() -> &'static str {
    let arch = std::env::consts::ARCH;
    if arch == "mips" && cfg!(target_endian = "little") { "mipsle" } else { arch }
}

fn detect_core(init_file: &str) -> CoreInfo {
    let content = fs::read_to_string(init_file).unwrap_or_default();
    if content.contains("name_client=\"mihomo\"") {
        CoreInfo { name: "mihomo".into(), conf_dir: MIHOMO_CONF.into(), is_json: false }
    } else {
        CoreInfo { name: "xray".into(), conf_dir: XRAY_CONF.into(), is_json: true }
    }
}

fn load_settings() -> AppSettings {
    let config_path = Path::new(APP_CONFIG);

    if !config_path.exists() {
        let default_settings = AppSettings::default();
        if let Ok(json) = serde_json::to_string_pretty(&default_settings) {
            if let Some(parent) = config_path.parent() {
                _ = fs::create_dir_all(parent);
            }
            _ = fs::write(config_path, json);
        }
        return default_settings;
    }

    let content = match fs::read_to_string(APP_CONFIG) {
        Ok(c) => c,
        Err(_) => return AppSettings::default(),
    };

    let mut settings: AppSettings = serde_json::from_str(&content).unwrap_or_else(|_| AppSettings::default());
    settings.normalize_proxies();
    settings
}