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

const HISTORY_DIR: &str = "/opt/etc/xkeen/config-history";
const LEGACY_HISTORY_DIR: &str = "/opt/var/lib/xkeen-ui/config-history";
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

fn history_dir(file: &str) -> PathBuf {
    let key = format!("{:x}", md5::compute(file.as_bytes()));
    PathBuf::from(HISTORY_DIR).join(key)
}

fn legacy_history_path(file: &str) -> PathBuf {
    let key = format!("{:x}", md5::compute(file.as_bytes()));
    PathBuf::from(LEGACY_HISTORY_DIR).join(format!("{key}.json"))
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
    let history = match read_history(&request.file).await {
        Ok(history) => history,
        Err(status) => return error("Could not read config history", status).into_response(),
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

    let max_snapshots = state.settings.read().unwrap().config_history.max_snapshots;
    if max_snapshots == 0 {
        return Json(serde_json::json!({ "success": true, "disabled": true })).into_response();
    }

    let _guard = HISTORY_LOCK.lock().await;
    let path = history_dir(&request.file);
    let mut history = match read_history(&request.file).await {
        Ok(history) => history,
        Err(status) => return error("Could not read config history", status).into_response(),
    };

    let date = valid_date(&request.date);
    if !append_snapshot(
        &mut history,
        max_snapshots,
        request.previous_content.as_deref(),
        &request.content,
        &date,
    ) {
        if let Some(last) = history.history.last().filter(|last| last.content == request.content) {
            return Json(serde_json::json!({ "success": true, "id": last.id })).into_response();
        }
        return Json(serde_json::json!({ "success": true, "disabled": max_snapshots == 0 })).into_response();
    }
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

/// Keep the newest configured number of changes plus one comparison baseline.
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
        let previous_date = DateTime::parse_from_rfc3339(date)
            .map(|parsed| {
                (parsed - chrono::Duration::milliseconds(1))
                    .with_timezone(&Utc)
                    .to_rfc3339()
            })
            .unwrap_or_else(|_| date.to_string());
        additions.push(new_revision(previous.to_string(), previous_date));
    }
    additions.push(new_revision(content.to_string(), date.to_string()));

    history.history.extend(additions);
    let keep = max_snapshots.saturating_add(1);
    if history.history.len() > keep {
        let remove = history.history.len() - keep;
        history.history.drain(..remove);
    }
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
    let path = history_dir(&request.file);
    let mut history = match read_history(&request.file).await {
        Ok(history) => history,
        Err(status) => return error("Could not read config history", status).into_response(),
    };

    if let Err(status) = delete_revision(&mut history, request.id.as_deref()) {
        return error("History entry not found", status).into_response();
    }

    if history.history.is_empty() {
        if let Err(e) = tokio::fs::remove_dir_all(&path).await
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
    tokio::fs::create_dir_all(path).await?;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;

    let mut keep = Vec::with_capacity(history.history.len());
    for revision in &history.history {
        let date_ms = DateTime::parse_from_rfc3339(&revision.date)
            .map(|date| date.timestamp_millis())
            .unwrap_or_else(|_| Utc::now().timestamp_millis());
        let snapshot_path = path.join(format!("{}__{}.snapshot", revision.id, date_ms));
        keep.push(snapshot_path.clone());
        if let Ok(existing) = tokio::fs::read_to_string(&snapshot_path).await
            && existing == revision.content
        {
            continue;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp = path.join(format!(".tmp-{}-{nonce}", std::process::id()));
        tokio::fs::write(&temp, revision.content.as_bytes()).await?;
        tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await?;
        if let Err(e) = tokio::fs::rename(&temp, &snapshot_path).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(e);
        }
    }

    let mut entries = tokio::fs::read_dir(path).await?;
    while let Some(entry) = entries.next_entry().await? {
        let entry_path = entry.path();
        if entry_path.extension().is_some_and(|extension| extension == "snapshot")
            && !keep.iter().any(|kept| kept == &entry_path)
        {
            tokio::fs::remove_file(entry_path).await?;
        }
    }
    Ok(())
}

async fn read_history(file: &str) -> Result<ConfigHistory, StatusCode> {
    let directory = history_dir(file);
    let mut history = ConfigHistory {
        file: file.to_string(),
        history: Vec::new(),
    };
    match tokio::fs::read_dir(&directory).await {
        Ok(mut entries) => {
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            {
                let path = entry.path();
                if !path.extension().is_some_and(|extension| extension == "snapshot") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                    continue;
                };
                let Some((id, timestamp)) = stem.rsplit_once("__") else {
                    continue;
                };
                let Ok(timestamp) = timestamp.parse::<i64>() else {
                    continue;
                };
                let content = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
                let date = DateTime::<Utc>::from_timestamp_millis(timestamp)
                    .unwrap_or_else(Utc::now)
                    .to_rfc3339();
                history.history.push(ConfigRevision {
                    id: id.to_string(),
                    date,
                    content,
                });
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
    sort_history(&mut history);
    let legacy_path = legacy_history_path(file);
    match tokio::fs::read_to_string(&legacy_path).await {
        Ok(contents) => {
            let legacy = serde_json::from_str::<ConfigHistory>(&contents)
                .ok()
                .filter(|history| history.file == file)
                .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
            for revision in legacy.history {
                if !history.history.iter().any(|existing| existing.id == revision.id) {
                    history.history.push(revision);
                }
            }
            sort_history(&mut history);
            write_history(&directory, &history)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            tokio::fs::remove_file(legacy_path)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
    Ok(history)
}

fn sort_history(history: &mut ConfigHistory) {
    history.history.sort_by(|left, right| {
        let left_date = DateTime::parse_from_rfc3339(&left.date)
            .map(|date| date.timestamp_millis())
            .unwrap_or_default();
        let right_date = DateTime::parse_from_rfc3339(&right.date)
            .map(|date| date.timestamp_millis())
            .unwrap_or_default();
        left_date.cmp(&right_date).then_with(|| left.id.cmp(&right.id))
    });
}

#[cfg(test)]
mod tests {
    use super::{ConfigHistory, ConfigRevision, append_snapshot, delete_revision, sort_history, write_history};

    fn history() -> ConfigHistory {
        ConfigHistory {
            file: "/opt/etc/mihomo/config.yaml".into(),
            history: ["one", "two", "three"]
                .into_iter()
                .map(|id| ConfigRevision {
                    id: id.into(),
                    date: String::new(),
                    content: id.into(),
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
    fn sort_history_orders_oldest_first_and_newest_last() {
        let mut history = ConfigHistory {
            file: "/opt/etc/mihomo/config.yaml".into(),
            history: [
                ("new", "2026-11-09T20:02:00Z"),
                ("old", "2026-11-09T19:58:00Z"),
                ("middle", "2026-11-09T20:00:00Z"),
            ]
            .into_iter()
            .map(|(id, date)| ConfigRevision {
                id: id.into(),
                date: date.into(),
                content: id.into(),
            })
            .collect(),
        };

        sort_history(&mut history);

        assert_eq!(
            history
                .history
                .iter()
                .map(|revision| revision.id.as_str())
                .collect::<Vec<_>>(),
            ["old", "middle", "new"]
        );
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
    fn full_history_records_new_change_and_discards_oldest_change() {
        let mut history = history();
        assert!(append_snapshot(&mut history, 2, None, "four", "date"));
        assert_eq!(
            history
                .history
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            ["two", "three", "four"]
        );
    }

    #[test]
    fn retention_keeps_the_previous_snapshot_and_latest_change() {
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
        assert!(append_snapshot(&mut history, 1, Some("first"), "second", "later"));
        assert_eq!(
            history
                .history
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
    }

    #[tokio::test]
    async fn snapshots_are_plain_text_files_and_pruned_files_are_removed() {
        let directory = std::env::temp_dir().join(format!("xkeen-history-{}", uuid::Uuid::new_v4()));
        let mut history = history();
        for revision in &mut history.history {
            revision.date = chrono::Utc::now().to_rfc3339();
        }
        let date = chrono::Utc::now().to_rfc3339();
        assert!(append_snapshot(&mut history, 2, None, "four", &date));
        assert_eq!(
            history
                .history
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            ["two", "three", "four"]
        );
        write_history(&directory, &history).await.unwrap();

        let entries = std::fs::read_dir(&directory)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().all(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "snapshot")
        }));
        assert!(
            !entries
                .iter()
                .any(|entry| entry.file_name().to_string_lossy().starts_with("one__"))
        );
        let newest_prefix = format!("{}__", history.history.last().unwrap().id);
        let newest = entries
            .iter()
            .find(|entry| entry.file_name().to_string_lossy().starts_with(&newest_prefix))
            .unwrap();
        assert_eq!(std::fs::read_to_string(newest.path()).unwrap(), "four");

        history.history.remove(0);
        write_history(&directory, &history).await.unwrap();
        let remaining = std::fs::read_dir(&directory)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(remaining.len(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
