use crate::{
    types::{AppState, VERSION},
    updater,
};
use axum::{
    extract::State,
    response::{IntoResponse, Json},
};
use std::time::{Duration, Instant};
use tokio::process::Command;

pub async fn get_local_core_version(core: &str) -> Option<String> {
    let arg = if core == "mihomo" { "-v" } else { "version" };
    let out = Command::new(format!("/opt/sbin/{}", core))
        .arg(arg)
        .output()
        .await
        .ok()?;

    let s = String::from_utf8_lossy(&out.stdout);
    let p: Vec<&str> = s.split_whitespace().collect();

    let ver = match core {
        "xray" => p.get(1).copied(),
        "mihomo" => p
            .get(if p.first() == Some(&"mihomo") { 1 } else { 2 })
            .copied(),
        _ => None,
    }?;

    Some(if ver.starts_with('v') || ver.starts_with("alpha") {
        ver.to_string()
    } else {
        format!("v{}", ver)
    })
}

const VERSION_CACHE_TTL: Duration = Duration::from_secs(60);

pub async fn get_local_core_version_cached(state: &AppState, core: &str) -> Option<String> {
    if let Some(cached) = {
        let cache = state.version_cache.read().unwrap();
        cache
            .get(core)
            .filter(|(_, ts)| ts.elapsed() < VERSION_CACHE_TTL)
            .map(|(v, _)| v.clone())
    } {
        return cached;
    }
    let ver = get_local_core_version(core).await;
    state
        .version_cache
        .write()
        .unwrap()
        .insert(core.to_string(), (ver.clone(), Instant::now()));
    ver
}

pub fn invalidate_version_cache(state: &AppState) {
    state.version_cache.write().unwrap().clear();
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

    let (ui, core) = (
        *state.update_checker.ui_outdated.read().unwrap(),
        *state.update_checker.core_outdated.read().unwrap(),
    );

    let (xray_version, mihomo_version) = tokio::join!(
        get_local_core_version_cached(&state, "xray"),
        get_local_core_version_cached(&state, "mihomo")
    );

    let mut core_versions = serde_json::Map::new();
    if let Some(v) = xray_version {
        core_versions.insert("xray".into(), v.into());
    }
    if let Some(v) = mihomo_version {
        core_versions.insert("mihomo".into(), v.into());
    }

    Json(serde_json::json!({
        "success": true, "appVersion": VERSION,
        "outdated": { "app": ui, "core": core },
        "show_toast": { "app": check(ui, &state.update_checker.last_ui_toast), "core": check(core, &state.update_checker.last_core_toast) },
        "coreVersions": core_versions
    }))
}

pub fn start_update_checker(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;

            let (check_ui, check_core, proxies) = {
                let s = state.settings.read().unwrap();
                let need = |on, last: &std::sync::RwLock<Option<Instant>>, sec| {
                    on && last
                        .read()
                        .unwrap()
                        .map_or(true, |t| t.elapsed().as_secs() > sec)
                };
                (
                    need(
                        s.updater.auto_check_ui,
                        &state.update_checker.last_ui_check,
                        14400,
                    ),
                    need(
                        s.updater.auto_check_core,
                        &state.update_checker.last_core_check,
                        14400,
                    ),
                    s.updater.github_proxy.clone(),
                )
            };

            if check_ui {
                let cur = VERSION.trim_start_matches('v');
                if let Some(latest) =
                    updater::fetch_latest_version(&state.http_client, "self", &proxies, Some(cur)).await
                {
                    *state.update_checker.ui_outdated.write().unwrap() = compare_versions(&latest, cur);
                    *state.update_checker.last_ui_check.write().unwrap() = Some(Instant::now());
                }
            }

            if check_core {
                let core = state.core.read().unwrap().name.clone();
                let cur_opt = get_local_core_version(&core).await;
                let cur_str = cur_opt.as_deref().map(|v| v.trim_start_matches('v'));
                if let Some(latest) =
                    updater::fetch_latest_version(&state.http_client, &core, &proxies, cur_str).await
                {
                    if let Some(cur) = cur_str {
                        if !cur.is_empty() {
                            *state.update_checker.core_outdated.write().unwrap() =
                                compare_versions(&latest, cur);
                        }
                    }
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
