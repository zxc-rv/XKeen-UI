use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde::Deserialize;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct DnsEnableReq {
    pub dns_config: String,
}

#[derive(serde::Serialize)]
pub struct DnsResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
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

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            log("ERROR", format!("ndmc error for '{command}': {stderr}"));
        }
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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
            output: Some(output),
        }),
        Err(e) => Json(DnsResponse {
            success: false,
            error: Some(e),
            output: None,
        }),
    }
}

pub async fn post_dns(
    State(_state): State<AppState>,
    Json(req): Json<DnsEnableReq>,
) -> impl IntoResponse {
    let br0_ip = match get_br0_ip() {
        Ok(ip) => ip,
        Err(e) => {
            log("ERROR", e.clone());
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                output: None,
            });
        }
    };

    let commands = [
        "interface ISP ip no name-servers",
        "no dns-proxy https upstream",
        "no dns-proxy tls upstream",
        "no ip name-server",
    ];

    for cmd in &commands {
        if let Err(e) = run_ndmc(cmd).await {
            log("ERROR", format!("Ошибка: {e}"));
        }
    }

    let dns_server_cmd = format!("ip name-server {br0_ip}:53");
    if let Err(e) = run_ndmc(&dns_server_cmd).await {
        log("ERROR", format!("Ошибка установки name-server: {e}"));
        return Json(DnsResponse {
            success: false,
            error: Some(e),
            output: None,
        });
    }

    for cmd in &["opkg dns-override", "system configuration save"] {
        if let Err(e) = run_ndmc(cmd).await {
            log("ERROR", format!("Ошибка: {e}"));
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                output: None,
            });
        }
    }

    if let Some(config_path) = find_mihomo_config() {
        match tokio::fs::read_to_string(&config_path).await {
            Ok(content) => {
                let new_content = replace_dns_block(&content, &req.dns_config);
                if let Err(e) = tokio::fs::write(&config_path, &new_content).await {
                    log("DNS", format!("Ошибка записи config.yaml: {e}"));
                } else {
                    log("DNS", format!("DNS блок обновлён в {config_path}"));
                }
            }
            Err(e) => {
                log("DNS", format!("Ошибка чтения config.yaml: {e}"));
            }
        }
    } else {
        log("ERROR", "config.yaml не найден, блок dns не записан".into());
    }

    log("DNS", format!("DNS management enabled, name-server: {br0_ip}"));
    Json(DnsResponse {
        success: true,
        error: None,
        output: None,
    })
}

pub async fn delete_dns(State(_state): State<AppState>) -> impl IntoResponse {
    for cmd in &["no opkg dns-override", "no ip name-server", "system configuration save"] {
        if let Err(e) = run_ndmc(cmd).await {
            log("DNS", format!("Ошибка отключения: {e}"));
            return Json(DnsResponse {
                success: false,
                error: Some(e),
                output: None,
            });
        }
    }

    log("INFO", "Управление DNS отключены. Не забудьте настроить DNS в KeeneticOS".into());
    Json(DnsResponse {
        success: true,
        error: None,
        output: None,
    })
}
