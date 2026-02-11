use axum::{extract::State, response::{IntoResponse, Json}};
use std::time::{Duration, Instant};
use crate::{types::{VERSION, AppState}, updater};

pub async fn version_handler(State(state): State<AppState>) -> impl IntoResponse {
    // Логика кулдауна для тостов (24 часа)
    let should_show_toast = |outdated: bool, last_toast: &std::sync::RwLock<Option<Instant>>| -> bool {
        if !outdated { return false; }
        let mut last = last_toast.write().unwrap();
        if last.map_or(true, |t| t.elapsed() > Duration::from_secs(24 * 3600)) {
            *last = Some(Instant::now());
            true
        } else {
            false
        }
    };

    let ui_outdated = *state.update_checker.ui_outdated.read().unwrap();
    let core_outdated = *state.update_checker.core_outdated.read().unwrap();

    let show_ui_toast = should_show_toast(ui_outdated, &state.update_checker.last_ui_toast);
    let show_core_toast = should_show_toast(core_outdated, &state.update_checker.last_core_toast);

    Json(serde_json::json!({
        "success": true,
        "version": VERSION,
        "outdated": {
            "ui": ui_outdated,
            "core": core_outdated
        },
        "show_toast": {
            "ui": show_ui_toast,
            "core": show_core_toast
        }
    }))
}

pub fn start_update_checker(state: AppState) {
    tokio::spawn(async move {
        loop {
            let check_ui = state.update_checker.last_ui_check.read().unwrap()
                .map_or(true, |t| t.elapsed() > Duration::from_secs(4 * 3600));

            if check_ui {
                if let Some(latest) = updater::fetch_latest_version(&state.http_client, "self").await {
                    *state.update_checker.ui_outdated.write().unwrap() = compare_versions(&latest, VERSION.trim_start_matches('v'));
                }
                *state.update_checker.last_ui_check.write().unwrap() = Some(Instant::now());
            }

            let check_core = state.update_checker.last_core_check.read().unwrap()
                .map_or(true, |t| t.elapsed() > Duration::from_secs(12 * 3600));

            if check_core {
                let core = state.core.read().unwrap().name.clone();
                if let Some(latest) = updater::fetch_latest_version(&state.http_client, &core).await {
                    let bin = format!("/opt/sbin/{}", core);
                    if let Ok(out) = tokio::process::Command::new(bin).arg(if core == "mihomo" { "-v" } else { "version" }).output().await {
                        let s = String::from_utf8_lossy(&out.stdout);
                        let parts: Vec<&str> = s.split_whitespace().collect();
                        let current = match core.as_str() {
                            "xray" => parts.get(1),
                            "mihomo" => if parts.get(0) == Some(&"mihomo") { parts.get(1) } else { parts.get(2) },
                            _ => None
                        }.unwrap_or(&"").trim_start_matches('v');

                        if !current.is_empty() {
                            *state.update_checker.core_outdated.write().unwrap() = compare_versions(&latest, current);
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
    let parse = |v: &str| v.split('.').filter_map(|s| s.parse::<u32>().ok()).collect::<Vec<_>>();
    let (l, c) = (parse(latest), parse(current));
    for (a, b) in l.iter().zip(c.iter()) {
        if a > b { return true; }
        if a < b { return false; }
    }
    l.len() > c.len()
}