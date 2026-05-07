use crate::types::AppState;
use axum::{
    extract::State,
    response::{IntoResponse, Json},
};
use std::time::Duration;

pub async fn get_device_list(State(state): State<AppState>) -> impl IntoResponse {
    let response = match state
        .http_client
        .get("http://localhost:79/rci/show/device-list")
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => return Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    };

    if !response.status().is_success() {
        return Json(serde_json::json!({
            "success": false,
            "error": format!("RCI вернул {}", response.status()),
        }));
    }

    match response.json::<serde_json::Value>().await {
        Ok(data) => Json(serde_json::json!({
            "success": true,
            "host": data.get("host").cloned().unwrap_or_else(|| serde_json::json!([])),
        })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}
