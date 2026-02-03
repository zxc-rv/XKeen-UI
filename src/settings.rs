use axum::{extract::State, response::{IntoResponse, Json}};
use crate::types::*;
use std::fs;

pub async fn get_settings(State(state): State<AppState>) -> impl IntoResponse {
    let off = state.settings.read().unwrap().timezone_offset;
    Json(serde_json::json!({ "success": true, "timezoneOffset": off }))
}

pub async fn post_settings(State(state): State<AppState>, Json(req): Json<AppSettings>) -> impl IntoResponse {
    if req.timezone_offset < -12 || req.timezone_offset > 14 {
        return Json(ApiResponse::<()> { success: false, error: Some("Bad timezone".into()), data: None });
    }
    {
        let mut s = state.settings.write().unwrap();
        s.timezone_offset = req.timezone_offset;
    }
    let _ = fs::write(APP_CONFIG, serde_json::to_string(&req).unwrap());
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}