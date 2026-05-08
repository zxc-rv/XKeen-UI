use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tokio::process::Command;
use yaml_rust2::YamlLoader;

use crate::types::{ApiResponse, AppState, MIHOMO_CONF};

#[derive(Deserialize)]
pub struct RuleContentQuery {
    pub name: String,
    pub format: Option<String>,
    pub behavior: Option<String>,
    #[serde(rename = "vehicleType")]
    pub vehicle_type: Option<String>,
}

pub async fn get_rule_provider_content(
    State(_state): State<AppState>,
    Query(params): Query<RuleContentQuery>,
) -> Response {
    let config = match tokio::fs::read_to_string("/opt/etc/mihomo/config.yaml").await {
        Ok(c) => c,
        Err(e) => return error_response(format!("Ошибка чтения конфига: {e}")),
    };

    let docs = match YamlLoader::load_from_str(&config) {
        Ok(v) => v,
        Err(e) => return error_response(format!("Ошибка парсинга YAML: {e}")),
    };
    let Some(parsed) = docs.first() else {
        return error_response("YAML пуст".into());
    };

    let provider = &parsed["rule-providers"][params.name.as_str()];
    if provider.is_badvalue() {
        return error_response(format!("Провайдер '{}' не найден", params.name));
    }

    // Без лишних выделений памяти чекаем INLINE
    if params
        .vehicle_type
        .as_deref()
        .is_some_and(|v| v.eq_ignore_ascii_case("inline"))
    {
        let items: Vec<&str> = provider["payload"]
            .as_vec()
            .map(|seq| seq.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();

        if items.is_empty() {
            return error_response("Payload пуст или не найден".into());
        }
        return ok_response(items.join("\n"));
    }

    let url = provider["url"].as_str();
    let path = provider["path"].as_str();

    let final_path = match path {
        Some(p) => resolve_provider_path(p),
        None => match url {
            // Вычисляем MD5 как нормальные пацаны, без спавна сабпроцессов
            Some(u) => format!("{}/rules/{:x}", MIHOMO_CONF, md5::compute(u)),
            None => return error_response("В провайдере нет ни path, ни url".into()),
        },
    };

    let is_mrs = params
        .format
        .as_deref()
        .is_some_and(|f| f.eq_ignore_ascii_case("mrs") || f.eq_ignore_ascii_case("mrsrule"));

    let content = if is_mrs {
        let behavior = params.behavior.as_deref().unwrap_or("domain");
        match convert_mrs(&final_path, behavior).await {
            Ok(c) => c,
            Err(e) => return error_response(e),
        }
    } else {
        match tokio::fs::read_to_string(&final_path).await {
            Ok(c) => c,
            Err(e) => {
                return error_response(format!("Не удалось прочитать файл {final_path}: {e}"));
            }
        }
    };

    ok_response(content)
}

async fn convert_mrs(mrs_path: &str, behavior: &str) -> Result<String, String> {
    if tokio::fs::metadata(mrs_path).await.is_err() {
        return Err(format!("MRS файл не найден: {mrs_path}"));
    }

    let behavior = behavior.to_ascii_lowercase();
    let tmp_path = format!("/opt/tmp/convert_{}", random_suffix());

    let output = Command::new("/opt/sbin/mihomo")
        .args([
            "convert-ruleset",
            behavior.as_str(),
            "mrs",
            mrs_path,
            &tmp_path,
        ])
        .output()
        .await
        .map_err(|e| format!("Ошибка запуска mihomo: {e}"))?;

    if !output.status.success() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "mihomo convert-ruleset упал с кодом {}: {}",
            output.status, stderr
        ));
    }

    let content = tokio::fs::read_to_string(&tmp_path)
        .await
        .map_err(|e| format!("Ошибка чтения результата конвертации: {e}"));

    let _ = tokio::fs::remove_file(&tmp_path).await;
    content
}

fn random_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:08x}", nanos ^ std::process::id().wrapping_shl(8))
}

fn resolve_provider_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", MIHOMO_CONF, path.trim_start_matches("./"))
    }
}

fn ok_response(content: String) -> Response {
    (
        StatusCode::OK,
        axum::Json(ApiResponse {
            success: true,
            error: None,
            data: Some(serde_json::json!({ "content": content })),
        }),
    )
        .into_response()
}

fn error_response(msg: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(ApiResponse::<()> {
            success: false,
            error: Some(msg),
            data: None,
        }),
    )
        .into_response()
}
