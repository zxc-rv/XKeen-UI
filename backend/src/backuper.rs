use crate::logger::log;
use crate::types::{APP_CONFIG, ApiResponse, AppState, MIHOMO_CONF, XKEEN_CONF, XRAY_CONF};
use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use chrono::{DateTime, FixedOffset, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;
use tar::{Archive, Builder};

const BACKUP_DIR: &str = "/opt/backups";
const BACKUP_SUFFIX: &str = "xkeen-ui.tar";
const CONTENT_ORDER: [&str; 4] = ["xkeen", "xkeen-ui", "xray", "mihomo"];

#[derive(Serialize)]
struct BackupListData {
    backups: Vec<BackupItem>,
}

#[derive(Serialize)]
struct BackupData {
    backup: BackupItem,
}

#[derive(Serialize, Clone)]
struct BackupItem {
    name: String,
    created_at: String,
    size: u64,
    content: BackupContentFiles,
}

#[derive(Serialize, Clone, Default)]
struct BackupContentFiles {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    xkeen: Vec<String>,
    #[serde(rename = "xkeen-ui", skip_serializing_if = "Vec::is_empty")]
    xkeen_ui: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    xray: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    mihomo: Vec<String>,
}

impl BackupContentFiles {
    fn insert(&mut self, key: &str, file: String) {
        match key {
            "xkeen" => self.xkeen.push(file),
            "xkeen-ui" => self.xkeen_ui.push(file),
            "xray" => self.xray.push(file),
            "mihomo" => self.mihomo.push(file),
            _ => unreachable!("unknown backup content: {key}"),
        }
    }

    fn sort(&mut self) {
        self.xkeen.sort();
        self.xkeen_ui.sort();
        self.xray.sort();
        self.mihomo.sort();
    }
}

#[derive(Deserialize)]
pub struct BackupReq {
    name: String,
    contents: Option<Vec<String>>,
}

async fn run_blocking<T: Serialize>(
    task: tokio::task::JoinHandle<Result<Option<T>, String>>, err_msg: &str,
) -> impl IntoResponse {
    match task.await {
        Ok(Ok(data)) => Json(ApiResponse {
            success: true,
            error: None,
            data,
        })
        .into_response(),
        Ok(Err(e)) => api_error(format!("{err_msg}: {e}")).into_response(),
        Err(e) => api_error(format!("{err_msg}: {e}")).into_response(),
    }
}

pub async fn get_backups(State(state): State<AppState>) -> impl IntoResponse {
    let tz = state.settings.read().unwrap().log.timezone;
    run_blocking(
        tokio::task::spawn_blocking(move || list_backups_sync(tz).map(|backups| Some(BackupListData { backups }))),
        "Не удалось получить список бэкапов",
    )
    .await
}

pub async fn put_backup(State(state): State<AppState>) -> impl IntoResponse {
    let tz = state.settings.read().unwrap().log.timezone;
    run_blocking(
        tokio::task::spawn_blocking(move || create_backup_sync(tz).map(|backup| Some(BackupData { backup }))),
        "Не удалось создать бэкап",
    )
    .await
}

pub async fn post_backup(Json(req): Json<BackupReq>) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || restore_backup_sync(&req.name, req.contents).map(|_| None::<()>)),
        "Не удалось восстановить бэкап",
    )
    .await
}

pub async fn delete_backup(Json(req): Json<BackupReq>) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || delete_backup_sync(&req.name).map(|_| None::<()>)),
        "Не удалось удалить бэкап",
    )
    .await
}

fn api_error(message: String) -> Json<ApiResponse<()>> {
    Json(ApiResponse {
        success: false,
        error: Some(message),
        data: None,
    })
}

fn list_backups_sync(tz: i32) -> Result<Vec<BackupItem>, String> {
    ensure_backup_dir().map_err(io_error)?;
    let entries = fs::read_dir(BACKUP_DIR).map_err(io_error)?;
    let mut backups = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_tar_file(&path) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(md) => md,
            Err(e) => {
                log(
                    "WARN",
                    format!("Не удалось прочитать метаданные {}: {}", path.display(), e),
                );
                continue;
            }
        };

        let content = match inspect_backup_content(&path) {
            Ok(res) => res,
            Err(e) => {
                log(
                    "WARN",
                    format!("Не удалось прочитать содержимое бэкапа {}: {}", path.display(), e),
                );
                BackupContentFiles::default()
            }
        };

        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };

        backups.push(BackupItem {
            name: name.to_string(),
            created_at: format_backup_date(name, metadata.modified().ok(), tz),
            size: metadata.len(),
            content,
        });
    }

    backups.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(backups)
}

fn create_backup_sync(tz: i32) -> Result<BackupItem, String> {
    ensure_backup_dir().map_err(io_error)?;
    let files = collect_backup_files().map_err(io_error)?;
    if files.is_empty() {
        return Err("не найдено ни одного файла для архивации".into());
    }

    let name = next_backup_name(tz);
    let final_path = Path::new(BACKUP_DIR).join(&name);
    let temp_path = final_path.with_extension("tar.tmp");
    let content = collect_backup_content(files.iter().map(|(_, rel)| rel.as_str()));

    let write_result = (|| -> io::Result<()> {
        let file = File::create(&temp_path)?;
        let mut builder = Builder::new(file);
        builder.follow_symlinks(true);
        for (source, relative) in &files {
            builder.append_path_with_name(source, relative)?;
        }
        builder.finish()?;
        let file = builder.into_inner()?;
        file.sync_all()?;
        fs::rename(&temp_path, &final_path)?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(io_error(error));
    }

    let metadata = fs::metadata(&final_path).map_err(io_error)?;
    log("INFO", format!("Бэкап конфигураций создан: {}", final_path.display()));

    Ok(BackupItem {
        name: name.clone(),
        created_at: format_backup_date(&name, metadata.modified().ok(), tz),
        size: metadata.len(),
        content,
    })
}

fn restore_backup_sync(name: &str, requested_contents: Option<Vec<String>>) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    let requested_contents = normalize_requested_contents(requested_contents)?;
    validate_backup_entries(&backup_path)?;

    let file = File::open(&backup_path).map_err(io_error)?;
    let mut archive = Archive::new(file);
    let entries = archive.entries().map_err(io_error)?;
    let mut restored_contents = HashSet::new();

    for entry in entries {
        let mut entry = entry.map_err(io_error)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }

        let entry_path = entry.path().map_err(io_error)?;
        let relative =
            normalize_entry_path(entry_path.as_ref()).map_err(|e| format!("невалидный путь в архиве: {e}"))?;
        let content = detect_content_key(&relative).ok_or_else(|| format!("недопустимый путь в архиве: {relative}"))?;

        if requested_contents
            .as_ref()
            .is_some_and(|contents| !contents.contains(content))
        {
            continue;
        }
        let target =
            archive_relative_to_target(&relative).ok_or_else(|| format!("недопустимый путь в архиве: {relative}"))?;

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }

        let mut output = File::create(&target).map_err(io_error)?;
        io::copy(&mut entry, &mut output).map_err(io_error)?;

        #[cfg(unix)]
        if let Ok(mode) = entry.header().mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
        }

        restored_contents.insert(content);
    }

    validate_restored_contents(&requested_contents, &restored_contents)?;
    log("INFO", restore_log_message(&backup_path, &requested_contents));
    Ok(())
}

fn delete_backup_sync(name: &str) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    fs::remove_file(&backup_path).map_err(io_error)?;
    log("INFO", format!("Бэкап конфигураций удалён: {}", backup_path.display()));
    Ok(())
}

fn ensure_backup_dir() -> io::Result<()> {
    fs::create_dir_all(BACKUP_DIR)
}

fn is_tar_file(path: &Path) -> bool {
    path.is_file() && is_backup_name(path.file_name().and_then(|v| v.to_str()))
}

fn collect_backup_files() -> io::Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    files.extend(collect_dir_files(XKEEN_CONF, &["lst", "json"])?);
    files.extend(collect_dir_files(XRAY_CONF, &["json"])?);
    files.extend(collect_dir_files(MIHOMO_CONF, &["yaml", "yml"])?);
    files.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(files)
}

fn collect_dir_files(dir: &str, exts: &[&str]) -> io::Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || !matches_extension(&path, exts) {
            continue;
        }
        files.push((path.clone(), to_archive_relative(&path)));
    }

    Ok(files)
}

fn matches_extension(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| exts.iter().any(|ext| v.eq_ignore_ascii_case(ext)))
}

fn to_archive_relative(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

fn resolve_backup_path(name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !is_backup_name(Some(name))
    {
        return Err("некорректное имя файла".into());
    }

    let path = Path::new(BACKUP_DIR).join(name);
    if !path.is_file() {
        return Err("файл не найден".into());
    }
    Ok(path)
}

fn inspect_backup_content(path: &Path) -> io::Result<BackupContentFiles> {
    let file = File::open(path)?;
    let mut archive = Archive::new(file);
    let mut content = BackupContentFiles::default();

    for entry in archive.entries()? {
        let entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let Ok(relative) = normalize_entry_path(&entry.path()?) else {
            continue;
        };
        if let Some(key) = detect_content_key(&relative) {
            content.insert(key, content_file_name(key, &relative));
        }
    }

    content.sort();
    Ok(content)
}

fn validate_backup_entries(path: &Path) -> Result<(), String> {
    let file = File::open(path).map_err(io_error)?;
    let mut archive = Archive::new(file);
    let entries = archive.entries().map_err(io_error)?;
    let mut seen = HashSet::new();
    let mut has_files = false;

    for entry in entries {
        let entry = entry.map_err(io_error)?;
        if !entry.header().entry_type().is_file() {
            return Err("архив содержит неподдерживаемые записи".into());
        }

        let entry_path = entry.path().map_err(io_error)?;
        let relative =
            normalize_entry_path(entry_path.as_ref()).map_err(|e| format!("невалидный путь в архиве: {e}"))?;
        if archive_relative_to_target(&relative).is_none() {
            return Err(format!("недопустимый путь в архиве: {relative}"));
        }
        if !seen.insert(relative) {
            return Err("архив содержит дубликаты файлов".into());
        }
        has_files = true;
    }

    if !has_files {
        return Err("архив пустой".into());
    }

    Ok(())
}

fn normalize_entry_path(path: &Path) -> Result<String, &'static str> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            _ => return Err("обнаружен запрещённый компонент пути"),
        }
    }
    if parts.is_empty() {
        return Err("путь пустой");
    }
    Ok(parts.join("/"))
}

fn archive_relative_to_target(relative: &str) -> Option<PathBuf> {
    detect_content_key(relative).map(|_| PathBuf::from(format!("/{relative}")))
}

fn detect_content_key(relative: &str) -> Option<&'static str> {
    if relative == APP_CONFIG.trim_start_matches('/') {
        return Some("xkeen-ui");
    }

    let check_prefix = |prefix: &str, exts: &[&str]| {
        relative
            .strip_prefix(prefix.trim_start_matches('/'))
            .map(|rest| rest.trim_start_matches('/'))
            .filter(|name| !name.contains('/') && matches_file_name(name, exts))
    };

    if check_prefix(XKEEN_CONF, &["lst", "json"]).is_some() {
        return Some("xkeen");
    }
    if check_prefix(XRAY_CONF, &["json"]).is_some() {
        return Some("xray");
    }
    if check_prefix(MIHOMO_CONF, &["yaml", "yml"]).is_some() {
        return Some("mihomo");
    }

    None
}

fn matches_file_name(name: &str, exts: &[&str]) -> bool {
    Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| exts.iter().any(|ext| v.eq_ignore_ascii_case(ext)))
}

fn normalize_requested_contents(
    requested_contents: Option<Vec<String>>,
) -> Result<Option<HashSet<&'static str>>, String> {
    let Some(requested_contents) = requested_contents else {
        return Ok(None);
    };
    if requested_contents.is_empty() {
        return Err("не указаны категории для восстановления".into());
    }

    let mut contents = HashSet::new();
    for content in requested_contents {
        let Some(content) = parse_content_key(&content) else {
            return Err(format!("неизвестная категория: {content}"));
        };
        contents.insert(content);
    }

    Ok(Some(contents))
}

fn parse_content_key(value: &str) -> Option<&'static str> {
    CONTENT_ORDER.iter().copied().find(|&content| content == value)
}

fn validate_restored_contents(
    requested_contents: &Option<HashSet<&'static str>>, restored_contents: &HashSet<&'static str>,
) -> Result<(), String> {
    let Some(requested_contents) = requested_contents else {
        return Ok(());
    };

    let missing = CONTENT_ORDER
        .iter()
        .copied()
        .filter(|&content| requested_contents.contains(content) && !restored_contents.contains(content))
        .map(content_label)
        .collect::<Vec<_>>();

    if missing.is_empty() {
        return Ok(());
    }

    Err(format!("в архиве не найдены категории: {}", missing.join(", ")))
}

fn collect_backup_content<'a>(paths: impl Iterator<Item = &'a str>) -> BackupContentFiles {
    let mut content = BackupContentFiles::default();
    for path in paths {
        if let Some(key) = detect_content_key(path) {
            content.insert(key, content_file_name(key, path));
        }
    }
    content.sort();
    content
}

fn content_label(content: &str) -> &'static str {
    match content {
        "xkeen" => "XKeen",
        "xkeen-ui" => "XKeen UI",
        "xray" => "Xray",
        "mihomo" => "Mihomo",
        _ => unreachable!("unknown backup content: {content}"),
    }
}

fn content_file_name(key: &str, relative: &str) -> String {
    match key {
        "xkeen" => strip_content_prefix(relative, XKEEN_CONF),
        "xray" => strip_content_prefix(relative, XRAY_CONF),
        "mihomo" => strip_content_prefix(relative, MIHOMO_CONF),
        "xkeen-ui" => Path::new(relative)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or(relative)
            .to_string(),
        _ => relative.to_string(),
    }
}

fn strip_content_prefix(relative: &str, root: &str) -> String {
    relative
        .strip_prefix(root.trim_start_matches('/'))
        .map(|rest| rest.trim_start_matches('/'))
        .unwrap_or(relative)
        .to_string()
}

fn restore_log_message(backup_path: &Path, requested_contents: &Option<HashSet<&'static str>>) -> String {
    let Some(requested_contents) = requested_contents else {
        return format!("Конфигурации восстановлены из {}", backup_path.display());
    };

    let contents = CONTENT_ORDER
        .iter()
        .copied()
        .filter(|&content| requested_contents.contains(content))
        .map(content_label)
        .collect::<Vec<_>>()
        .join(", ");

    format!("Конфигурации {} восстановлены из {}", contents, backup_path.display())
}

fn next_backup_name(tz: i32) -> String {
    let base = backup_now(tz).format("%Y-%m-%d_%H-%M-%S").to_string();
    let mut name = format!("{base}_{BACKUP_SUFFIX}");
    let mut index = 2;
    while Path::new(BACKUP_DIR).join(&name).exists() {
        name = format!("{base}_{index}_{BACKUP_SUFFIX}");
        index += 1;
    }
    name
}

fn format_backup_date(name: &str, modified: Option<SystemTime>, tz: i32) -> String {
    let stamp: String = name.chars().take(19).collect();
    if let Ok(parsed) = NaiveDateTime::parse_from_str(&stamp, "%Y-%m-%d_%H-%M-%S") {
        return parsed.format("%d.%m.%Y %H:%M:%S").to_string();
    }
    modified
        .map(DateTime::<Utc>::from)
        .map(|v| v.with_timezone(&backup_offset(tz)))
        .map(|v| v.format("%d.%m.%Y %H:%M:%S").to_string())
        .unwrap_or_else(|| name.to_string())
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

fn is_backup_name(name: Option<&str>) -> bool {
    name.is_some_and(|v| v.ends_with(BACKUP_SUFFIX))
}

fn backup_now(tz: i32) -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&backup_offset(tz))
}

fn backup_offset(tz: i32) -> FixedOffset {
    FixedOffset::east_opt(tz.clamp(-12, 14) * 3600).unwrap()
}
