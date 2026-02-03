use axum::response::{IntoResponse, Json};

pub async fn version_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "success": true,
        "version": env!("CARGO_PKG_VERSION")
    }))
}
