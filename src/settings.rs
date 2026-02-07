use axum::{extract::State, response::{IntoResponse, Json}};
use crate::types::*;
use std::fs;

pub async fn get_settings(State(state): State<AppState>) -> impl IntoResponse {
    let settings = state.settings.read().unwrap();
    Json(serde_json::json!({
        "success": true,
        "timezone": settings.timezone,
        "github_proxy": settings.github_proxy,
        "auto_apply": settings.auto_apply,
        "backup_core": settings.backup_core
    }))
}

pub async fn post_settings(State(state): State<AppState>, Json(mut req): Json<AppSettings>) -> impl IntoResponse {
    if req.timezone < -12 || req.timezone > 14 {
        return Json(serde_json::json!({
            "success": false,
            "error": "Часовой пояс должен быть от -12 до +14"
        }));
    }

    req.normalize_proxies();

    {
        let mut s = state.settings.write().unwrap();
        s.timezone = req.timezone;
        s.github_proxy = req.github_proxy.clone();
        s.auto_apply = req.auto_apply;
        s.backup_core = req.backup_core;
    }

    if let Err(e) = fs::write(APP_CONFIG, serde_json::to_string_pretty(&req).unwrap()) {
        return Json(serde_json::json!({
            "success": false,
            "error": format!("Ошибка сохранения настроек: {}", e)
        }));
    }

    Json(serde_json::json!({
        "success": true,
        "timezone": req.timezone,
        "github_proxy": req.github_proxy,
        "auto_apply": req.auto_apply,
        "backup_core": req.backup_core
    }))
}