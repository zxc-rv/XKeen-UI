use crate::types::AppState;
use axum::extract::State;
use axum::response::Json;
use std::time::Duration;

fn memory_value(data: &serde_json::Value, key: &str) -> Option<u64> {
    data.get(key)?.as_u64().map(|value| value * 1024)
}

pub async fn get_system_stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut request = state
        .http_client
        .get("http://127.0.0.1:79/rci/show/system")
        .timeout(Duration::from_secs(5));
    if let Some(token) = state.rci_token.as_ref() {
        request = request.header("X-Ndma-Tkn", token);
    }

    let response = match request.send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            return Json(serde_json::json!({
                "success": false,
                "error": format!("RCI вернул {}", response.status()),
            }));
        }
        Err(error) => return Json(serde_json::json!({ "success": false, "error": error.to_string() })),
    };

    let data = match response.json::<serde_json::Value>().await {
        Ok(data) => data,
        Err(error) => return Json(serde_json::json!({ "success": false, "error": error.to_string() })),
    };
    let memory_total = memory_value(&data, "memtotal");
    let memory_used = data
        .get("memory")
        .and_then(|value| value.as_str())
        .and_then(|value| value.split_once('/'))
        .and_then(|(used, _)| used.parse::<u64>().ok())
        .map(|value| value * 1024);

    match (
        memory_used,
        memory_total,
        data.get("cpuload").and_then(|value| value.as_f64()),
    ) {
        (Some(memory_used), Some(memory_total), Some(cpu_usage)) => Json(serde_json::json!({
            "success": true,
            "memoryUsed": memory_used,
            "memoryTotal": memory_total,
            "cpuUsage": cpu_usage,
        })),
        _ => Json(serde_json::json!({ "success": false, "error": "RCI вернул неполные системные метрики" })),
    }
}
