use axum::{extract::State, response::{IntoResponse, Json}};
use serde::Deserialize;
use std::{collections::HashMap, path::Path, os::unix::fs::PermissionsExt, fs::Permissions, io::Read};
use nix::{sys::{signal::{kill, Signal}, resource::{setrlimit, Resource}}, unistd::{Gid, Pid, setgid, setsid}};
use tokio::{fs::{self, set_permissions}, process::Command};
use crate::types::*;
use crate::logger::log;

#[derive(Deserialize)] pub struct ControlReq { action: String, #[serde(default)] core: String }

fn get_core_info(name: &str) -> CoreInfo {
    match name {
        "mihomo" => CoreInfo { name: "mihomo".into(), conf_dir: MIHOMO_CONF.into(), is_json: false },
        _ => CoreInfo { name: "xray".into(), conf_dir: XRAY_CONF.into(), is_json: true }
    }
}

pub fn get_pid(name: &str) -> Option<i32> {
    let mut buf = Vec::new();
    std::fs::read_dir("/proc").ok()?.filter_map(|e| {
        let p = e.ok()?.path();
        let pid = p.file_name()?.to_str()?.parse::<i32>().ok()?;
        buf.clear();
        std::fs::File::open(p.join("comm")).ok()?.read_to_end(&mut buf).ok()?;
        (buf.strip_suffix(b"\n")? == name.as_bytes()).then_some(pid)
    }).next()
}

pub async fn soft_restart(core: &str) {
    if let Some(p) = get_pid(core) { _ = kill(Pid::from_raw(p), Signal::SIGKILL); }
    let mut cmd = Command::new(core);
    match core {
        "mihomo" => { cmd.env("CLASH_HOME_DIR", MIHOMO_CONF); }
        _ => { cmd.envs([("XRAY_LOCATION_CONFDIR", XRAY_CONF), ("XRAY_LOCATION_ASSET", XRAY_ASSET)]); }
    }
    let lim = if cfg!(target_arch = "aarch64") { 40000 } else { 10000 };
    unsafe { cmd.pre_exec(move || { setsid()?; setgid(Gid::from_raw(11111))?; setrlimit(Resource::RLIMIT_NOFILE, lim, lim)?; Ok(()) }); }
    if let Ok(f) = std::fs::File::options().append(true).create(true).open(ERROR_LOG) {
        cmd.stdout(f.try_clone().unwrap()).stderr(f);
    }
    if let Ok(mut c) = cmd.spawn() { tokio::spawn(async move { _ = c.wait().await; }); }
}

pub async fn get_control(State(state): State<AppState>) -> impl IntoResponse {
    let mut current_core = state.core.read().unwrap().clone();
    let core_name = current_core.name.clone();

    if tokio::task::spawn_blocking(move || get_pid(&core_name)).await.unwrap_or(None).is_none() {
        let alt_core = if current_core.name == "mihomo" { "xray" } else { "mihomo" };
        let alt_string = alt_core.to_string();

        current_core = if tokio::task::spawn_blocking(move || get_pid(&alt_string)).await.unwrap_or(None).is_some() {
            get_core_info(alt_core)
        } else {
            let init_file_path = state.init_file.read().unwrap().clone();
            let configuration = tokio::fs::read_to_string(&init_file_path).await.unwrap_or_default();
            get_core_info(if configuration.contains("name_client=\"mihomo\"") { "mihomo" } else { "xray" })
        };
        *state.core.write().unwrap() = current_core.clone();
    }

    let mut core_versions = HashMap::new();
    let mut available_cores = Vec::new();
    let mut running_status = false;

    for core_binary in ["xray", "mihomo"] {
        if tokio::fs::metadata(format!("/opt/sbin/{}", core_binary)).await.is_ok() {
            available_cores.push(core_binary.to_string());
            let command_output = Command::new(core_binary)
                .arg(if core_binary == "mihomo" { "-v" } else { "version" })
                .output().await.ok();

            if let Some(output) = command_output {
                let output_string = String::from_utf8_lossy(&output.stdout);
                let parts: Vec<&str> = output_string.split_whitespace().collect();
                let version = match core_binary {
                    "xray" if parts.len() > 1 => {
                         if parts[1].starts_with('v') { parts[1].into() } else { format!("v{}", parts[1]) }
                    },
                    "mihomo" if parts.len() > 2 => parts[2].into(),
                    _ => "?".into()
                };
                core_versions.insert(core_binary.to_string(), version);
            }
        }

        let binary_string = core_binary.to_string();
        if tokio::task::spawn_blocking(move || get_pid(&binary_string)).await.unwrap_or(None).is_some() {
            running_status = true;
        }
    }

    Json(serde_json::json!({ "success": true, "cores": available_cores, "currentCore": current_core.name, "running": running_status, "versions": core_versions }))
}

async fn check_core_config(core: &str) -> Result<(), String> {
    if core == "xray" {
        fs::create_dir_all(XRAY_CONF).await.ok();
        let has_json = std::fs::read_dir(XRAY_CONF)
            .map(|dir| dir.flatten().any(|e| e.path().extension().map_or(false, |x| x == "json")))
            .unwrap_or(false);
        if !has_json {
            return Err("Не найдены конфигурационные файлы. Настройте их в /opt/etc/xray/configs перед запуском".into());
        }
    }
    Ok(())
}

pub async fn post_control(State(state): State<AppState>, Json(req): Json<ControlReq>) -> impl IntoResponse {
    match req.action.as_str() {
        "switchCore" => {
            let old = state.core.read().unwrap().name.clone();
            if old == req.core { return Json(ApiResponse { success: true, error: None, data: None }); }

            let init_file = state.init_file.read().unwrap().clone();
            _ = Command::new(&init_file).arg("stop").status().await;

            let new_init_file = if Path::new(S99XKEEN).exists() { S99XKEEN.to_string() } else { S24XRAY.to_string() };
            *state.init_file.write().unwrap() = new_init_file.clone();

            if let Ok(content) = fs::read_to_string(&new_init_file).await {
                let new_content = content.replace(&format!("name_client=\"{}\"", old), &format!("name_client=\"{}\"", req.core));
                _ = fs::write(&new_init_file, new_content).await;
                let permissions = Permissions::from_mode(0o755);
                _ = set_permissions(&new_init_file, permissions).await;
            }

            *state.core.write().unwrap() = get_core_info(&req.core);

            if let Err(e) = check_core_config(&req.core).await {
                log("ERROR", e);
                return Json(ApiResponse { success: false, error: Some(format!("Не удалось запустить {}", req.core)), data: None });
            }

            if req.core != "xray" { _ = fs::write(ERROR_LOG, b"").await; }

            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
                _ = Command::new(&new_init_file).arg("start").stdout(f.try_clone().unwrap()).stderr(f).status().await;
            } else {
                _ = Command::new(&new_init_file).arg("start").status().await;
            }
        },
        "softRestart" => soft_restart(&req.core).await,
        a if ["start", "stop", "hardRestart"].contains(&a) => {
            let arg = match a {
                "start" => "start",
                "stop" => "stop",
                _ => "restart",
            };

            let cur_name = state.core.read().unwrap().name.clone();
            if a == "start" || a == "hardRestart" {
                if let Err(e) = check_core_config(&cur_name).await {
                    log("ERROR", e);
                    return Json(ApiResponse { success: false, error: Some(format!("Не удалось запустить {}", cur_name)), data: None });
                }
            }
            if cur_name == "mihomo" && (a == "start" || a == "hardRestart") {
                _ = fs::write(ERROR_LOG, b"").await;
            }

            let init_file = state.init_file.read().unwrap().clone();
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
                let s = Command::new(&init_file).arg(arg).stdout(f.try_clone().unwrap()).stderr(f).status().await;
                if matches!(s, Ok(c) if !c.success()) {
                    return Json(ApiResponse { success: false, error: Some("Process error".into()), data: None });
                }
            } else {
                _ = Command::new(&init_file).arg(arg).status().await;
            }
        },
        _ => return Json(ApiResponse { success: false, error: Some("Bad action".into()), data: None }),
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}