use crate::controller;
use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Json, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
struct ConfigItem {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct ConfigReq {
    file: String,
    content: String,
    #[serde(default)]
    apply: bool,
    #[serde(default)]
    validate_only: bool,
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
            MIHOMO_CONF.to_string()
        } else {
            XRAY_CONF.to_string()
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

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF).await {
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
        return vec![XKEEN_CONF.to_string()];
    }
    let settings = state.settings.read().unwrap();
    let core = state.core.read().unwrap();
    let default_path = if core.name == "mihomo" {
        MIHOMO_CONF.to_string()
    } else {
        XRAY_CONF.to_string()
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
    let is_xkeen = file.ends_with(".lst") || (file.ends_with(".json") && file.starts_with(XKEEN_CONF));
    let prefixes = get_allowed_prefixes(state, is_xkeen);
    if !is_path_allowed(file, &prefixes) {
        return Err("Path not allowed");
    }
    Ok(file.ends_with(".lst"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SafeApplyData {
    applied: bool,
    rollback_performed: bool,
    stage: String,
    validate_only: bool,
}

struct FileSnapshot {
    existed: bool,
    content: Vec<u8>,
    mode: Option<u32>,
}

fn is_xkeen_config(file: &str) -> bool {
    file.ends_with(".lst") || (file.ends_with(".json") && file.starts_with(XKEEN_CONF))
}

fn normalize_content(file: &str, content: String) -> String {
    if file.ends_with(".lst") {
        content.replace("\r\n", "\n")
    } else {
        content
    }
}

fn safe_apply_response(
    success: bool, stage: &str, error: Option<String>, applied: bool, rollback_performed: bool, validate_only: bool,
) -> Json<ApiResponse<SafeApplyData>> {
    Json(ApiResponse {
        success,
        error,
        data: Some(SafeApplyData {
            applied,
            rollback_performed,
            stage: stage.into(),
            validate_only,
        }),
    })
}

fn infer_target_core(state: &AppState, file: &str) -> String {
    if file.starts_with(MIHOMO_CONF) {
        "mihomo".into()
    } else if file.starts_with(XRAY_CONF) {
        "xray".into()
    } else {
        controller::current_core_name(state)
    }
}

fn get_core_config_paths(state: &AppState, core: &str) -> Vec<String> {
    let settings = state.settings.read().unwrap();
    let mut paths = vec![controller::core_config_dir(core).unwrap_or(XRAY_CONF).to_string()];
    let extra = if core == "mihomo" {
        settings.append_config_paths.mihomo.clone()
    } else {
        settings.append_config_paths.xray.clone()
    };
    paths.extend(extra);
    paths
}

fn stage_mirror_path(root: &Path, original: &Path) -> Result<PathBuf, String> {
    let relative = original
        .strip_prefix("/")
        .map_err(|_| format!("Не удалось подготовить путь {}", original.display()))?;
    Ok(root.join(relative))
}

async fn copy_file_to_stage(source: &Path, stage_root: &Path) -> Result<(), String> {
    let target = stage_mirror_path(stage_root, source)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Не удалось подготовить staging-директорию {}: {}", parent.display(), e))?;
    }
    tokio::fs::copy(source, &target)
        .await
        .map_err(|e| format!("Не удалось скопировать {}: {}", source.display(), e))?;
    Ok(())
}

async fn copy_path_to_stage(source: &Path, is_mihomo: bool, stage_root: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if source.is_dir() {
        let mut entries = tokio::fs::read_dir(source)
            .await
            .map_err(|e| format!("Не удалось открыть {}: {}", source.display(), e))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| format!("Не удалось прочитать {}: {}", source.display(), e))?
        {
            let path = entry.path();
            let matches = if is_mihomo {
                path.extension().map_or(false, |e| e == "yaml" || e == "yml")
            } else {
                path.extension().map_or(false, |e| e == "json")
            };
            if matches {
                copy_file_to_stage(&path, stage_root).await?;
            }
        }
        return Ok(());
    }
    copy_file_to_stage(source, stage_root).await
}

async fn create_stage_root() -> Result<PathBuf, String> {
    let root = std::env::temp_dir().join(format!(
        "xkeen-ui-safe-apply-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| format!("Не удалось создать staging-директорию {}: {}", root.display(), e))?;
    Ok(root)
}

async fn stage_candidate_config(state: &AppState, core: &str, file: &Path, content: &str) -> Result<PathBuf, String> {
    let stage_root = create_stage_root().await?;
    let is_mihomo = core == "mihomo";
    for source in get_core_config_paths(state, core) {
        copy_path_to_stage(Path::new(&source), is_mihomo, &stage_root).await?;
    }
    let staged_target = stage_mirror_path(&stage_root, file)?;
    write_file_atomically(&staged_target, content.as_bytes(), None).await?;
    Ok(stage_root)
}

async fn take_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) => {
            let content = tokio::fs::read(path)
                .await
                .map_err(|e| format!("Не удалось сохранить snapshot {}: {}", path.display(), e))?;
            Ok(FileSnapshot {
                existed: true,
                content,
                mode: Some(metadata.permissions().mode()),
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileSnapshot {
            existed: false,
            content: Vec::new(),
            mode: None,
        }),
        Err(e) => Err(format!("Не удалось получить метаданные {}: {}", path.display(), e)),
    }
}

async fn write_file_atomically(path: &Path, content: &[u8], mode: Option<u32>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Не удалось определить директорию для {}", path.display()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| format!("Не удалось создать директорию {}: {}", parent.display(), e))?;

    let tmp_path = parent.join(format!(
        ".{}.xkeen-ui-tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("config"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));

    if let Err(e) = tokio::fs::write(&tmp_path, content).await {
        return Err(format!(
            "Не удалось записать временный файл {}: {}",
            tmp_path.display(),
            e
        ));
    }

    let desired_mode = if let Some(mode) = mode {
        Some(mode)
    } else {
        tokio::fs::metadata(path)
            .await
            .ok()
            .map(|metadata| metadata.permissions().mode())
    };

    if let Some(mode) = desired_mode {
        let _ = tokio::fs::set_permissions(&tmp_path, fs::Permissions::from_mode(mode)).await;
    }

    if let Err(e) = tokio::fs::rename(&tmp_path, path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("Не удалось атомарно заменить {}: {}", path.display(), e));
    }

    Ok(())
}

async fn restore_snapshot(path: &Path, snapshot: &FileSnapshot) -> Result<(), String> {
    if snapshot.existed {
        write_file_atomically(path, &snapshot.content, snapshot.mode).await
    } else {
        match tokio::fs::remove_file(path).await {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Не удалось удалить {} при rollback: {}", path.display(), e)),
        }
    }
}

async fn validate_candidate(state: &AppState, core: &str, file: &Path, content: &str) -> Result<(), String> {
    let stage_root = stage_candidate_config(state, core, file, content).await?;
    let staged_core_dir = stage_root.join(
        controller::core_config_dir(core)
            .ok_or_else(|| "Неизвестное ядро".to_string())?
            .trim_start_matches('/'),
    );
    let result = controller::validate_core_config(core, &staged_core_dir).await;
    let _ = tokio::fs::remove_dir_all(&stage_root).await;
    result
}

async fn restart_with_healthcheck(state: &AppState, core: &str) -> Result<(), String> {
    if core == "mihomo" {
        _ = tokio::fs::write(error_log_path(), b"").await;
    }
    controller::run_init_command(state, &["restart", "on"]).await?;
    controller::wait_for_core_healthy(core).await
}

async fn safe_apply_config(state: &AppState, file: String, content: String) -> Json<ApiResponse<SafeApplyData>> {
    let _guard = state.service_op_lock.lock().await;

    let target_path = PathBuf::from(&file);
    let target_core = infer_target_core(state, &file);

    let snapshot = match take_snapshot(&target_path).await {
        Ok(snapshot) => snapshot,
        Err(e) => {
            return safe_apply_response(false, "backup", Some(e), false, false, false);
        }
    };

    if !is_xkeen_config(&file) {
        if let Err(e) = validate_candidate(state, &target_core, &target_path, &content).await {
            return safe_apply_response(false, "validate", Some(e), false, false, false);
        }
    }

    if let Err(e) = write_file_atomically(&target_path, content.as_bytes(), snapshot.mode).await {
        return safe_apply_response(false, "write", Some(e), false, false, false);
    }

    match restart_with_healthcheck(state, &target_core).await {
        Ok(()) => safe_apply_response(true, "completed", None, true, false, false),
        Err(restart_error) => {
            if let Err(e) = restore_snapshot(&target_path, &snapshot).await {
                return safe_apply_response(
                    false,
                    "rollback",
                    Some(format!(
                        "Сервис не поднялся после применения: {}. Дополнительно не удалось восстановить snapshot: {}",
                        restart_error, e
                    )),
                    false,
                    false,
                    false,
                );
            }

            if let Err(e) = restart_with_healthcheck(state, &target_core).await {
                return safe_apply_response(
                    false,
                    "rollback",
                    Some(format!(
                        "Новый конфиг не применён: {}. Файл откатан, но не удалось вернуть сервис в рабочее состояние: {}",
                        restart_error, e
                    )),
                    false,
                    false,
                    false,
                );
            }

            safe_apply_response(
                false,
                "rollback",
                Some(format!(
                    "Новый конфиг не применён: {}. Выполнен автоматический rollback предыдущей рабочей версии.",
                    restart_error
                )),
                false,
                true,
                false,
            )
        }
    }
}

pub async fn put_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> Response {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(e) => {
            return Json(ApiResponse::<()> {
                success: false,
                error: Some(e.into()),
                data: None,
            })
            .into_response();
        }
    };
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };

    if req.validate_only {
        let target_core = infer_target_core(&state, &req.file);
        if is_xkeen_config(&req.file) {
            return safe_apply_response(
                false,
                "validate",
                Some("Для этого файла validate-only не поддерживается".into()),
                false,
                false,
                true,
            )
            .into_response();
        }
        return match validate_candidate(&state, &target_core, Path::new(&req.file), &content).await {
            Ok(()) => safe_apply_response(true, "validated", None, false, false, true).into_response(),
            Err(e) => safe_apply_response(false, "validate", Some(e), false, false, true).into_response(),
        };
    }

    if req.apply {
        return safe_apply_config(&state, req.file, content).await.into_response();
    }

    if let Err(e) = write_file_atomically(Path::new(&req.file), content.as_bytes(), None).await {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e),
            data: None,
        })
        .into_response();
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
    .into_response()
}

pub async fn post_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    match check_access(&req.file, &state) {
        Ok(_) => {}
        Err(e) => {
            return Json(ApiResponse::<()> {
                success: false,
                error: Some(e.into()),
                data: None,
            });
        }
    }
    if Path::new(&req.file).exists() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("File already exists".into()),
            data: None,
        });
    }
    let content = normalize_content(&req.file, req.content);
    if let Err(e) = write_file_atomically(Path::new(&req.file), content.as_bytes(), None).await {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn delete_config(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if fs::remove_file(&req.file).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Delete error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn patch_config(State(state): State<AppState>, Json(req): Json<RenameReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if let Err(e) = check_access(&req.new_file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if Path::new(&req.new_file).exists() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("File already exists".into()),
            data: None,
        });
    }
    if fs::rename(&req.file, &req.new_file).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Rename error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lst_content_is_normalized_to_lf() {
        assert_eq!(
            normalize_content("/opt/etc/xkeen/test.lst", "a\r\nb\r\n".into()),
            "a\nb\n"
        );
        assert_eq!(
            normalize_content("/opt/etc/xray/configs/01.json", "a\r\nb\r\n".into()),
            "a\r\nb\r\n"
        );
    }

    #[test]
    fn path_allowlist_supports_files_and_directories() {
        let root = std::env::temp_dir().join(format!("xkeen-ui-config-test-{}", std::process::id()));
        let dir = root.join("configs");
        std::fs::create_dir_all(&dir).unwrap();
        let file = root.join("config.yaml");
        std::fs::write(&file, "port: 7890").unwrap();

        let prefixes = vec![dir.to_string_lossy().into_owned(), file.to_string_lossy().into_owned()];

        assert!(is_path_allowed(&dir.join("01.json").to_string_lossy(), &prefixes));
        assert!(is_path_allowed(&file.to_string_lossy(), &prefixes));
        assert!(!is_path_allowed(
            &root.join("other/01.json").to_string_lossy(),
            &prefixes
        ));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stage_paths_preserve_absolute_layout() {
        let stage = Path::new("/tmp/stage-root");
        let original = Path::new("/opt/etc/mihomo/config.yaml");
        assert_eq!(
            stage_mirror_path(stage, original).unwrap(),
            PathBuf::from("/tmp/stage-root/opt/etc/mihomo/config.yaml")
        );
    }
}
