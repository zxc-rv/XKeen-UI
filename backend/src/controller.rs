use axum::{extract::State, response::{IntoResponse, Json}};
use serde::Deserialize;
use std::{path::Path, os::unix::fs::PermissionsExt, fs::Permissions};
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

pub fn get_pid(name: &str) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return vec![] };
    entries.filter_map(|entry| {
        let path = entry.ok()?.path();
        let pid = path.file_name()?.to_str()?.parse::<i32>().ok()?;
        let comm = std::fs::read_to_string(path.join("comm")).ok()?;
        (comm.trim_end_matches('\n') == name).then_some(pid)
    }).collect()
}

pub async fn soft_restart(core: &str) {
    for pid in get_pid(core) { _ = kill(Pid::from_raw(pid), Signal::SIGKILL); }
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

    if tokio::task::spawn_blocking(move || get_pid(&core_name)).await.unwrap_or_default().is_empty() {
        let alt_core = if current_core.name == "mihomo" { "xray" } else { "mihomo" };
        let alt_string = alt_core.to_string();

        current_core = if !tokio::task::spawn_blocking(move || get_pid(&alt_string)).await.unwrap_or_default().is_empty() {
            get_core_info(alt_core)
        } else {
            let configuration = {
                let path = state.init_file.read().unwrap().clone();
                if let Some(p) = path { tokio::fs::read_to_string(p).await.unwrap_or_default() } else { String::new() }
            };
            get_core_info(if configuration.contains("name_client=\"mihomo\"") { "mihomo" } else { "xray" })
        };
        *state.core.write().unwrap() = current_core.clone();
    }

    let ((xray_exists, xray_running), (mihomo_exists, mihomo_running)) = tokio::join!(
        async {
            let exists = tokio::fs::metadata("/opt/sbin/xray").await.is_ok();
            let running = exists && tokio::task::spawn_blocking(|| !get_pid("xray").is_empty()).await.unwrap_or(false);
            (exists, running)
        },
        async {
            let exists = tokio::fs::metadata("/opt/sbin/mihomo").await.is_ok();
            let running = exists && tokio::task::spawn_blocking(|| !get_pid("mihomo").is_empty()).await.unwrap_or(false);
            (exists, running)
        }
    );

    let mut available_cores = Vec::new();
    if xray_exists { available_cores.push("xray".to_string()); }
    if mihomo_exists { available_cores.push("mihomo".to_string()); }
    let running_status = xray_running || mihomo_running;

    Json(serde_json::json!({ "success": true, "cores": available_cores, "currentCore": current_core.name, "running": running_status }))
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

            let Some(init_file) = [S99XKEEN, S24XRAY].iter().find(|p| Path::new(p).exists()).map(|s| s.to_string()) else {
                return Json(ApiResponse { success: false, error: Some("Не найден init файл XKeen".into()), data: None });
            };
            *state.init_file.write().unwrap() = Some(init_file.clone());
            _ = Command::new(&init_file).arg("stop").status().await;

            let new_init_file = init_file;

            if let Ok(content) = fs::read_to_string(&new_init_file).await {
                let new_content = content.replace(&format!("name_client=\"{}\"", old), &format!("name_client=\"{}\"", req.core));
                _ = fs::write(&new_init_file, new_content).await;
                let permissions = Permissions::from_mode(0o755);
                _ = set_permissions(&new_init_file, permissions).await;
            }

            *state.core.write().unwrap() = get_core_info(&req.core);

            if let Err(e) = check_core_config(&req.core).await {
                log("ERROR", e);
                return Json(ApiResponse { success: false, error: Some(format!("Не удалось запустить {}{}", &req.core[..1].to_uppercase(), &req.core[1..])), data: None });
            }

            if req.core != "xray" { _ = fs::write(ERROR_LOG, b"").await; }

            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
                _ = Command::new(&new_init_file).args(["start", "on"]).stdout(f.try_clone().unwrap()).stderr(f).status().await;
            } else {
                _ = Command::new(&new_init_file).args(["start", "on"]).status().await;
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
                    return Json(ApiResponse { success: false, error: Some(format!("Не удалось запустить {}{}", &cur_name[..1].to_uppercase(), &cur_name[1..])), data: None });
                }
            }
            if cur_name == "mihomo" && (a == "start" || a == "hardRestart") {
                _ = fs::write(ERROR_LOG, b"").await;
            }

            let Some(init_file) = [S99XKEEN, S24XRAY].iter().find(|p| Path::new(p).exists()).map(|s| s.to_string()) else {
                return Json(ApiResponse { success: false, error: Some("Не найден init файл XKeen".into()), data: None });
            };
            *state.init_file.write().unwrap() = Some(init_file.clone());
            let args: &[&str] = if a == "start" { &["start", "on"] } else { &[arg] };
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
                _ = Command::new(&init_file).args(args).stdout(f.try_clone().unwrap()).stderr(f).status().await;
            } else {
                _ = Command::new(&init_file).args(args).status().await;
            }
        },
        _ => return Json(ApiResponse { success: false, error: Some("Bad action".into()), data: None }),
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}