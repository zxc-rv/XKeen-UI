use crate::configs::check_access;
use crate::types::AppState;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const HISTORY_DIR: &str = "/opt/var/lib/xkeen-ui/config-history";
static HISTORY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize, Serialize)]
struct ConfigRevision {
    id: String,
    date: String,
    content: String,
}

#[derive(Deserialize, Serialize)]
struct ConfigHistory {
    file: String,
    history: Vec<ConfigRevision>,
}

#[derive(Deserialize)]
pub struct SaveConfigRevision {
    file: String,
    content: String,
    #[serde(default)]
    previous_content: Option<String>,
    date: String,
}

#[derive(Deserialize)]
pub struct GetConfigHistory {
    file: String,
}

#[derive(Deserialize)]
pub struct DeleteConfigHistory {
    file: String,
    id: Option<String>,
}

fn history_path(file: &str) -> PathBuf {
    let key = format!("{:x}", md5::compute(file.as_bytes()));
    PathBuf::from(HISTORY_DIR).join(format!("{key}.json"))
}

fn supports_history(file: &str) -> bool {
    PathBuf::from(file)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "yaml" | "yml" | "json"))
}

fn valid_date(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|_| Utc::now().to_rfc3339())
}

fn error(message: impl Into<String>, status: StatusCode) -> impl IntoResponse {
    (
        status,
        Json(serde_json::json!({ "success": false, "error": message.into() })),
    )
}

pub async fn get_config_history(
    State(state): State<AppState>, Query(request): Query<GetConfigHistory>,
) -> impl IntoResponse {
    if !supports_history(&request.file) {
        return error(
            "Change history supports YAML and JSON files only",
            StatusCode::BAD_REQUEST,
        )
        .into_response();
    }
    if let Err(message) = check_access(&request.file, &state) {
        return error(message, StatusCode::FORBIDDEN).into_response();
    }

    let _guard = HISTORY_LOCK.lock().await;
    let path = history_path(&request.file);
    let history = match tokio::fs::read_to_string(&path).await {
        Ok(contents) => match serde_json::from_str::<ConfigHistory>(&contents) {
            Ok(history) if history.file == request.file => history,
            Ok(_) => return error("History file mismatch", StatusCode::CONFLICT).into_response(),
            Err(_) => return error("History data is corrupted", StatusCode::INTERNAL_SERVER_ERROR).into_response(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ConfigHistory {
            file: request.file.clone(),
            history: Vec::new(),
        },
        Err(_) => return error("Could not read config history", StatusCode::INTERNAL_SERVER_ERROR).into_response(),
    };

    Json(serde_json::json!({ "success": true, "history": history.history })).into_response()
}

pub async fn put_config_history(
    State(state): State<AppState>, Json(request): Json<SaveConfigRevision>,
) -> impl IntoResponse {
    if !supports_history(&request.file) {
        return error(
            "Change history supports YAML and JSON files only",
            StatusCode::BAD_REQUEST,
        )
        .into_response();
    }
    if let Err(message) = check_access(&request.file, &state) {
        return error(message, StatusCode::FORBIDDEN).into_response();
    }

    let config_history_settings = state.settings.read().unwrap().config_history;
    let max_snapshots = config_history_settings.max_snapshots;
    if !config_history_settings.enabled || max_snapshots == 0 {
        return Json(serde_json::json!({ "success": true, "disabled": true })).into_response();
    }

    let _guard = HISTORY_LOCK.lock().await;
    let path = history_path(&request.file);
    let mut history = match tokio::fs::read_to_string(&path).await {
        Ok(contents) => match serde_json::from_str::<ConfigHistory>(&contents) {
            Ok(history) if history.file == request.file => history,
            Ok(_) => return error("History file mismatch", StatusCode::CONFLICT).into_response(),
            Err(_) => return error("History data is corrupted", StatusCode::INTERNAL_SERVER_ERROR).into_response(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ConfigHistory {
            file: request.file.clone(),
            history: Vec::new(),
        },
        Err(_) => return error("Could not read config history", StatusCode::INTERNAL_SERVER_ERROR).into_response(),
    };

    let before_len = history.history.len();
    let date = valid_date(&request.date);
    let appended = append_snapshot(
        &mut history,
        max_snapshots,
        request.previous_content.as_deref(),
        &request.content,
        &date,
    );
    if !appended {
        if let Some(last) = history.history.last().filter(|last| last.content == request.content) {
            return Json(serde_json::json!({ "success": true, "id": last.id })).into_response();
        }
        return Json(serde_json::json!({ "success": true, "full": true })).into_response();
    }
    debug_assert!(history.history.len() > before_len);
    let id = history.history.last().map(|revision| revision.id.clone());

    if let Err(e) = write_history(&path, &history).await {
        return error(
            format!("Could not save config history: {e}"),
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .into_response();
    }

    Json(serde_json::json!({ "success": true, "id": id })).into_response()
}

fn append_snapshot(
    history: &mut ConfigHistory, max_snapshots: usize, previous_content: Option<&str>, content: &str, date: &str,
) -> bool {
    if max_snapshots == 0 || history.history.last().is_some_and(|last| last.content == content) {
        return false;
    }

    let mut additions = Vec::new();
    if history.history.is_empty() {
        if let Some(previous) = previous_content.filter(|previous| *previous != content) {
            let baseline_date = DateTime::parse_from_rfc3339(date)
                .map(|parsed| {
                    (parsed - chrono::Duration::milliseconds(1))
                        .with_timezone(&Utc)
                        .to_rfc3339()
                })
                .unwrap_or_else(|_| date.to_string());
            additions.push(new_revision(previous.to_string(), baseline_date));
        }
    } else if let Some(previous) = previous_content
        && history.history.last().is_some_and(|last| last.content != previous)
        && previous != content
    {
        additions.push(new_revision(previous.to_string(), date.to_string()));
    }
    additions.push(new_revision(content.to_string(), date.to_string()));

    let existing_changes = history.history.len().saturating_sub(1);
    let added_changes = additions.len() - usize::from(history.history.is_empty());
    if existing_changes.saturating_add(added_changes) > max_snapshots {
        return false;
    }

    history.history.extend(additions);
    true
}

pub async fn delete_config_history(
    State(state): State<AppState>, Query(request): Query<DeleteConfigHistory>,
) -> impl IntoResponse {
    if !supports_history(&request.file) {
        return error(
            "Change history supports YAML and JSON files only",
            StatusCode::BAD_REQUEST,
        )
        .into_response();
    }
    if let Err(message) = check_access(&request.file, &state) {
        return error(message, StatusCode::FORBIDDEN).into_response();
    }

    let _guard = HISTORY_LOCK.lock().await;
    let path = history_path(&request.file);
    let mut history = match tokio::fs::read_to_string(&path).await {
        Ok(contents) => match serde_json::from_str::<ConfigHistory>(&contents) {
            Ok(history) if history.file == request.file => history,
            Ok(_) => return error("History file mismatch", StatusCode::CONFLICT).into_response(),
            Err(_) => return error("History data is corrupted", StatusCode::INTERNAL_SERVER_ERROR).into_response(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ConfigHistory {
            file: request.file,
            history: Vec::new(),
        },
        Err(_) => return error("Could not read config history", StatusCode::INTERNAL_SERVER_ERROR).into_response(),
    };

    if let Err(status) = delete_revision(&mut history, request.id.as_deref()) {
        return error("History entry not found", status).into_response();
    }

    if history.history.is_empty() {
        if let Err(e) = tokio::fs::remove_file(&path).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            return error(
                format!("Could not clear config history: {e}"),
                StatusCode::INTERNAL_SERVER_ERROR,
            )
            .into_response();
        }
    } else if let Err(e) = write_history(&path, &history).await {
        return error(
            format!("Could not save config history: {e}"),
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .into_response();
    }

    Json(serde_json::json!({ "success": true })).into_response()
}

fn delete_revision(history: &mut ConfigHistory, id: Option<&str>) -> Result<(), StatusCode> {
    if let Some(id) = id {
        let index = history
            .history
            .iter()
            .position(|revision| revision.id == id)
            .ok_or(StatusCode::NOT_FOUND)?;
        history.history.remove(index);
    } else {
        history.history.clear();
    }
    Ok(())
}

fn new_revision(content: String, date: String) -> ConfigRevision {
    ConfigRevision {
        id: format!("{}-{}", Utc::now().timestamp_millis(), uuid::Uuid::new_v4()),
        date,
        content,
    }
}

async fn write_history(path: &PathBuf, history: &ConfigHistory) -> std::io::Result<()> {
    tokio::fs::create_dir_all(HISTORY_DIR).await?;
    tokio::fs::set_permissions(HISTORY_DIR, std::fs::Permissions::from_mode(0o700)).await?;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    let contents = serde_json::to_vec(history).map_err(std::io::Error::other)?;
    tokio::fs::write(&temp, contents).await?;
    tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await?;
    if let Err(e) = tokio::fs::rename(&temp, path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ConfigHistory, ConfigRevision, append_snapshot, delete_revision};

    fn history() -> ConfigHistory {
        ConfigHistory {
            file: "/opt/etc/mihomo/config.yaml".into(),
            history: ["one", "two", "three"]
                .into_iter()
                .map(|id| ConfigRevision {
                    id: id.into(),
                    date: String::new(),
                    content: String::new(),
                })
                .collect(),
        }
    }

    #[test]
    fn delete_revision_removes_only_requested_entry() {
        let mut history = history();
        delete_revision(&mut history, Some("two")).unwrap();
        assert_eq!(
            history.history.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["one", "three"]
        );
    }

    #[test]
    fn delete_revision_without_id_clears_file_history() {
        let mut history = history();
        delete_revision(&mut history, None).unwrap();
        assert!(history.history.is_empty());
    }

    #[test]
    fn delete_revision_rejects_unknown_id() {
        let mut history = history();
        assert!(delete_revision(&mut history, Some("missing")).is_err());
        assert_eq!(history.history.len(), 3);
    }

    #[test]
    fn zero_limit_keeps_existing_history_and_does_not_append() {
        let mut history = history();
        let before = history.history.len();
        assert!(!append_snapshot(&mut history, 0, None, "four", "date"));
        assert_eq!(history.history.len(), before);
    }

    #[test]
    fn full_history_stops_recording_without_overwriting_old_entries() {
        let mut history = history();
        assert!(!append_snapshot(&mut history, 2, None, "four", "date"));
        assert_eq!(
            history.history.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["one", "two", "three"]
        );
    }

    #[test]
    fn cap_counts_changes_after_the_initial_baseline() {
        let mut history = ConfigHistory {
            file: String::new(),
            history: Vec::new(),
        };
        assert!(append_snapshot(&mut history, 1, Some("baseline"), "first", "date"));
        assert_eq!(
            history
                .history
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            ["baseline", "first"]
        );
        assert!(!append_snapshot(&mut history, 1, Some("first"), "second", "later"));
        assert_eq!(
            history
                .history
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            ["baseline", "first"]
        );
    }
}
