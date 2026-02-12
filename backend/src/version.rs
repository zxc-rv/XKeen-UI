use axum::{extract::State, response::{IntoResponse, Json}};
use std::time::{Duration, Instant};
use crate::{types::{VERSION, AppState}, updater};

pub async fn version_handler(State(state): State<AppState>) -> impl IntoResponse {
    let check = |outdated, last: &std::sync::RwLock<Option<Instant>>| outdated && {
        let mut l = last.write().unwrap();
        if l.map_or(true, |t| t.elapsed().as_secs() > 86400) { *l = Some(Instant::now()); true } else { false }
    };

    let (ui, core) = (*state.update_checker.ui_outdated.read().unwrap(), *state.update_checker.core_outdated.read().unwrap());
    Json(serde_json::json!({
        "success": true, "version": VERSION,
        "outdated": { "ui": ui, "core": core },
        "show_toast": { "ui": check(ui, &state.update_checker.last_ui_toast), "core": check(core, &state.update_checker.last_core_toast) }
    }))
}

pub fn start_update_checker(state: AppState) {
    tokio::spawn(async move {
        loop {
            let (check_ui, check_core) = {
                let s = state.settings.read().unwrap();
                let need = |on, last: &std::sync::RwLock<Option<Instant>>, sec| on && last.read().unwrap().map_or(true, |t| t.elapsed().as_secs() > sec);
                (need(s.updater.auto_check_ui, &state.update_checker.last_ui_check, 14400),
                 need(s.updater.auto_check_core, &state.update_checker.last_core_check, 43200))
            };

            if check_ui {
                if let Some(latest) = updater::fetch_latest_version(&state.http_client, "self").await {
                    *state.update_checker.ui_outdated.write().unwrap() = compare_versions(&latest, VERSION.trim_start_matches('v'));
                }
                *state.update_checker.last_ui_check.write().unwrap() = Some(Instant::now());
            }

            if check_core {
                let core = state.core.read().unwrap().name.clone();
                if let Some(latest) = updater::fetch_latest_version(&state.http_client, &core).await {
                    let arg = if core == "mihomo" { "-v" } else { "version" };
                    if let Ok(out) = tokio::process::Command::new(format!("/opt/sbin/{}", core)).arg(arg).output().await {
                        let s = String::from_utf8_lossy(&out.stdout);
                        let p: Vec<&str> = s.split_whitespace().collect();
                        let cur = match core.as_str() {
                            "xray" => p.get(1),
                            "mihomo" => p.get(if p.first() == Some(&"mihomo") { 1 } else { 2 }),
                            _ => None
                        }.unwrap_or(&"").trim_start_matches('v');

                        if !cur.is_empty() {
                            *state.update_checker.core_outdated.write().unwrap() = compare_versions(&latest, cur);
                        }
                    }
                }
                *state.update_checker.last_core_check.write().unwrap() = Some(Instant::now());
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

fn compare_versions(latest: &str, current: &str) -> bool {
    let parse = |v: &str| v.split('.').flat_map(str::parse::<u32>).collect::<Vec<_>>();
    parse(latest) > parse(current)
}