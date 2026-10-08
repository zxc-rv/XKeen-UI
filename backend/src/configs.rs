use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

#[derive(Serialize)]
struct ConfigItem {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct ConfigReq {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct DeleteReq {
    file: String,
}
#[derive(Deserialize)]
pub struct RenameReq {
    file: String,
    new_file: String,
}

async fn collect_configs(paths: &[String], is_mihomo: bool) -> Vec<ConfigItem> {
    let mut results = Vec::new();
    for path_str in paths {
        let path = Path::new(path_str);
        if path.is_dir() {
            match tokio::fs::read_dir(path).await {
                Err(e) => {
                    log("ERROR", format!("Не удалось открыть директорию {}: {}", path_str, e));
                }
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
                                Err(e) => {
                                    log(
                                        "ERROR",
                                        format!("Не удалось прочитать файл {}: {}", entry_path.display(), e),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        } else if path.exists() {
            match tokio::fs::read_to_string(path).await {
                Ok(content) => results.push(ConfigItem {
                    file: path_str.clone(),
                    content,
                }),
                Err(e) => {
                    log("ERROR", format!("Не удалось прочитать файл {}: {}", path_str, e));
                }
            }
        } else {
            log("WARN", format!("Файл не найден: {}", path_str));
        }
    }
    results.sort_by(|a, b| a.file.cmp(&b.file));
    results.dedup_by(|a, b| a.file == b.file);
    results
}

pub async fn get_configs(
    State(state): State<AppState>, Query(parameters): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let target_core = parameters
        .get("core")
        .cloned()
        .unwrap_or_else(|| state.core.read().unwrap().name.clone());
    let is_mihomo = target_core == "mihomo";

    let core_paths = {
        let settings = state.settings.read().unwrap();
        let default_path = if is_mihomo {
            MIHOMO_CONF_DIR.to_string()
        } else {
            XRAY_CONF_DIR.to_string()
        };
        let mut paths = vec![default_path];
        let extra = if is_mihomo {
            settings.append_config_paths.mihomo.clone()
        } else {
            settings.append_config_paths.xray.clone()
        };
        paths.extend(extra);
        paths
    };

    let mut core_configs = collect_configs(&core_paths, is_mihomo).await;
    let mut lst_configs = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF_DIR).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.extension().map_or(false, |e| e == "lst") || name == "xkeen.json" {
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
        return vec![XKEEN_CONF_DIR.to_string()];
    }
    let settings = state.settings.read().unwrap();
    let core = state.core.read().unwrap();
    let default_path = if core.name == "mihomo" {
        MIHOMO_CONF_DIR.to_string()
    } else {
        XRAY_CONF_DIR.to_string()
    };
    let extra = if core.name == "mihomo" {
        settings.append_config_paths.mihomo.clone()
    } else {
        settings.append_config_paths.xray.clone()
    };
    let mut paths = vec![default_path];
    paths.extend(extra);
    paths
}

fn is_path_allowed(file: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        let prefix_path = Path::new(prefix.as_str());
        let file_path = Path::new(file);
        if prefix_path.is_dir() {
            file_path.starts_with(prefix_path)
        } else {
            file == prefix
        }
    })
}

fn check_access(file: &str, state: &AppState) -> Result<bool, &'static str> {
    if file.contains("..") {
        return Err("Invalid path");
    }
    let is_xkeen = file.ends_with(".lst") || (file.ends_with(".json") && file.starts_with(XKEEN_CONF_DIR));
    let prefixes = get_allowed_prefixes(state, is_xkeen);
    if !is_path_allowed(file, &prefixes) {
        return Err("Path not allowed");
    }
    Ok(file.ends_with(".lst"))
}

pub async fn put_config(
    State(state): State<AppState>, headers: HeaderMap, Query(params): Query<HashMap<String, String>>,
    Json(req): Json<ConfigReq>,
) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(error) => return api_error(error)
    };
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };

    if let Some(core_type) = params.get("validate") {
        if core_type == "mihomo" {
            return apply_mihomo_hot_reload(&state, &headers, &req.file, &content).await;
        }
        if core_type == "xray" {
            let mut validate_files = Vec::new();
            if let Ok(mut entries) = tokio::fs::read_dir(XRAY_CONF_DIR).await {
                let mut found_current = false;
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "json") {
                        let path_str = path.to_string_lossy().into_owned();
                        let file_content = if path_str == req.file {
                            found_current = true;
                            content.clone()
                        } else {
                            tokio::fs::read_to_string(&path).await.unwrap_or_default()
                        };
                        validate_files.push(ConfigReq {
                            file: path_str,
                            content: file_content,
                        });
                    }
                }
                if !found_current {
                    validate_files.push(ConfigReq {
                        file: req.file.clone(),
                        content: content.clone(),
                    });
                }
            } else {
                validate_files.push(ConfigReq {
                    file: req.file.clone(),
                    content: content.clone(),
                });
            }

            if let Err(err_msg) = validate_core(&validate_files).await {
                log("ERROR", err_msg);
                return api_error("Validation failed");
            }
        }
    }

    if fs::write(&req.file, &content).is_err() {
        return api_error("Write error");
    }
    api_ok()
}

pub async fn post_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(error) => return api_error(error)
    };
    if Path::new(&req.file).exists() {
        return api_error("File already exists");
    }
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };
    if fs::write(&req.file, content).is_err() {
        return api_error("Write error");
    }
    api_ok()
}

pub async fn delete_config(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return api_error(e);
    }
    if fs::remove_file(&req.file).is_err() {
        return api_error("Delete error");
    }
    api_ok()
}

pub async fn patch_config(State(state): State<AppState>, Json(req): Json<RenameReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return api_error(e);
    }
    if let Err(e) = check_access(&req.new_file, &state) {
        return api_error(e);
    }
    if Path::new(&req.new_file).exists() {
        return api_error("File already exists");
    }
    if fs::rename(&req.file, &req.new_file).is_err() {
        return api_error("Rename error");
    }
    api_ok()
}

async fn validate_core(files: &[ConfigReq]) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join(format!(
        "xkeen-ui-validation-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| e.to_string())?;

    for item in files {
        let Some(name) = Path::new(&item.file).file_name() else {
            continue;
        };
        if let Err(e) = tokio::fs::write(temp_dir.join(name), &item.content).await {
            _ = tokio::fs::remove_dir_all(&temp_dir).await;
            return Err(e.to_string());
        }
    }

    let mut cmd = tokio::process::Command::new("xray");
    cmd.args(["-test", "-confdir"]).arg(&temp_dir);
    cmd.env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR);

    let output = cmd.output().await;
    _ = tokio::fs::remove_dir_all(&temp_dir).await;

    let output = output.map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Err(combined)
}

#[derive(Deserialize)]
struct MihomoError {
    message: String,
}

fn api_ok() -> Json<ApiResponse<()>> {
    Json(ApiResponse { success: true, error: None, data: None })
}

fn api_error(error: impl Into<String>) -> Json<ApiResponse<()>> {
    Json(ApiResponse { success: false, error: Some(error.into()), data: None })
}

async fn apply_mihomo_hot_reload(
    state: &AppState, headers: &HeaderMap, file: &str, content: &str,
) -> Json<ApiResponse<()>> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());

    let (client, url) = match (header("x-clash-unix"), header("x-clash-port").and_then(|port| port.parse::<u16>().ok())) {
        (Some(socket), _) => {
            let socket_path = Path::new(MIHOMO_CONF_DIR).join(Path::new(socket).file_name().unwrap_or_default());
            match reqwest::Client::builder().unix_socket(socket_path).build() {
                Ok(client) => (client, "http://127.0.0.1/configs".to_string()),
                Err(error) => return api_error(error.to_string()),
            }
        }
        (None, Some(port)) => (state.http_client.clone(), format!("http://127.0.0.1:{port}/configs")),
        (None, None) => return api_error("external-controller не найден"),
    };

    let previous = tokio::fs::read_to_string(file).await.ok();
    if let Err(error) = tokio::fs::write(file, content).await {
        return api_error(format!("Write error: {error}"));
    }

    let mut request = client.put(url).json(&serde_json::json!({})).timeout(Duration::from_secs(15));
    if let Some(secret) = header("x-clash-secret") {
        request = request.bearer_auth(secret);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = format!("Ошибка Mihomo: {error}");
            log("ERROR", message.clone());
            return api_error(message);
        }
    };

    let status = response.status();
    if status == StatusCode::NO_CONTENT {
        return api_ok();
    }

    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<MihomoError>(&body).map_or(body, |error| error.message);
    let detail = match message.trim() {
        "" => format!("Mihomo вернул {status}"),
        trimmed => trimmed.chars().take(2000).collect(),
    };

    let message = format!("Ошибка Mihomo: {detail}");
    log("ERROR", message.clone());
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return api_error(message);
    }

    if let Some(old) = previous {
        _ = tokio::fs::write(file, old).await;
    } else {
        _ = tokio::fs::remove_file(file).await;
    }
    api_error("Validation failed")
}
