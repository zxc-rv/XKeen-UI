use crate::logger::log;
use crate::types::*;
use axum::{
    extract::State,
    response::{IntoResponse, Json},
};
use nix::{
    sys::{
        resource::{Resource, setrlimit},
        signal::{Signal, kill},
    },
    unistd::{Gid, Pid, setgid, setsid},
};
use serde::Deserialize;
use std::{fs::Permissions, os::unix::fs::PermissionsExt, path::Path};
use tokio::{
    fs::{self, set_permissions},
    process::Command,
};

#[derive(Deserialize)]
pub struct ControlReq {
    action: String,
    #[serde(default)]
    core: String,
}

pub fn find_init_file(log_enabled: bool) -> Option<String> {
    let (mut path, mut source) = (None, "fallback");

    if let Ok(content) = std::fs::read_to_string("/opt/sbin/.xkeen/01_info/01_info_variable.sh") {
        let (mut dir, mut file) = (None, None);
        for line in content.lines() {
            let clean = line.split('#').next().unwrap_or("").trim();
            if let Some(v) = clean.strip_prefix("initd_dir=") {
                dir = Some(v.trim_matches(&['"', '\''][..]));
            } else if let Some(v) = clean.strip_prefix("initd_file=") {
                file = Some(v.trim_matches(&['"', '\''][..]));
            }
        }
        if let (Some(d), Some(f)) = (dir, file) {
            path = Some(f.replace("$initd_dir", d));
            source = "var";
        }
    }

    let final_path = path.or_else(|| {
        [S99XKEEN, S24XRAY]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .map(String::from)
    });

    if log_enabled {
        if let Some(p) = &final_path {
            println!(
                "{} [INFO] Defined initd_file ({}): {}",
                crate::logger::ts(),
                source,
                p
            );
        }
    }

    final_path
}

async fn resolve_init_file(state: &AppState) -> Result<String, String> {
    if let Some(path) = state.init_file.read().unwrap().clone() {
        if Path::new(&path).exists() {
            return Ok(path);
        }
    }
    let new_path = tokio::task::spawn_blocking(|| find_init_file(false))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Не найден init файл XKeen".to_string())?;
    println!(
        "{} [INFO] Updated initd_file: {}",
        crate::logger::ts(),
        new_path
    );
    *state.init_file.write().unwrap() = Some(new_path.clone());
    Ok(new_path)
}

async fn run_init_command(state: &AppState, args: &[&str]) -> Result<(), String> {
    let path = resolve_init_file(state).await?;
    let result = if let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(error_log_path())
    {
        Command::new(&path)
            .args(args)
            .stdout(f.try_clone().unwrap())
            .stderr(f)
            .status()
            .await
    } else {
        Command::new(&path).args(args).status().await
    };
    if let Err(e) = result {
        *state.init_file.write().unwrap() = None;
        return Err(format!("{}: {}", path, e));
    }
    Ok(())
}

fn get_core_info(name: &str) -> CoreInfo {
    match name {
        "mihomo" => CoreInfo {
            name: "mihomo".into(),
            conf_dir: MIHOMO_CONF.into(),
            is_json: false,
        },
        _ => CoreInfo {
            name: "xray".into(),
            conf_dir: XRAY_CONF.into(),
            is_json: true,
        },
    }
}

pub fn get_pid(name: &str) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return vec![];
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let pid = path.file_name()?.to_str()?.parse::<i32>().ok()?;
            let comm = std::fs::read_to_string(path.join("comm")).ok()?;
            (comm.trim_end_matches('\n') == name).then_some(pid)
        })
        .collect()
}

pub async fn soft_restart(core: &str) {
    for pid in get_pid(core) {
        _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }
    let mut cmd = Command::new(core);
    match core {
        "mihomo" => {
            cmd.env("CLASH_HOME_DIR", MIHOMO_CONF);
        }
        _ => {
            cmd.envs([
                ("XRAY_LOCATION_CONFDIR", XRAY_CONF),
                ("XRAY_LOCATION_ASSET", XRAY_ASSET),
            ]);
        }
    }
    let lim = if cfg!(target_arch = "aarch64") {
        40000
    } else {
        10000
    };
    unsafe {
        cmd.pre_exec(move || {
            setsid()?;
            setgid(Gid::from_raw(11111))?;
            setrlimit(Resource::RLIMIT_NOFILE, lim, lim)?;
            Ok(())
        });
    }
    if let Ok(f) = std::fs::File::options()
        .append(true)
        .create(true)
        .open(error_log_path())
    {
        cmd.stdout(f.try_clone().unwrap()).stderr(f);
    }
    if let Ok(mut c) = cmd.spawn() {
        tokio::spawn(async move {
            _ = c.wait().await;
        });
    }
}

pub async fn get_control(State(state): State<AppState>) -> impl IntoResponse {
    let mut current_core = state.core.read().unwrap().clone();
    let core_name = current_core.name.clone();

    if tokio::task::spawn_blocking(move || get_pid(&core_name))
        .await
        .unwrap_or_default()
        .is_empty()
    {
        let alt_core = if current_core.name == "mihomo" {
            "xray"
        } else {
            "mihomo"
        };
        let alt_string = alt_core.to_string();

        if !tokio::task::spawn_blocking(move || get_pid(&alt_string))
            .await
            .unwrap_or_default()
            .is_empty()
        {
            current_core = get_core_info(alt_core);
            *state.core.write().unwrap() = current_core.clone();
        }
    }

    let ((xray_exists, xray_running), (mihomo_exists, mihomo_running)) = tokio::join!(
        async {
            let exists = tokio::fs::metadata("/opt/sbin/xray").await.is_ok();
            let running = exists
                && tokio::task::spawn_blocking(|| !get_pid("xray").is_empty())
                    .await
                    .unwrap_or(false);
            (exists, running)
        },
        async {
            let exists = tokio::fs::metadata("/opt/sbin/mihomo").await.is_ok();
            let running = exists
                && tokio::task::spawn_blocking(|| !get_pid("mihomo").is_empty())
                    .await
                    .unwrap_or(false);
            (exists, running)
        }
    );

    let mut available_cores = Vec::new();
    if xray_exists {
        available_cores.push("xray".to_string());
    }
    if mihomo_exists {
        available_cores.push("mihomo".to_string());
    }
    let running_status = xray_running || mihomo_running;

    Json(
        serde_json::json!({ "success": true, "cores": available_cores, "currentCore": current_core.name, "running": running_status }),
    )
}

async fn check_core_config(core: &str) -> Result<(), String> {
    if core == "xray" {
        fs::create_dir_all(XRAY_CONF).await.ok();
        let has_json = std::fs::read_dir(XRAY_CONF)
            .map(|dir| {
                dir.flatten()
                    .any(|e| e.path().extension().map_or(false, |x| x == "json"))
            })
            .unwrap_or(false);
        if !has_json {
            return Err("Не найдены конфигурационные файлы. Настройте их в /opt/etc/xray/configs перед запуском".into());
        }
    }
    Ok(())
}

pub async fn post_control(
    State(state): State<AppState>,
    Json(req): Json<ControlReq>,
) -> impl IntoResponse {
    match req.action.as_str() {
        "switchCore" => {
            let old = state.core.read().unwrap().name.clone();
            if old == req.core {
                return Json(ApiResponse {
                    success: true,
                    error: None,
                    data: None,
                });
            }

            let init_file = match resolve_init_file(&state).await {
                Ok(p) => p,
                Err(e) => {
                    return Json(ApiResponse {
                        success: false,
                        error: Some(e),
                        data: None,
                    });
                }
            };
            _ = Command::new(&init_file).arg("stop").status().await;

            if let Ok(content) = fs::read_to_string(&init_file).await {
                let new_content = content.replace(
                    &format!("name_client=\"{}\"", old),
                    &format!("name_client=\"{}\"", req.core),
                );
                _ = fs::write(&init_file, new_content).await;
                _ = set_permissions(&init_file, Permissions::from_mode(0o755)).await;
            }

            *state.core.write().unwrap() = get_core_info(&req.core);

            if let Err(e) = check_core_config(&req.core).await {
                log("ERROR", e);
                return Json(ApiResponse {
                    success: false,
                    error: Some(format!(
                        "Не удалось запустить {}{}",
                        &req.core[..1].to_uppercase(),
                        &req.core[1..]
                    )),
                    data: None,
                });
            }

            if req.core != "xray" {
                _ = fs::write(error_log_path(), b"").await;
            }

            if let Err(e) = run_init_command(&state, &["start", "on"]).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
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
                    return Json(ApiResponse {
                        success: false,
                        error: Some(format!(
                            "Не удалось запустить {}{}",
                            &cur_name[..1].to_uppercase(),
                            &cur_name[1..]
                        )),
                        data: None,
                    });
                }
            }
            if cur_name == "mihomo" && (a == "start" || a == "hardRestart") {
                _ = fs::write(error_log_path(), b"").await;
            }

            let args: &[&str] = match a {
                "start" => &["start", "on"],
                "hardRestart" => &["restart", "on"],
                _ => &[arg],
            };

            if let Err(e) = run_init_command(&state, args).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        _ => {
            return Json(ApiResponse {
                success: false,
                error: Some("Bad action".into()),
                data: None,
            });
        }
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}
