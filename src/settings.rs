use axum::{extract::State, response::{IntoResponse, Json}};
use crate::types::*;
use std::fs;

pub async fn get_settings(State(state): State<AppState>) -> impl IntoResponse {
    let s = state.settings.read().unwrap();
    Json(serde_json::json!({
        "success": true,
        "gui": s.gui,
        "updater": s.updater,
        "log": s.log
    }))
}

pub async fn post_settings(State(state): State<AppState>, Json(mut req): Json<AppSettings>) -> impl IntoResponse {
    if req.log.timezone < -12 || req.log.timezone > 14 {
        return Json(serde_json::json!({"success": false, "error": "Неверный часовой пояс"}));
    }
    req.normalize_proxies();
    {
        let mut s = state.settings.write().unwrap();
        *s = req.clone();
    }
    match fs::write(APP_CONFIG, serde_json::to_string_pretty(&req).unwrap()) {
        Ok(_) => Json(serde_json::json!({"success": true})),
        Err(e) => Json(serde_json::json!({"success": false, "error": e.to_string()})),
    }
}