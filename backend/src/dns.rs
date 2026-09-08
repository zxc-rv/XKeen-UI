use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use std::time::Duration;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct DnsEnableReq {
    pub dns_config: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsStatusFields {
    pub dns_override: bool,
    pub name_server: bool,
    pub ignore_provider: bool,
}

fn parse_dns_status(output: &str) -> DnsStatusFields {
    DnsStatusFields {
        dns_override: output.contains("opkg dns-override"),
        name_server: output.contains("ip name-server"),
        ignore_provider: output.contains("ip no name-servers"),
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

async fn run_ndmc(command: &str) -> Result<String, String> {
    let output = Command::new("ndmc")
        .args(["-c", command])
        .output()
        .await
        .map_err(|e| format!("Ошибка запуска ndmc: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() || !stderr.is_empty() {
        return Err(if stderr.is_empty() {
            format!("ndmc завершился с ошибкой (код {})", output.status)
        } else {
            stderr
        });
    }

    Ok(stdout)
}

async fn run_ndmc_step(step: &str, command: &str) -> Result<(), String> {
    match run_ndmc(command).await {
        Ok(_) => {
            log("INFO", format!("DNS: '{step}' ({command}) — успешно"));
            Ok(())
        }
        Err(e) => {
            log("ERROR", format!("DNS: '{step}' ({command}) — ошибка: {e}"));
            Err(format!("{step}: {e}"))
        }
    }
}

async fn find_ignore_provider_target(state: &AppState) -> Result<String, String> {
    let mut req = state
        .http_client
        .get("http://127.0.0.1:79/rci/show/interface")
        .timeout(Duration::from_secs(5));
    if let Some(ref token) = state.rci_token {
        req = req.header("X-Ndma-Tkn", token);
    }

    let response = req.send().await.map_err(|e| format!("Ошибка запроса RCI: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("RCI вернул {}", response.status()));
    }

    let data: serde_json::Value = response.json().await.map_err(|e| format!("Ошибка парсинга RCI: {e}"))?;
    let interfaces = data
        .as_object()
        .ok_or("RCI не вернул список интерфейсов")?;

    let isp = interfaces
        .values()
        .find(|v| v.get("interface-name").and_then(|n| n.as_str()) == Some("ISP"))
        .ok_or("Интерфейс ISP не найден")?;

    if isp.get("global").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok("ISP".to_string());
    }

    isp.get("usedby")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or("ISP не глобальный, а usedby пуст — не удалось определить интерфейс".to_string())
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

fn replace_dns_block(content: &str, new_block: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut dns_start: Option<usize> = None;
    let mut dns_end: Option<usize> = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("dns:") && (line.starts_with("dns:") || line.starts_with(' ')) {
            if line.starts_with("dns:") || line.chars().take_while(|&c| c == ' ').count() == 0 {
                dns_start = Some(i);
            }
        } else if dns_start.is_some() && !line.starts_with(' ') && !line.is_empty() && !line.starts_with('#') {
            dns_end = Some(i);
            break;
        }
    }

    if let Some(start) = dns_start {
        let end = dns_end.unwrap_or(lines.len());
        let mut result = String::new();
        for line in &lines[..start] {
            result.push_str(line);
            result.push('\n');
        }
        result.push_str(new_block);
        result.push('\n');
        for line in &lines[end..] {
            result.push_str(line);
            result.push('\n');
        }
        result
    } else {
        let mut result = content.trim_end().to_string();
        result.push_str("\n\n");
        result.push_str(new_block);
        result.push('\n');
        result
    }
}

pub async fn get_dns(State(_state): State<AppState>) -> impl IntoResponse {
    match run_ndmc("show running-config").await {
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

    let ignore_target = match find_ignore_provider_target(&state).await {
        Ok(target) => target,
        Err(e) => {
            log("ERROR", format!("DNS: не удалось определить интерфейс для отключения провайдерских DNS: {e}"));
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    };

    let steps = [
        ("Отключение DNS провайдера на интерфейсе", format!("interface {ignore_target} ip no name-servers")),
        ("Отключение HTTPS DNS-прокси", "no dns-proxy https upstream".to_string()),
        ("Отключение TLS DNS-прокси", "no dns-proxy tls upstream".to_string()),
        ("Сброс системных DNS-серверов", "no ip name-server".to_string()),
        ("Установка name-server на br0", format!("ip name-server {br0_ip}:53")),
        ("Включение opkg dns-override", "opkg dns-override".to_string()),
        ("Сохранение конфигурации", "system configuration save".to_string()),
    ];

    for (step, cmd) in &steps {
        if let Err(e) = run_ndmc_step(step, cmd).await {
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    }

    if let Some(config_path) = find_mihomo_config() {
        match tokio::fs::read_to_string(&config_path).await {
            Ok(content) => {
                let new_content = replace_dns_block(&content, &req.dns_config);
                if let Err(e) = tokio::fs::write(&config_path, &new_content).await {
                    log("ERROR", format!("Ошибка записи config.yaml: {e}"));
                } else {
                    log("INFO", format!("DNS блок обновлён в {config_path}"));
                }
            }
            Err(e) => {
                log("ERROR", format!("Ошибка чтения config.yaml: {e}"));
            }
        }
    } else {
        log("ERROR", "config.yaml не найден, блок dns не записан".into());
    }

    log("INFO", format!("Управление DNS включено, name-server: {br0_ip}"));
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}

pub async fn delete_dns(State(_state): State<AppState>) -> impl IntoResponse {
    let steps = [
        ("Отключение opkg dns-override", "no opkg dns-override"),
        ("Сброс системных DNS-серверов", "no ip name-server"),
        ("Сохранение конфигурации", "system configuration save"),
    ];

    for (step, cmd) in &steps {
        if let Err(e) = run_ndmc_step(step, cmd).await {
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                status: None,
            });
        }
    }

    log("INFO", "Управление DNS отключено. Не забудьте настроить DNS в KeeneticOS".into());
    Json(DnsResponse {
        success: true,
        error: None,
        status: None,
    })
}
