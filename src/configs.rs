use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};
use walkdir::WalkDir;
use crate::types::*;

#[derive(Serialize)]
struct ConfigItem { name: String, filename: String, content: String }

#[derive(Deserialize)]
pub struct ConfigReq { action: String, filename: String, content: String }

pub async fn get_configs(State(state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let core = state.core.read().unwrap();
    let target = params.get("core").map(|s| s.as_str()).unwrap_or(core.name.as_str());
    let (cdir, ext) = if target == "mihomo" { (MIHOMO_CONF, "config.yaml") } else { (XRAY_CONF, "json") };

    let mut res = Vec::new();
    let walker = WalkDir::new(cdir).max_depth(1);
    for e in walker.into_iter().filter_map(|e| e.ok()) {
        if e.path().extension().map_or(false, |x| if target == "xray" { x == ext } else { e.file_name().to_str().unwrap() == ext }) {
            if let Ok(c) = fs::read_to_string(e.path()) {
                res.push(ConfigItem {
                    name: e.path().file_stem().unwrap().to_string_lossy().into(),
                    filename: e.file_name().to_string_lossy().into(), content: c
                });
            }
        }
    }
    for e in WalkDir::new(XKEEN_CONF).max_depth(1).into_iter().filter_map(|e| e.ok()) {
         if e.path().extension().map_or(false, |x| x == "lst") {
            if let Ok(c) = fs::read_to_string(e.path()) {
                res.push(ConfigItem {
                    name: e.path().file_stem().unwrap().to_string_lossy().into(),
                    filename: e.file_name().to_string_lossy().into(), content: c
                });
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
    if !is_lst {
        if core.is_json { if !path.to_string_lossy().ends_with(".json") { path.set_extension("json"); } }
        else if serde_yaml::from_str::<serde_yaml::Value>(&content).is_err() {
             return Json(ApiResponse::<()> { success: false, error: Some("Invalid YAML".into()), data: None });
        }
    }
    if req.action == "save" {
        if fs::write(path, content).is_err() { return Json(ApiResponse::<()> { success: false, error: Some("Write error".into()), data: None }); }
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}