use axum::{extract::State, response::{IntoResponse, Json}};
use serde::Deserialize;
use std::{collections::HashMap, path::Path, os::unix::fs::PermissionsExt, fs::Permissions, io::Read};
use nix::{sys::signal::{kill, Signal}, unistd::Pid};
use tokio::{fs::{self, set_permissions}, process::Command};
use crate::types::*;

#[derive(Deserialize)]
pub struct ControlReq {
    action: String,
    #[serde(default)]
    core: String
}

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
    if let Some(pid) = get_pid(core) { let _ = kill(Pid::from_raw(pid), Signal::SIGKILL); }
    let mut cmd = Command::new(core);
    match core {
        "xray" => cmd.envs([("XRAY_LOCATION_CONFDIR", XRAY_CONF), ("XRAY_LOCATION_ASSET", XRAY_ASSET)]),
        _ => cmd.env("CLASH_HOME_DIR", MIHOMO_CONF)
    };
    unsafe { cmd.pre_exec(|| { nix::libc::setsid(); nix::libc::setgid(11111); Ok(()) }); }

    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
        cmd.stdout(f.try_clone().unwrap()).stderr(f);
    }
    if let Ok(mut child) = cmd.spawn() {
        if let Some(id) = child.id() {
            let limit = if cfg!(target_arch = "aarch64") { 40000 } else { 10000 };
            unsafe { nix::libc::prlimit(id as i32, nix::libc::RLIMIT_NOFILE, &nix::libc::rlimit { rlim_cur: limit, rlim_max: limit }, std::ptr::null_mut()); }
        }
        tokio::spawn(async move { let _ = child.wait().await; });
    }
}

pub async fn get_control(State(state): State<AppState>) -> impl IntoResponse {
    let mut core = state.core.read().unwrap().clone();
    if get_pid(&core.name).is_none() {
        let alt = if core.name == "mihomo" { "xray" } else { "mihomo" };
        core = if get_pid(alt).is_some() {
            get_core_info(alt)
        } else {
            let path = state.init_file.read().unwrap();
            let conf = std::fs::read_to_string(&*path).unwrap_or_default();
            get_core_info(if conf.contains("name_client=\"mihomo\"") { "mihomo" } else { "xray" })
        };
        *state.core.write().unwrap() = core.clone();
    }

    let mut versions = HashMap::new();
    let mut cores = Vec::new();
    let mut running = false;

    for c in ["xray", "mihomo"] {
        if Path::new(&format!("/opt/sbin/{}", c)).exists() {
            cores.push(c.to_string());
            let out = Command::new(c)
                .arg(if c == "mihomo" { "-v" } else { "version" })
                .output().await.ok();

            if let Some(o) = out {
                let s = String::from_utf8_lossy(&o.stdout);
                let parts: Vec<&str> = s.split_whitespace().collect();
                let v = match c {
                    "xray" if parts.len() > 1 => {
                         if parts[1].starts_with('v') { parts[1].into() } else { format!("v{}", parts[1]) }
                    },
                    "mihomo" if parts.len() > 2 => parts[2].into(),
                    _ => "?".into()
                };
                versions.insert(c.to_string(), v);
            }
        }
        if get_pid(c).is_some() { running = true; }
    }

    Json(serde_json::json!({ "success": true, "cores": cores, "currentCore": core.name, "running": running, "versions": versions }))
}

pub async fn post_control(State(state): State<AppState>, Json(req): Json<ControlReq>) -> impl IntoResponse {
    match req.action.as_str() {
        "switchCore" => {
            let old = state.core.read().unwrap().name.clone();
            if old == req.core { return Json(ApiResponse { success: true, error: None, data: None }); }

            let init_file = state.init_file.read().unwrap().clone();
            let _ = Command::new(&init_file).arg("stop").status().await;

            let new_init_file = if Path::new(S99XKEEN).exists() { S99XKEEN.to_string() } else { S24XRAY.to_string() };
            *state.init_file.write().unwrap() = new_init_file.clone();

            if let Ok(content) = fs::read_to_string(&new_init_file).await {
                let new_content = content.replace(&format!("name_client=\"{}\"", old), &format!("name_client=\"{}\"", req.core));
                let _ = fs::write(&new_init_file, new_content).await;
                let permissions = Permissions::from_mode(0o755);
                let _ = set_permissions(&new_init_file, permissions).await;
            }

            *state.core.write().unwrap() = get_core_info(&req.core);

            if req.core != "xray" { let _ = fs::write(ERROR_LOG, b"").await; }

            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
                let _ = Command::new(&new_init_file).arg("start").stdout(f.try_clone().unwrap()).stderr(f).status().await;
            } else {
                let _ = Command::new(&new_init_file).arg("start").status().await;
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
            if cur_name == "mihomo" && (a == "start" || a == "hardRestart") {
                let _ = fs::write(ERROR_LOG, b"").await;
            }

            let init_file = state.init_file.read().unwrap().clone();
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
                let s = Command::new(&init_file).arg(arg).stdout(f.try_clone().unwrap()).stderr(f).status().await;
                if matches!(s, Ok(c) if !c.success()) {
                    return Json(ApiResponse { success: false, error: Some("Process error".into()), data: None });
                }
            } else {
                let _ = Command::new(&init_file).arg(arg).status().await;
            }
        },
        _ => return Json(ApiResponse { success: false, error: Some("Bad action".into()), data: None }),
    }
    Json(ApiResponse::<()> { success: true, error: None, data: None })
}