use crate::types::{AppState, VERSION};
use crate::updater::{self, get_repo};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

const GITHUB_RELEASE: &str = "https://github.com";

pub async fn get_local_core_version(core: &str) -> Option<String> {
    let arg = if core == "mihomo" { "-v" } else { "version" };
    let mut cmd = Command::new(format!("/opt/sbin/{}", core));
    cmd.arg(arg);
    let out = timeout(Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;

    let s = String::from_utf8_lossy(&out.stdout);
    let p: Vec<&str> = s.split_whitespace().collect();

    let ver = match core {
        "xray" => p.get(1).copied(),
        "mihomo" => p.get(if p.first() == Some(&"mihomo") { 1 } else { 2 }).copied(),
        _ => None,
    }?;

    Some(if ver.starts_with('v') || ver.starts_with("alpha") {
        ver.to_string()
    } else {
        format!("v{}", ver)
    })
}

pub async fn version_handler(State(state): State<AppState>) -> impl IntoResponse {
    let check = |outdated, last: &std::sync::RwLock<Option<Instant>>| {
        outdated && {
            let mut l = last.write().unwrap();
            if l.map_or(true, |t| t.elapsed().as_secs() > 86400) {
                *l = Some(Instant::now());
                true
            } else {
                false
            }
        }
    };

    let (ui, core_outdated) = (
        *state.update_checker.ui_outdated.read().unwrap(),
        *state.update_checker.core_outdated.read().unwrap(),
    );

    let current_core = state.core.read().unwrap().name.clone();

    let (xray_version, mihomo_version) = tokio::join!(get_local_core_version("xray"), get_local_core_version("mihomo"));

    let mut res = serde_json::Map::new();

    let ui_tag = state.update_checker.ui_latest_tag.read().unwrap().clone();
    let core_tag = state.update_checker.core_latest_tag.read().unwrap().clone();

    let make_link = |repo: &str, tag: Option<&str>| -> Option<String> {
        tag.map(|t| format!("{}/{}/releases/tag/{}", GITHUB_RELEASE, repo, t))
    };

    {
        let link = get_repo("self").and_then(|r| make_link(r, ui_tag.as_deref()));
        res.insert("xkeen-ui".into(), json!({
            "version": VERSION.trim_start_matches('v'),
            "outdated": ui,
            "show_toast": check(ui, &state.update_checker.last_ui_toast),
            "link": link,
        }));
    }

    let make_core_obj = |v: String, repo: &str, tag: Option<&str>| -> serde_json::Value {
        let mut obj = json!({ "version": v, "outdated": core_outdated, "show_toast": check(core_outdated, &state.update_checker.last_core_toast) });
        if let Some(link) = make_link(repo, tag) {
            obj["link"] = json!(link);
        }
        obj
    };

    if current_core == "mihomo" {
        if let Some(v) = mihomo_version {
            if let Some(repo) = get_repo("mihomo") {
                res.insert("mihomo".into(), make_core_obj(v, repo, core_tag.as_deref()));
            }
        }
        if let Some(v) = xray_version {
            res.insert("xray".into(), json!({ "version": v }));
        }
    } else {
        if let Some(v) = xray_version {
            if let Some(repo) = get_repo("xray") {
                res.insert("xray".into(), make_core_obj(v, repo, core_tag.as_deref()));
            }
        }
        if let Some(v) = mihomo_version {
            res.insert("mihomo".into(), json!({ "version": v }));
        }
    }

    res.insert("success".into(), json!(true));

    Json(res)
}

pub fn start_update_checker(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;

            let (check_ui, check_core, proxies) = {
                let s = state.settings.read().unwrap();
                let need = |on, last: &std::sync::RwLock<Option<Instant>>, sec| {
                    on && last.read().unwrap().map_or(true, |t| t.elapsed().as_secs() > sec)
                };
                (
                    need(s.updater.auto_check_ui, &state.update_checker.last_ui_check, 14400),
                    need(s.updater.auto_check_core, &state.update_checker.last_core_check, 14400),
                    s.updater.github_proxy.clone(),
                )
            };

            if check_ui {
                let cur = VERSION.trim_start_matches('v');
                if let Some((latest, tag)) =
                    updater::fetch_latest_version(&state.http_client, "self", &proxies, Some(cur)).await
                {
                    *state.update_checker.ui_outdated.write().unwrap() = compare_versions(&latest, cur);
                    *state.update_checker.ui_latest_tag.write().unwrap() = Some(tag);
                    *state.update_checker.last_ui_check.write().unwrap() = Some(Instant::now());
                }
            }

            if check_core {
                let core = state.core.read().unwrap().name.clone();
                let cur_opt = get_local_core_version(&core).await;
                let cur_str = cur_opt.as_deref().map(|v| v.trim_start_matches('v'));
                if let Some((latest, tag)) = updater::fetch_latest_version(&state.http_client, &core, &proxies, cur_str).await
                {
                    if let Some(cur) = cur_str {
                        if !cur.is_empty() {
                            *state.update_checker.core_outdated.write().unwrap() = compare_versions(&latest, cur);
                        }
                    }
                    *state.update_checker.core_latest_tag.write().unwrap() = Some(tag);
                    *state.update_checker.last_core_check.write().unwrap() = Some(Instant::now());
                }
            }
        }
    });
}

fn compare_versions(latest: &str, current: &str) -> bool {
    if current.to_lowercase().contains("alpha") || latest.to_lowercase().contains("alpha") {
        return latest != current;
    }

    let parse = |v: &str| {
        v.split('-')
            .next()
            .unwrap_or(v)
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect::<Vec<_>>()
    };
    parse(latest) > parse(current)
}
