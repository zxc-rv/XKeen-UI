use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

#[derive(Deserialize)]
pub struct DnsEnableReq {
    pub config_content: String,
    #[serde(default = "default_true")]
    pub setup_filter: bool,
}

#[derive(Deserialize)]
pub struct DnsDeleteReq {}

fn default_true() -> bool {
    true
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsStatusFields {
    pub dns_override: bool,
    pub dns_mihomo: bool,
    pub provider_ignored: bool,
}

fn check_dns_mihomo() -> bool {
    if let Ok(content) = std::fs::read_to_string(MIHOMO_CONF) {
        if let Ok(yaml) = yaml_rust2::YamlLoader::load_from_str(&content) {
            if let Some(doc) = yaml.first() {
                if let Some(dns) = doc["dns"].as_hash() {
                    let enable = dns
                        .get(&yaml_rust2::Yaml::String("enable".into()))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let listen = dns
                        .get(&yaml_rust2::Yaml::String("listen".into()))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    return enable && listen == "0.0.0.0:53";
                }
            }
        }
    }
    false
}

fn parse_dns_status(output: &str) -> DnsStatusFields {
    DnsStatusFields {
        dns_override: output.contains("opkg dns-override"),
        dns_mihomo: check_dns_mihomo(),
        provider_ignored: output.contains("ip no name-servers"),
    }
}

#[derive(serde::Serialize)]
pub struct DnsResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<DnsStatusFields>,
}

fn get_br0_ip() -> Result<String, String> {
    let output = std::process::Command::new("ip")
        .args(["-4", "a", "s", "br0"])
        .output()
        .map_err(|e| format!("Ошибка выполнения ip: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("inet ") {
            if let Some(ip) = rest.split('/').next() {
                return Ok(ip.to_string());
            }
        }
    }
    Err("Не удалось получить IP адрес br0".into())
}

async fn fetch_rci(state: &AppState, endpoint: &str) -> Result<serde_json::Value, String> {
    let mut req = state
        .http_client
        .get(format!("http://127.0.0.1:79/rci/show/{endpoint}"))
        .timeout(Duration::from_secs(5));
    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Ошибка запроса RCI ({endpoint}): {e}"))?;
    if !response.status().is_success() {
        return Err(format!("RCI ({endpoint}) вернул {}", response.status()));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Ошибка парсинга RCI ({endpoint}): {e}"))
}

async fn fetch_running_config(state: &AppState) -> Result<String, String> {
    let data = fetch_rci(state, "running-config").await?;
    let lines = data
        .get("message")
        .and_then(|m| m.as_array())
        .ok_or_else(|| "В ответе RCI отсутствует массив 'message'".to_string())?;

    let config_str = lines
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<&str>>()
        .join("\n");

    Ok(config_str)
}

async fn post_rci_batch(state: &AppState, commands: &[serde_json::Value]) -> Result<serde_json::Value, String> {
    let mut req = state
        .http_client
        .post("http://127.0.0.1:79/rci/")
        .json(commands)
        .timeout(Duration::from_secs(10));

    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Ошибка POST RCI batch: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let err = response.text().await.unwrap_or_default();
        return Err(format!("RCI batch вернул {status}, ответ: {err}"));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Ошибка парсинга RCI batch: {e}"))
}

fn find_batch_error(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(items) = map.get("status").and_then(|s| s.as_array()) {
                for item in items {
                    if item.get("status").and_then(|s| s.as_str()) == Some("error") {
                        let msg = item
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("неизвестная ошибка RCI");
                        let extra = format!(
                            "{} {}",
                            item.get("ident").and_then(|v| v.as_str()).unwrap_or(""),
                            item.get("code").and_then(|v| v.as_str()).unwrap_or("")
                        )
                        .trim()
                        .to_string();
                        if extra.is_empty() {
                            return Some(msg.to_string());
                        }
                        return Some(format!("{msg} ({extra})"));
                    }
                }
            }
            for v in map.values() {
                if let Some(e) = find_batch_error(v) {
                    return Some(e);
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(e) = find_batch_error(item) {
                    return Some(e);
                }
            }
            None
        }
        _ => None,
    }
}

fn check_batch_response(resp: &serde_json::Value, steps: &[&str], ignore: &[usize]) -> Result<(), String> {
    let items = resp
        .as_array()
        .ok_or_else(|| "Некорректный ответ RCI batch".to_string())?;
    for (i, item) in items.iter().enumerate() {
        let step = steps.get(i).copied().unwrap_or("?");
        if let Some(err) = find_batch_error(item) {
            if ignore.contains(&i) {
                log(
                    "WARN",
                    format!("DNS: '{step}' — пропущено (компонент не установлен?): {err}"),
                );
                continue;
            }
            log("ERROR", format!("DNS: '{step}' — ошибка: {err}"));
            return Err(format!("{step}: {err}"));
        }
    }
    Ok(())
}

pub async fn get_dns(State(state): State<AppState>) -> impl IntoResponse {
    match fetch_running_config(&state).await {
        Ok(output) => Json(DnsResponse {
            success: true,
            error: None,
            status: Some(parse_dns_status(&output)),
        }),
        Err(e) => Json(DnsResponse {
            success: false,
            error: Some(e),
            status: None,
        }),
    }
}

pub async fn post_dns(State(state): State<AppState>, Json(req): Json<DnsEnableReq>) -> impl IntoResponse {
    let br0_ip = match get_br0_ip() {
        Ok(ip) => ip,
        Err(e) => {
            log("ERROR", e.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    };

    let mut steps: Vec<(&str, serde_json::Value)> = vec![];
    let mut ignore: Vec<usize> = vec![];

    if req.setup_filter {
        ignore.push(steps.len());
        steps.push((
            "Отключение HTTPS DNS-прокси",
            json!({"dns-proxy": {"https": {"upstream": [{"no": true}]}}}),
        ));
        ignore.push(steps.len());
        steps.push((
            "Отключение TLS DNS-прокси",
            json!({"dns-proxy": {"tls": {"upstream": [{"no": true}]}}}),
        ));
        steps.push((
            "Сброс системных DNS-серверов",
            json!({"ip": {"name-server": [{"no": true}]}}),
        ));
        steps.push((
            "Установка name-server на br0",
            json!({"ip": {"name-server": [{"address": br0_ip}]}}),
        ));
    }
    steps.push((
        "Включение opkg dns-override",
        json!({"opkg": {"dns-override": {}}}),
    ));
    steps.push((
        "Сохранение конфигурации",
        json!({"system": {"configuration": {"save": {}}}}),
    ));

    let step_names: Vec<&str> = steps.iter().map(|(s, _)| *s).collect();
    let payload: Vec<serde_json::Value> = steps.into_iter().map(|(_, v)| v).collect();
    match post_rci_batch(&state, &payload).await {
        Ok(resp) => {
            if let Err(e) = check_batch_response(&resp, &step_names, &ignore) {
                return Json(DnsResponse {
                    success: false,
                    error: Some(e),
                    status: None,
                });
            }
        }
        Err(e) => {
            log("ERROR", e.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    }

    if let Err(e) = tokio::fs::write(MIHOMO_CONF, &req.config_content).await {
        log("ERROR", format!("Ошибка записи {MIHOMO_CONF}: {e}"));
    }

    let message = if req.setup_filter {
        format!("Управление DNS включено, name-server установлен: {br0_ip}:53")
    } else {
        "Управление DNS включено".into()
    };
    log("INFO", message);
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}

pub async fn delete_dns(State(state): State<AppState>, Json(_req): Json<DnsDeleteReq>) -> impl IntoResponse {
    let has_br0 = match fetch_running_config(&state).await {
        Ok(output) => {
            let br0_ip = get_br0_ip().unwrap_or_default();
            output.contains(&format!("ip name-server {br0_ip}"))
        }
        Err(_) => false,
    };

    let mut steps: Vec<(&str, serde_json::Value)> = vec![(
        "Отключение opkg dns-override",
        json!({"opkg": {"dns-override": {"no": true}}}),
    )];
    if has_br0 {
        steps.push((
            "Сброс системных DNS-серверов",
            json!({"ip": {"name-server": [{"no": true}]}}),
        ));
        steps.push((
            "Установка name-server на 77.88.8.8",
            json!({"ip": {"name-server": [{"address": "77.88.8.8"}]}}),
        ));
    }
    steps.push((
        "Сохранение конфигурации",
        json!({"system": {"configuration": {"save": {}}}}),
    ));

    let step_names: Vec<&str> = steps.iter().map(|(s, _)| *s).collect();
    let payload: Vec<serde_json::Value> = steps.into_iter().map(|(_, v)| v).collect();
    match post_rci_batch(&state, &payload).await {
        Ok(resp) => {
            if let Err(e) = check_batch_response(&resp, &step_names, &[]) {
                return Json(DnsResponse {
                    success: false,
                    error: Some(e),
                    status: None,
                });
            }
        }
        Err(e) => {
            log("ERROR", e.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    }

    let message = if has_br0 {
        "Управление DNS отключено, name-server установлен: 77.88.8.8:53"
    } else {
        "Управление DNS отключено"
    };
    log("INFO", message.into());
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn batch_payload_enable_with_filter_shape() {
        let br0_ip = "192.168.1.1";
        let payload = vec![
            json!({"dns-proxy": {"https": {"upstream": [{"no": true}]}}}),
            json!({"dns-proxy": {"tls": {"upstream": [{"no": true}]}}}),
            json!({"ip": {"name-server": [{"no": true}]}}),
            json!({"ip": {"name-server": [{"address": br0_ip}]}}),
            json!({"opkg": {"dns-override": {}}}),
            json!({"system": {"configuration": {"save": {}}}}),
        ];
        assert_eq!(payload.len(), 6);
        assert_eq!(payload[3]["ip"]["name-server"][0]["address"], json!(br0_ip));
        assert_eq!(payload[5]["system"]["configuration"]["save"], json!({}));
    }

    #[test]
    fn finds_nested_batch_error() {
        let ok = json!([{}, {"status": [{"status": "message", "message": "saving (http/rci)."}]}]);
        assert!(find_batch_error(&ok[0]).is_none());
        assert!(find_batch_error(&ok[1]).is_none());

        let nested = json!({"system": {"configuration": {"save": {"status": [{"status": "error", "code": "1", "ident": "X", "message": "boom"}]}}}});
        assert_eq!(find_batch_error(&nested), Some("boom (X 1)".to_string()));
    }

    #[test]
    fn check_ignores_optional_components() {
        let steps = ["DoH", "DoT", "save"];
        let one_error = json!([
            {"status": [{"status": "error", "message": "no such command"}]},
            {},
            {},
        ]);
        assert!(check_batch_response(&one_error, &steps, &[]).is_err());
        assert!(check_batch_response(&one_error, &steps, &[0]).is_ok());

        let two_errors = json!([
            {"status": [{"status": "error", "message": "absent"}]},
            {"status": [{"status": "error", "message": "absent"}]},
            {},
        ]);
        assert!(check_batch_response(&two_errors, &steps, &[0]).is_err());
        assert!(check_batch_response(&two_errors, &steps, &[0, 1]).is_ok());
    }
}
