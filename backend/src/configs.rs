use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};
use crate::types::*;

#[derive(Serialize)] struct ConfigItem { name: String, filename: String, content: String }
#[derive(Deserialize)] pub struct ConfigReq { action: String, filename: String, content: String }

pub async fn get_configs(State(state): State<AppState>, Query(parameters): Query<HashMap<String, String>>) -> impl IntoResponse {
    let target_core = parameters.get("core").cloned().unwrap_or_else(|| state.core.read().unwrap().name.clone());
    let (config_directory, extension) = if target_core == "mihomo" { (MIHOMO_CONF, "config.yaml") } else { (XRAY_CONF, "json") };

    let mut results = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(config_directory).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let matches_extension = if target_core == "xray" {
                path.extension().map_or(false, |config_extension| config_extension == extension)
            } else {
                entry.file_name().to_str().map_or(false, |file_name| file_name == extension)
            };
            if matches_extension {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    results.push(ConfigItem {
                        name: path.file_stem().unwrap().to_string_lossy().into(),
                        filename: entry.file_name().to_string_lossy().into(),
                        content,
                    });
                }
            }
        }
    }

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().map_or(false, |config_extension| config_extension == "lst") {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    results.push(ConfigItem {
                        name: path.file_stem().unwrap().to_string_lossy().into(),
                        filename: entry.file_name().to_string_lossy().into(),
                        content,
                    });
                }
            }
        }
    }

    results.sort_by(|first, second| first.name.cmp(&second.name));
    Json(serde_json::json!({ "success": true, "configs": results }))
}

pub async fn put_configs(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let core = state.core.read().unwrap();
    let is_lst = req.filename.ends_with(".lst");
    let mut path = PathBuf::from(if is_lst { XKEEN_CONF } else { &core.conf_dir });
    path.push(&req.filename);

    let content = if is_lst { req.content.replace("\r\n", "\n") } else { req.content };

    if !is_lst && core.is_json && !path.to_string_lossy().ends_with(".json") {
        path.set_extension("json");
    }

    if req.action == "save" {
        if fs::write(path, content).is_err() {
            return Json(ApiResponse::<()> { success: false, error: Some("Write error".into()), data: None });
        }
    }

    Json(ApiResponse::<()> { success: true, error: None, data: None })
}