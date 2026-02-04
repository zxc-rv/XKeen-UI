use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};
use crate::types::*;

#[derive(Serialize)]
struct ConfigItem { name: String, filename: String, content: String }

#[derive(Deserialize)]
pub struct ConfigReq { action: String, filename: String, content: String }

pub async fn get_configs(State(state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let core = state.core.read().unwrap();
    let target = params.get("core").map(|s| s.as_str()).unwrap_or(&core.name);
    let (cdir, ext) = if target == "mihomo" { (MIHOMO_CONF, "config.yaml") } else { (XRAY_CONF, "json") };

    let mut res = Vec::new();

    if let Ok(entries) = fs::read_dir(cdir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let matches = if target == "xray" {
                path.extension().map_or(false, |x| x == ext)
            } else {
                entry.file_name().to_str().map_or(false, |n| n == ext)
            };
            if matches {
                if let Ok(c) = fs::read_to_string(&path) {
                    res.push(ConfigItem {
                        name: path.file_stem().unwrap().to_string_lossy().into(),
                        filename: entry.file_name().to_string_lossy().into(),
                        content: c
                    });
                }
            }
        }
    }

    if let Ok(entries) = fs::read_dir(XKEEN_CONF) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().map_or(false, |x| x == "lst") {
                if let Ok(c) = fs::read_to_string(&path) {
                    res.push(ConfigItem {
                        name: path.file_stem().unwrap().to_string_lossy().into(),
                        filename: entry.file_name().to_string_lossy().into(),
                        content: c
                    });
                }
            }
        }
    }

    res.sort_by(|a, b| a.name.cmp(&b.name));
    Json(serde_json::json!({ "success": true, "configs": res }))
}

pub async fn post_configs(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
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