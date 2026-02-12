use axum::{extract::State, response::{IntoResponse, Json}};
use crate::types::*;
use std::fs;

pub async fn get_settings(State(state): State<AppState>) -> impl IntoResponse {
    let s = state.settings.read().unwrap();
    Json(serde_json::json!({ "success": true, "gui": s.gui, "updater": s.updater, "log": s.log }))
}

pub async fn post_settings(State(state): State<AppState>, Json(patch): Json<serde_json::Value>) -> impl IntoResponse {
    let mut current_json = {
        let s = state.settings.read().unwrap();
        serde_json::to_value(&*s).unwrap()
    };

    json_merge(&mut current_json, patch);

    let mut settings: AppSettings = match serde_json::from_value(current_json) {
        Ok(s) => s,
        Err(e) => return Json(serde_json::json!({"success": false, "error": e.to_string()})),
    };

    if settings.log.timezone < -12 || settings.log.timezone > 14 {
        return Json(serde_json::json!({"success": false, "error": "Неверный часовой пояс"}));
    }
    settings.normalize_proxies();

    *state.settings.write().unwrap() = settings.clone();
    match fs::write(APP_CONFIG, serde_json::to_string_pretty(&settings).unwrap()) {
        Ok(_) => Json(serde_json::json!({"success": true})),
        Err(e) => Json(serde_json::json!({"success": false, "error": e.to_string()})),
    }
}

fn json_merge(a: &mut serde_json::Value, b: serde_json::Value) {
    match (a, b) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (k, v) in b { json_merge(a.entry(k).or_insert(serde_json::Value::Null), v); }
        }
        (a, b) => *a = b,
    }
}