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

pub async fn post_settings(State(state): State<AppState>, Json(patch): Json<serde_json::Value>) -> impl IntoResponse {
    let mut settings = {
        let s = state.settings.read().unwrap();
        s.clone()
    };

    if let Some(gui) = patch.get("gui") {
        if let Some(v) = gui.get("auto_apply") { if let Some(b) = v.as_bool() { settings.gui.auto_apply = b; }}
        if let Some(v) = gui.get("routing") { if let Some(b) = v.as_bool() { settings.gui.routing = b; }}
        if let Some(v) = gui.get("log") { if let Some(b) = v.as_bool() { settings.gui.log = b; }}
    }

    if let Some(upd) = patch.get("updater") {
        if let Some(v) = upd.get("auto_check_ui") { if let Some(b) = v.as_bool() { settings.updater.auto_check_ui = b; }}
        if let Some(v) = upd.get("auto_check_core") { if let Some(b) = v.as_bool() { settings.updater.auto_check_core = b; }}
        if let Some(v) = upd.get("backup_core") { if let Some(b) = v.as_bool() { settings.updater.backup_core = b; }}
        if let Some(v) = upd.get("github_proxy") {
            if let Some(arr) = v.as_array() {
                settings.updater.github_proxy = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
            }
        }
    }

    if let Some(log) = patch.get("log") {
        if let Some(v) = log.get("timezone") {
            if let Some(tz) = v.as_i64() {
                if tz < -12 || tz > 14 {
                    return Json(serde_json::json!({"success": false, "error": "Неверный часовой пояс"}));
                }
                settings.log.timezone = tz as i32;
            }
        }
    }

    settings.normalize_proxies();
    {
        let mut s = state.settings.write().unwrap();
        *s = settings.clone();
    }

    match fs::write(APP_CONFIG, serde_json::to_string_pretty(&settings).unwrap()) {
        Ok(_) => Json(serde_json::json!({"success": true})),
        Err(e) => Json(serde_json::json!({"success": false, "error": e.to_string()})),
    }
}