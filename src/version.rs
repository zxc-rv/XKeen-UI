use axum::response::{IntoResponse, Json};
use crate::types::VERSION;

pub async fn version_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "success": true,
        "version": VERSION
    }))
}