use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::Path};
use crate::types::*;
use crate::logger::log;

#[derive(Serialize)] struct ConfigItem { file: String, content: String }
#[derive(Deserialize)] pub struct ConfigReq { file: String, content: String }
#[derive(Deserialize)] pub struct DeleteReq { file: String }
#[derive(Deserialize)] pub struct RenameReq { file: String, new_file: String }

async fn collect_configs(paths: &[String], is_mihomo: bool) -> Vec<ConfigItem> {
    let mut results = Vec::new();
    for path_str in paths {
        let path = Path::new(path_str);
        if path.is_dir() {
            match tokio::fs::read_dir(path).await {
                Err(e) => { log("ERROR", format!("Не удалось открыть директорию {}: {}", path_str, e)); }
                Ok(mut entries) => {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let entry_path = entry.path();
                        let matches = if is_mihomo {
                            entry_path.extension().map_or(false, |e| e == "yaml" || e == "yml")
                        } else {
                            entry_path.extension().map_or(false, |e| e == "json")
                        };
                        if matches {
                            match tokio::fs::read_to_string(&entry_path).await {
                                Ok(content) => results.push(ConfigItem {
                                    file: entry_path.to_string_lossy().into(),
                                    content,
                                }),
                                Err(e) => { log("ERROR", format!("Не удалось прочитать файл {}: {}", entry_path.display(), e)); }
                            }
                        }
                    }
                }
            }
        } else if path.exists() {
            match tokio::fs::read_to_string(path).await {
                Ok(content) => results.push(ConfigItem { file: path_str.clone(), content }),
                Err(e) => { log("ERROR", format!("Не удалось прочитать файл {}: {}", path_str, e)); }
            }
        } else {
            log("WARN", format!("Файл не найден: {}", path_str));
        }
    }
    results.sort_by(|a, b| a.file.cmp(&b.file));
    results.dedup_by(|a, b| a.file == b.file);
    results
}

pub async fn get_configs(State(state): State<AppState>, Query(parameters): Query<HashMap<String, String>>) -> impl IntoResponse {
    let target_core = parameters.get("core").cloned().unwrap_or_else(|| state.core.read().unwrap().name.clone());
    let is_mihomo = target_core == "mihomo";

    let core_paths = {
        let settings = state.settings.read().unwrap();
        let default_path = if is_mihomo { MIHOMO_CONF.to_string() } else { XRAY_CONF.to_string() };
        let mut paths = vec![default_path];
        let extra = if is_mihomo { settings.append_config_paths.mihomo.clone() } else { settings.append_config_paths.xray.clone() };
        paths.extend(extra);
        paths
    };

    let mut core_configs = collect_configs(&core_paths, is_mihomo).await;
    let mut lst_configs = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "lst") {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    lst_configs.push(ConfigItem {
                        file: path.to_string_lossy().into(),
                        content,
                    });
                }
            }
        }
    }

    lst_configs.sort_by(|a, b| a.file.cmp(&b.file));
    core_configs.append(&mut lst_configs);

    Json(serde_json::json!({ "success": true, "configs": core_configs }))
}

fn get_allowed_prefixes(state: &AppState, is_lst: bool) -> Vec<String> {
    if is_lst {
        return vec![XKEEN_CONF.to_string()];
    }
    let settings = state.settings.read().unwrap();
    let core = state.core.read().unwrap();
    let default_path = if core.name == "mihomo" { MIHOMO_CONF.to_string() } else { XRAY_CONF.to_string() };
    let extra = if core.name == "mihomo" { settings.append_config_paths.mihomo.clone() } else { settings.append_config_paths.xray.clone() };
    let mut paths = vec![default_path];
    paths.extend(extra);
    paths
}

fn is_path_allowed(file: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        let prefix_path = Path::new(prefix.as_str());
        let file_path = Path::new(file);
        if prefix_path.is_dir() { file_path.starts_with(prefix_path) } else { file == prefix }
    })
}

fn check_access(file: &str, state: &AppState) -> Result<bool, &'static str> {
    if file.contains("..") {
        return Err("Invalid path");
    }
    let is_lst = file.ends_with(".lst");
    let prefixes = get_allowed_prefixes(state, is_lst);
    if !is_path_allowed(file, &prefixes) {
        return Err("Path not allowed");
    }
    Ok(is_lst)
}

pub async fn put_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(e) => return Json(ApiResponse::<()> { success: false, error: Some(e.into()), data: None }),
    };
    let content = if is_lst { req.content.replace("\r\n", "\n") } else { req.content };
    if fs::write(&req.file, content).is_err() {
        return Json(ApiResponse::<()> { success: false, error: Some("Write error".into()), data: None });
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}

pub async fn post_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(e) => return Json(ApiResponse::<()> { success: false, error: Some(e.into()), data: None }),
    };
    if Path::new(&req.file).exists() {
        return Json(ApiResponse::<()> { success: false, error: Some("File already exists".into()), data: None });
    }
    let content = if is_lst { req.content.replace("\r\n", "\n") } else { req.content };
    if fs::write(&req.file, content).is_err() {
        return Json(ApiResponse::<()> { success: false, error: Some("Write error".into()), data: None });
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}

pub async fn delete_config(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> { success: false, error: Some(e.into()), data: None });
    }
    if fs::remove_file(&req.file).is_err() {
        return Json(ApiResponse::<()> { success: false, error: Some("Delete error".into()), data: None });
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}

pub async fn patch_config(State(state): State<AppState>, Json(req): Json<RenameReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> { success: false, error: Some(e.into()), data: None });
    }
    if let Err(e) = check_access(&req.new_file, &state) {
        return Json(ApiResponse::<()> { success: false, error: Some(e.into()), data: None });
    }
    if Path::new(&req.new_file).exists() {
        return Json(ApiResponse::<()> { success: false, error: Some("File already exists".into()), data: None });
    }
    if fs::rename(&req.file, &req.new_file).is_err() {
        return Json(ApiResponse::<()> { success: false, error: Some("Rename error".into()), data: None });
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}