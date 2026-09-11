use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use reqwest::Method;
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
    if let Some(config_path) = find_mihomo_config() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
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

    let response = req.send().await.map_err(|e| format!("Ошибка запроса RCI ({endpoint}): {e}"))?;
    if !response.status().is_success() {
        return Err(format!("RCI ({endpoint}) вернул {}", response.status()));
    }

    response.json().await.map_err(|e| format!("Ошибка парсинга RCI ({endpoint}): {e}"))
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

async fn req_rci(
    state: &AppState,
    method: Method,
    path: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let mut req = state
        .http_client
        .request(method.clone(), format!("http://127.0.0.1:79/rci/{path}"))
        .json(&payload)
        .timeout(Duration::from_secs(5));
        
    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }

    let response = req.send().await.map_err(|e| format!("Ошибка {method} RCI (/{path}): {e}"))?;
    
    let status = response.status();
    if !status.is_success() {
        let err = response.text().await.unwrap_or_default();
        return Err(format!("RCI вернул код {}, ответ: {}", status, err));
    }

    Ok(())
}

async fn run_rci_step(
    state: &AppState,
    step: &str,
    method: Method,
    path: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    match req_rci(state, method.clone(), path, payload).await {
        Ok(_) => {
            log("INFO", format!("DNS: '{step}' ({method} /{path}) — успешно"));
            Ok(())
        }
        Err(e) => {
            log("ERROR", format!("DNS: '{step}' ({method} /{path}) — ошибка: {e}"));
            Err(format!("{step}: {e}"))
        }
    }
}

fn find_mihomo_config() -> Option<String> {
    let dir = std::fs::read_dir(MIHOMO_CONF_DIR).ok()?;
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("yaml") {
            return path.to_str().map(String::from);
        }
    }
    None
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

pub async fn post_dns(
    State(state): State<AppState>,
    Json(req): Json<DnsEnableReq>,
) -> impl IntoResponse {
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

    let mut steps: Vec<(&str, Method, &str, serde_json::Value)> = vec![
        ("Включение opkg dns-override", Method::POST, "opkg/dns-override", json!({})),
        ("Сохранение конфигурации", Method::POST, "system/configuration/save", json!({})),
    ];

    if req.setup_filter {
        steps.insert(0, ("Отключение HTTPS DNS-прокси", Method::DELETE, "dns-proxy/https/upstream", json!({})));
        steps.insert(1, ("Отключение TLS DNS-прокси", Method::DELETE, "dns-proxy/tls/upstream", json!({})));
        steps.insert(2, ("Сброс системных DNS-серверов", Method::DELETE, "ip/name-server", json!({})));
        steps.insert(3, ("Установка name-server на br0", Method::POST, "ip/name-server", json!({"address": br0_ip, "port": 53})));
    }

    for (step, method, path, payload) in &steps {
        if let Err(e) = run_rci_step(&state, step, method.clone(), path, payload.clone()).await {
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
        if step.contains("dns-override") {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    if let Some(config_path) = find_mihomo_config() {
        if let Err(e) = tokio::fs::write(&config_path, &req.config_content).await {
            log("ERROR", format!("Ошибка записи config.yaml: {e}"));
        } else {
            log("INFO", format!("config.yaml обновлён в {config_path}"));
        }
    } else {
        log("ERROR", "config.yaml не найден, конфигурация не записана".into());
    }

    log("INFO", format!("Управление DNS включено, name-server: {br0_ip}"));
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}

pub async fn delete_dns(
    State(state): State<AppState>,
    Json(_req): Json<DnsDeleteReq>,
) -> impl IntoResponse {
    let mut steps: Vec<(&str, Method, &str, serde_json::Value)> = vec![
        ("Отключение opkg dns-override", Method::DELETE, "opkg/dns-override", json!({})),
        ("Сохранение конфигурации", Method::POST, "system/configuration/save", json!({})),
    ];

    let has_br0 = match fetch_running_config(&state).await {
        Ok(output) => {
            let br0_ip = get_br0_ip().unwrap_or_default();
            output.contains(&format!("ip name-server {br0_ip}"))
        }
        Err(_) => false,
    };

    if has_br0 {
        steps.insert(1, ("Сброс системных DNS-серверов", Method::DELETE, "ip/name-server", json!({})));
        steps.insert(2, ("Установка name-server на 77.88.8.8", Method::POST, "ip/name-server", json!({"address": "77.88.8.8", "port": 53})));
    }

    for (step, method, path, payload) in &steps {
        if let Err(e) = run_rci_step(&state, step, method.clone(), path, payload.clone()).await {
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
        if step.contains("dns-override") {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    log("INFO", "Управление DNS отключено".into());
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}
