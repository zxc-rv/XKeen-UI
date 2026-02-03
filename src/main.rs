mod types;
mod settings;
mod logs;
mod control;
mod configs;
mod version;
mod websocket;
mod updater;

use axum::{routing::get, Router};
use std::{env, fs, path::Path, sync::{Arc, RwLock}};
use tower_http::{cors::CorsLayer, services::ServeDir};
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
                println!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, std::env::consts::ARCH);
                std::process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }

    let info = format!("XKeen UI {} ({}/{})", VERSION, std::env::consts::OS, std::env::consts::ARCH);
    println!("{}", info);
    if _debug { println!("Debug mode enabled"); }

    let init_file = if Path::new(S24XRAY).exists() { S24XRAY.to_string() } else { S99XKEEN.to_string() };

    let state = AppState {
        core: Arc::new(RwLock::new(detect_core(&init_file))),
        settings: Arc::new(RwLock::new(load_settings())),
        init_file: Arc::new(RwLock::new(init_file)),
        _debug,
    };

    let app = Router::new()
        .route("/api/control", get(control::get_control).post(control::post_control))
        .route("/api/configs", get(configs::get_configs).post(configs::post_configs))
        .route("/api/settings", get(settings::get_settings).post(settings::post_settings))
        .route("/api/version", get(version::version_handler))
        .route("/api/update", get(updater::get_releases).post(updater::post_update))
        .route("/ws", get(websocket::ws_handler))
        .fallback_service(ServeDir::new("/opt/share/www/XKeen-UI"))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    println!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
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
    fs::read_to_string(APP_CONFIG)
        .ok().and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(AppSettings { timezone_offset: 3 })
}