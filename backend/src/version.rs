use crate::logger::log;
use crate::types::{AppState, VERSION};
use crate::updater::{self, get_repo};
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

const GITHUB_RELEASE: &str = "https://github.com";
const FAILURE_COOLDOWN: Duration = Duration::from_secs(300);

pub async fn get_local_core_version(core: &str) -> Option<String> {
    let arg = if core == "mihomo" { "-v" } else { "version" };
    let mut cmd = Command::new(format!("/opt/sbin/{}", core));
    cmd.arg(arg);
    let out = timeout(Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;

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

pub async fn check_updates_handler(State(state): State<AppState>) -> impl IntoResponse {
    refresh_updates(&state).await;
    version_handler(State(state)).await
}

pub async fn version_handler(State(state): State<AppState>) -> impl IntoResponse {
    let check = |outdated, last: &std::sync::RwLock<Option<Instant>>| {
        outdated && {
            let mut l = last.write().unwrap();
            if l.is_none_or(|t| t.elapsed().as_secs() > 86400) {
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

    let updater_settings = state.settings.read().unwrap().updater.clone();

    let make_link = |repo: &str, tag: Option<&str>| -> Option<String> {
        tag.map(|t| format!("{}/{}/releases/tag/{}", GITHUB_RELEASE, repo, t))
    };

    {
        let link = get_repo(&updater_settings, "self").and_then(|r| make_link(&r, ui_tag.as_deref()));
        res.insert(
            "xkeen-ui".into(),
            json!({
                "version": VERSION.trim_start_matches('v'),
                "outdated": ui,
                "show_toast": check(ui, &state.update_checker.last_ui_toast),
                "link": link,
            }),
        );
    }

    let make_core_obj = |v: String, repo: &str, tag: Option<&str>| -> serde_json::Value {
        let mut obj = json!({ "version": v, "outdated": core_outdated, "show_toast": check(core_outdated, &state.update_checker.last_core_toast) });
        if let Some(link) = make_link(repo, tag) {
            obj["link"] = json!(link);
        }
        obj
    };

    if current_core == "mihomo" {
        if let Some(v) = mihomo_version
            && let Some(repo) = get_repo(&updater_settings, "mihomo")
        {
            res.insert("mihomo".into(), make_core_obj(v, &repo, core_tag.as_deref()));
        }
        if let Some(v) = xray_version {
            res.insert("xray".into(), json!({ "version": v }));
        }
    } else {
        if let Some(v) = xray_version
            && let Some(repo) = get_repo(&updater_settings, "xray")
        {
            res.insert("xray".into(), make_core_obj(v, &repo, core_tag.as_deref()));
        }
        if let Some(v) = mihomo_version {
            res.insert("mihomo".into(), json!({ "version": v }));
        }
    }

    res.insert("success".into(), json!(true));

    Json(res)
}

async fn refresh_updates(state: &AppState) {
    let (check_ui, check_core, updater_settings) = {
        let settings = state.settings.read().unwrap();
        let due =
            |hours: u32, last: &std::sync::RwLock<Option<Instant>>, failed: &std::sync::RwLock<Option<Instant>>| {
                hours > 0
                    && last
                        .read()
                        .unwrap()
                        .is_none_or(|t| t.elapsed().as_secs() > u64::from(hours) * 3600)
                    && failed.read().unwrap().is_none_or(|t| t.elapsed() > FAILURE_COOLDOWN)
            };
        (
            due(
                settings.updater.auto_check_ui,
                &state.update_checker.last_ui_check,
                &state.update_checker.last_ui_failure,
            ),
            due(
                settings.updater.auto_check_core,
                &state.update_checker.last_core_check,
                &state.update_checker.last_core_failure,
            ),
            settings.updater.clone(),
        )
    };
    let proxies = &updater_settings.github_proxy;

    let refresh_ui = async {
        if !check_ui {
            return;
        }
        let current = VERSION.trim_start_matches('v');
        if let Some(repo) = get_repo(&updater_settings, "self") {
            match updater::fetch_latest_version(&state.http_client, &repo, "self", proxies, Some(current)).await {
                Ok((latest, tag)) => {
                    *state.update_checker.ui_outdated.write().unwrap() = compare_versions(&latest, current);
                    *state.update_checker.ui_latest_tag.write().unwrap() = Some(tag);
                    *state.update_checker.last_ui_check.write().unwrap() = Some(Instant::now());
                }
                Err(reason) => {
                    *state.update_checker.last_ui_failure.write().unwrap() = Some(Instant::now());
                    log("WARN", format!("Не удалось проверить обновления XKeen UI: {}", reason));
                }
            }
        }
    };

    let refresh_core = async {
        if !check_core {
            return;
        }
        let core = state.core.read().unwrap().name.clone();
        if let Some(repo) = get_repo(&updater_settings, &core) {
            let local_version = get_local_core_version(&core).await;
            let current = local_version.as_deref().map(|v| v.trim_start_matches('v'));
            match updater::fetch_latest_version(&state.http_client, &repo, &core, proxies, current).await {
                Ok((latest, tag)) => {
                    if let Some(current) = current.filter(|v| !v.is_empty()) {
                        *state.update_checker.core_outdated.write().unwrap() = compare_versions(&latest, current);
                    }
                    *state.update_checker.core_latest_tag.write().unwrap() = Some(tag);
                    *state.update_checker.last_core_check.write().unwrap() = Some(Instant::now());
                }
                Err(reason) => {
                    *state.update_checker.last_core_failure.write().unwrap() = Some(Instant::now());
                    log("WARN", format!("Не удалось проверить обновления {}: {}", core, reason));
                }
            }
        }
    };

    tokio::join!(refresh_ui, refresh_core);
}

fn compare_versions(latest: &str, current: &str) -> bool {
    match (semver::Version::parse(latest), semver::Version::parse(current)) {
        (Ok(latest_version), Ok(current_version)) => latest_version > current_version,
        _ => latest != current,
    }
}
