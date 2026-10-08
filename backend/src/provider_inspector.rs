use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::path::Path;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use crate::types::{ApiResponse, MIHOMO_CONF_DIR};

const MIHOMO_CONFIG_PATH: &str = "/opt/etc/mihomo/config.yaml";
const RULE_PROVIDERS: &str = "rule-providers";
const PROXY_PROVIDERS: &str = "proxy-providers";
const MAX_PROVIDER_FILE_BYTES: usize = 10 * 1024 * 1024;

static MIHOMO_YAML_CACHE: LazyLock<RwLock<Option<(SystemTime, Arc<Vec<Yaml>>)>>> = LazyLock::new(|| RwLock::new(None));

pub(crate) async fn load_mihomo_yaml() -> Result<Arc<Vec<Yaml>>, String> {
    let mtime = tokio::fs::metadata(MIHOMO_CONFIG_PATH)
        .await
        .and_then(|metadata| metadata.modified())
        .map_err(|e| format!("Ошибка чтения конфига: {e}"))?;

    let cached = MIHOMO_YAML_CACHE
        .read()
        .unwrap()
        .as_ref()
        .filter(|(cached_mtime, _)| *cached_mtime == mtime)
        .map(|(_, docs)| docs.clone());
    if let Some(docs) = cached {
        return Ok(docs);
    }

    let content = tokio::fs::read_to_string(MIHOMO_CONFIG_PATH)
        .await
        .map_err(|e| format!("Ошибка чтения конфига: {e}"))?;
    let docs = Arc::new(YamlLoader::load_from_str(&content).map_err(|e| format!("Ошибка парсинга YAML: {e}"))?);
    *MIHOMO_YAML_CACHE.write().unwrap() = Some((mtime, docs.clone()));
    Ok(docs)
}

#[derive(Deserialize)]
pub struct ProviderQuery {
    pub name: String,
    #[serde(rename = "vehicleType")]
    pub vehicle_type: Option<String>,
    pub format: Option<String>,
    pub behavior: Option<String>,
}

impl ProviderQuery {
    fn is_vehicle(&self, expected: &str) -> bool {
        self.vehicle_type
            .as_deref()
            .is_some_and(|vehicle| vehicle.eq_ignore_ascii_case(expected))
    }

    fn is_mrs(&self) -> bool {
        self.format
            .as_deref()
            .is_some_and(|format| format.eq_ignore_ascii_case("mrs") || format.eq_ignore_ascii_case("mrsrule"))
    }
}

#[derive(Deserialize)]
pub struct SaveProviderRequest {
    pub content: String,
}

fn find_provider<'a>(docs: &'a [Yaml], section: &str, name: &str) -> Result<&'a Yaml, String> {
    let provider = &docs.first().ok_or("YAML пуст")?[section][name];
    if provider.is_badvalue() {
        return Err(format!("Провайдер '{name}' не найден"));
    }
    Ok(provider)
}

fn provider_file_path(provider: &Yaml, section: &str) -> Result<(String, bool), String> {
    if let Some(path) = provider["path"].as_str() {
        return Ok((resolve_provider_path(path), true));
    }
    let url = provider["url"].as_str().ok_or("В провайдере нет ни path, ни url")?;
    let subdirectory = if section == RULE_PROVIDERS { "rules" } else { "proxies" };
    Ok((format!("{MIHOMO_CONF_DIR}/{subdirectory}/{:x}", md5::compute(url)), false))
}

fn inline_payload(provider: &Yaml, section: &str) -> Option<String> {
    if section == PROXY_PROVIDERS {
        return proxies_payload_to_yaml(&provider["payload"]);
    }
    let items: Vec<&str> = provider["payload"].as_vec()?.iter().filter_map(Yaml::as_str).collect();
    (!items.is_empty()).then(|| items.join("\n"))
}

async fn read_provider(section: &str, query: &ProviderQuery) -> Result<String, String> {
    let docs = load_mihomo_yaml().await?;
    let provider = find_provider(&docs, section, &query.name)?;

    if query.is_vehicle("inline") {
        return inline_payload(provider, section).ok_or_else(|| "Payload пуст или не найден".into());
    }

    let (path, _) = provider_file_path(provider, section)?;
    if section == RULE_PROVIDERS && query.is_mrs() {
        return convert_mrs(&path, query.behavior.as_deref().unwrap_or("domain")).await;
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Не удалось прочитать файл {path}: {e}"))
}

async fn write_provider(section: &str, query: &ProviderQuery, content: &str) -> Result<(), String> {
    if !query.is_vehicle("file") {
        return Err("Только file-провайдеры доступны для редактирования".into());
    }
    if section == RULE_PROVIDERS && query.is_mrs() {
        return Err("MRS-провайдер нельзя редактировать".into());
    }

    let docs = load_mihomo_yaml().await?;
    let (path, has_explicit_path) = provider_file_path(find_provider(&docs, section, &query.name)?, section)?;
    if !has_explicit_path {
        return Err("У провайдера нет path — редактируется только file-провайдер".into());
    }
    write_provider_file(&path, content).await
}

async fn write_provider_file(path: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_PROVIDER_FILE_BYTES {
        return Err("Файл слишком большой (лимит 10 МБ)".into());
    }
    if let Some(parent) = Path::new(path).parent().filter(|parent| !parent.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Не удалось создать каталог {parent:?}: {e}"))?;
    }
    tokio::fs::write(path, content)
        .await
        .map_err(|e| format!("Не удалось записать файл {path}: {e}"))
}

pub async fn get_rule_providers_content(Query(query): Query<ProviderQuery>) -> Response {
    respond(read_provider(RULE_PROVIDERS, &query).await)
}

pub async fn get_proxy_provider_content(Query(query): Query<ProviderQuery>) -> Response {
    respond(read_provider(PROXY_PROVIDERS, &query).await)
}

pub async fn put_rule_providers_content(
    Query(query): Query<ProviderQuery>,
    Json(request): Json<SaveProviderRequest>,
) -> Response {
    respond(
        write_provider(RULE_PROVIDERS, &query, &request.content)
            .await
            .map(|()| String::new()),
    )
}

pub async fn put_proxy_provider_content(
    Query(query): Query<ProviderQuery>,
    Json(request): Json<SaveProviderRequest>,
) -> Response {
    respond(
        write_provider(PROXY_PROVIDERS, &query, &request.content)
            .await
            .map(|()| String::new()),
    )
}

fn proxies_payload_to_yaml(payload: &Yaml) -> Option<String> {
    let items = payload.as_vec().filter(|items| !items.is_empty())?;
    let mut root = yaml_rust2::yaml::Hash::new();
    root.insert(Yaml::String("proxies".into()), Yaml::Array(items.clone()));
    let mut content = String::new();
    YamlEmitter::new(&mut content).dump(&Yaml::Hash(root)).ok()?;
    Some(content.trim_start_matches("---\n").to_string())
}

pub(crate) async fn convert_mrs(mrs_path: &str, behavior: &str) -> Result<String, String> {
    if tokio::fs::metadata(mrs_path).await.is_err() {
        return Err(format!("MRS файл не найден: {mrs_path}"));
    }

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let tmp_path = format!("/tmp/convert-ruleset_{}_{nanos:x}", std::process::id());

    let output = Command::new("/opt/sbin/mihomo")
        .args(["convert-ruleset", &behavior.to_ascii_lowercase(), "mrs", mrs_path, &tmp_path])
        .output()
        .await
        .map_err(|e| format!("Ошибка запуска mihomo: {e}"))?;

    let result = if output.status.success() {
        tokio::fs::read_to_string(&tmp_path)
            .await
            .map_err(|e| format!("Ошибка чтения результата конвертации: {e}"))
    } else {
        Err(format!(
            "mihomo convert-ruleset упал с кодом {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    };

    let _ = tokio::fs::remove_file(&tmp_path).await;
    result
}

fn resolve_provider_path(path: &str) -> String {
    resolve_provider_path_in(path, MIHOMO_CONF_DIR)
}

pub(crate) fn resolve_provider_path_in(path: &str, base_dir: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", base_dir, path.trim_start_matches("./"))
    }
}

fn respond(result: Result<String, String>) -> Response {
    match result {
        Ok(content) => (
            StatusCode::OK,
            Json(ApiResponse {
                success: true,
                error: None,
                data: Some(serde_json::json!({ "content": content })),
            }),
        )
            .into_response(),
        Err(message) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::<()> {
                success: false,
                error: Some(message),
                data: None,
            }),
        )
            .into_response(),
    }
}
