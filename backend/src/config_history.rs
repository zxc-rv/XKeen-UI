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
use similar::{ChangeTag, DiffTag, TextDiff};
use std::time::{SystemTime, UNIX_EPOCH};

const HISTORY_DIR: &str = "/opt/etc/xkeen/config-history";
static HISTORY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize, Serialize)]
struct ConfigRevision {
    id: String,
    date: String,
    content: String,
}

#[derive(Deserialize, Serialize)]
struct ConfigHistory {
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
pub struct DiffConfigChange {
    file: String,
    id: String,
    current_content: String,
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

    let snapshots = history
        .history
        .iter()
        .map(|revision| serde_json::json!({ "id": revision.id, "date": revision.date }))
        .collect::<Vec<_>>();

    Json(serde_json::json!({ "success": true, "history": snapshots })).into_response()
}

pub async fn post_config_history_diff(
    State(state): State<AppState>, Json(request): Json<DiffConfigChange>,
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

    let history = {
        let _guard = HISTORY_LOCK.lock().await;
        read_history(&request.file).await
    };
    let history = match history {
        Ok(history) => history.history,
        Err(status) => return error("Could not read config history", status).into_response(),
    };
    let Some(index) = history.iter().position(|revision| revision.id == request.id) else {
        return error("History entry not found", StatusCode::NOT_FOUND).into_response();
    };

    let snapshot = &history[index].content;

    Json(serde_json::json!({
        "success": true,
        "rows": build_rows(snapshot, &request.current_content),
        "content": snapshot,
    }))
    .into_response()
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
        return Json(serde_json::json!({ "success": true })).into_response();
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

/// Keep the newest configured number of previous versions.
fn append_snapshot(
    history: &mut ConfigHistory, max_snapshots: usize, previous_content: Option<&str>, content: &str, date: &str,
) -> bool {
    let Some(previous) = previous_content.filter(|previous| *previous != content) else {
        return false;
    };
    if max_snapshots == 0 || history.history.last().is_some_and(|last| last.content == previous) {
        return false;
    }
    history.history.push(new_revision(previous.to_string(), date.to_string()));
    if history.history.len() > max_snapshots {
        let remove = history.history.len() - max_snapshots;
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
        if tokio::fs::try_exists(&snapshot_path).await.unwrap_or(false) {
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
    let mut history = ConfigHistory { history: Vec::new() };
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

const DIFF_CONTEXT: usize = 3;
const INLINE_SIMILARITY: f32 = 0.5;

#[derive(Serialize)]
struct DiffSegment {
    text: String,
    emphasized: bool,
}

#[derive(Serialize)]
struct DiffCell {
    line: usize,
    segments: Vec<DiffSegment>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DiffRow {
    Equal { left_line: usize, right_line: usize, text: String },
    Change { left: Option<DiffCell>, right: Option<DiffCell> },
    Skipped { count: usize },
}

fn line_text(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

fn plain_cell(line: usize, text: &str) -> DiffCell {
    DiffCell {
        line,
        segments: vec![DiffSegment {
            text: text.to_string(),
            emphasized: false,
        }],
    }
}

fn push_segment(segments: &mut Vec<DiffSegment>, text: &str, emphasized: bool) {
    match segments.last_mut() {
        Some(last) if last.emphasized == emphasized => last.text.push_str(text),
        _ => segments.push(DiffSegment {
            text: text.to_string(),
            emphasized,
        }),
    }
}

fn inline_cells(left_line: usize, left: &str, right_line: usize, right: &str) -> (DiffCell, DiffCell) {
    let diff = TextDiff::from_chars(left, right);
    if diff.ratio() < INLINE_SIMILARITY {
        return (plain_cell(left_line, left), plain_cell(right_line, right));
    }
    let mut left_segments = Vec::new();
    let mut right_segments = Vec::new();
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                push_segment(&mut left_segments, change.value(), false);
                push_segment(&mut right_segments, change.value(), false);
            }
            ChangeTag::Delete => push_segment(&mut left_segments, change.value(), true),
            ChangeTag::Insert => push_segment(&mut right_segments, change.value(), true),
        }
    }
    (
        DiffCell { line: left_line, segments: left_segments },
        DiffCell { line: right_line, segments: right_segments },
    )
}

fn build_rows(before: &str, after: &str) -> Vec<DiffRow> {
    let diff = TextDiff::from_lines(before, after);
    let operations = diff.ops();
    if operations.iter().all(|operation| operation.tag() == DiffTag::Equal) {
        return Vec::new();
    }
    let old_line = |index: usize| line_text(diff.old_slice(index).unwrap_or_default());
    let new_line = |index: usize| line_text(diff.new_slice(index).unwrap_or_default());
    let mut rows = Vec::new();
    for (index, operation) in operations.iter().enumerate() {
        let (tag, old_range, new_range) = operation.as_tag_tuple();
        if tag == DiffTag::Equal {
            let length = old_range.len();
            let head = if index == 0 { 0 } else { DIFF_CONTEXT };
            let tail = if index + 1 == operations.len() { 0 } else { DIFF_CONTEXT };
            let visible = |offset: usize| DiffRow::Equal {
                left_line: old_range.start + offset + 1,
                right_line: new_range.start + offset + 1,
                text: old_line(old_range.start + offset).to_string(),
            };
            if length <= head + tail + 1 {
                rows.extend((0..length).map(&visible));
            } else {
                rows.extend((0..head).map(&visible));
                rows.push(DiffRow::Skipped { count: length - head - tail });
                rows.extend((length - tail..length).map(&visible));
            }
            continue;
        }
        for offset in 0..old_range.len().max(new_range.len()) {
            let old_index = old_range.start + offset;
            let new_index = new_range.start + offset;
            let old = (offset < old_range.len()).then(|| (old_index + 1, old_line(old_index)));
            let new = (offset < new_range.len()).then(|| (new_index + 1, new_line(new_index)));
            rows.push(match (old, new) {
                (Some((left_line, left)), Some((right_line, right))) => {
                    let (left, right) = inline_cells(left_line, left, right_line, right);
                    DiffRow::Change { left: Some(left), right: Some(right) }
                }
                (old, new) => DiffRow::Change {
                    left: old.map(|(line, text)| plain_cell(line, text)),
                    right: new.map(|(line, text)| plain_cell(line, text)),
                },
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::{ConfigHistory, ConfigRevision, append_snapshot, build_rows, delete_revision, sort_history, write_history};

    fn history() -> ConfigHistory {
        ConfigHistory {
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
        assert!(!append_snapshot(&mut history, 0, Some("old"), "four", "date"));
        assert_eq!(history.history.len(), before);
    }

    #[test]
    fn nothing_is_recorded_without_a_new_previous_version() {
        let mut history = history();
        assert!(!append_snapshot(&mut history, 5, None, "new", "date"));
        assert!(!append_snapshot(&mut history, 5, Some("new"), "new", "date"));
        assert!(!append_snapshot(&mut history, 5, Some("three"), "new", "date"));
        assert_eq!(history.history.len(), 3);
    }

    #[test]
    fn full_history_records_new_change_and_discards_oldest_change() {
        let mut history = history();
        assert!(append_snapshot(&mut history, 3, Some("four"), "five", "date"));
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
    fn only_previous_versions_are_kept_up_to_the_limit() {
        let mut history = ConfigHistory {
            history: Vec::new(),
        };
        for (previous, content) in [("a", "b"), ("b", "c"), ("c", "d")] {
            assert!(append_snapshot(&mut history, 2, Some(previous), content, "date"));
        }
        assert_eq!(
            history
                .history
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            ["b", "c"]
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
        assert!(append_snapshot(&mut history, 3, Some("four"), "five", &date));
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

    #[test]
    fn identical_contents_have_no_rows() {
        assert!(build_rows("a\nb\n", "a\nb\n").is_empty());
    }

    #[test]
    fn replaced_line_pairs_left_with_right() {
        let json = serde_json::to_value(build_rows("port: 7890\nmode: rule\n", "port: 7891\nmode: rule\n")).unwrap();
        assert_eq!(json[0]["type"], "change");
        assert_eq!(json[0]["left"]["line"], 1);
        assert_eq!(json[0]["left"]["segments"][1]["text"], "0");
        assert_eq!(json[0]["left"]["segments"][1]["emphasized"], true);
        assert_eq!(json[0]["right"]["segments"][1]["text"], "1");
        assert_eq!(json[1]["type"], "equal");
        assert_eq!(json[1]["text"], "mode: rule");
    }

    #[test]
    fn indentation_is_preserved() {
        let json = serde_json::to_value(build_rows("a:\n  b: 1\n", "a:\n  b: 2\n")).unwrap();
        assert_eq!(json[1]["left"]["segments"][0]["text"], "  b: ");
    }

    #[test]
    fn removed_whitespace_is_emphasized() {
        let json = serde_json::to_value(build_rows("a:  1\n", "a: 1\n")).unwrap();
        let left = json[0]["left"]["segments"].as_array().unwrap();
        let right = json[0]["right"]["segments"].as_array().unwrap();
        assert!(left.iter().any(|segment| segment["emphasized"] == true && segment["text"] == " "));
        assert!(right.iter().all(|segment| segment["emphasized"] == false));
    }

    #[test]
    fn long_equal_runs_are_collapsed() {
        let current = (1..=20).map(|index| format!("line {index}\n")).collect::<String>();
        let snapshot = current.replace("line 10\n", "changed\n");
        let json = serde_json::to_value(build_rows(&current, &snapshot)).unwrap();
        let rows = json.as_array().unwrap();
        let skipped = rows
            .iter()
            .filter(|row| row["type"] == "skipped")
            .map(|row| row["count"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(skipped, [6, 7]);
        assert_eq!(rows.len(), 9);
    }

    #[test]
    fn inserted_lines_have_one_sided_rows() {
        let json = serde_json::to_value(build_rows("a\nb\n", "a\nb\nc\n")).unwrap();
        let last = json.as_array().unwrap().last().unwrap();
        assert!(last["left"].is_null());
        assert_eq!(last["right"]["line"], 3);
    }
}
