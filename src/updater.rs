use axum::{extract::{Query, State}, response::{IntoResponse, Json}, http::{header, HeaderMap}};
use serde::Deserialize;
use serde_json::json;
use std::{path::Path, process::Stdio, os::unix::fs::PermissionsExt};
use std::fs::OpenOptions;
use tokio::{process::Command, io::AsyncWriteExt, fs};
use futures_util::StreamExt;
use chrono::Local;
use crate::types::*;

#[derive(Deserialize)]
pub struct ReleaseQuery { core: String }

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    name: String,
    published_at: String,
    #[serde(default)] prerelease: bool,
    assets: Vec<GhAsset>
}

#[derive(Deserialize)]
struct GhAsset { name: String, browser_download_url: String }

async fn log(lvl: &str, msg: String) {
    let line = crate::logs::format_plain_log(lvl, &msg);
    if lvl == "ERROR" { eprintln!("{}", msg); } else { println!("{}", msg); }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG).await {
        let _ = f.write_all(line.as_bytes()).await;
    }
}

fn make_res(success: bool, error: Option<String>) -> (HeaderMap, Json<serde_json::Value>) {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONNECTION, "close".parse().unwrap());
    (headers, Json(json!({ "success": success, "error": error })))
}

pub async fn get_releases(Query(q): Query<ReleaseQuery>) -> impl IntoResponse {
    let repo = match q.core.as_str() {
        "xray" => "XTLS/Xray-core",
        "mihomo" => "MetaCubeX/mihomo",
        _ => return make_res(false, Some("Неизвестное ядро".into()))
    };

    let client = reqwest::Client::builder().user_agent("XKeen").timeout(std::time::Duration::from_secs(10)).build().unwrap();
    match client.get(format!("https://api.github.com/repos/{}/releases", repo)).send().await {
        Ok(r) => {
            let rels: Vec<GhRelease> = r.json().await.unwrap_or_default();
            let data: Vec<ReleaseInfo> = rels.into_iter().take(10).map(|r| ReleaseInfo {
                version: r.tag_name.trim_start_matches('v').to_string(),
                name: r.name,
                published_at: r.published_at.split('T').next().unwrap_or("").to_string(),
                is_prerelease: r.prerelease
            }).collect();
            (HeaderMap::new(), Json(json!({ "success": true, "releases": data })))
        },
        Err(e) => (HeaderMap::new(), Json(json!({ "success": false, "error": e.to_string() })))
    }
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let ver = if req.version.chars().next().map_or(false, |c| c.is_ascii_digit()) { format!("v{}", req.version) } else { req.version.clone() };
    let mut c = req.core.chars();
    let core_name_cap = match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    };
    log("INFO", format!("Запущено обновление {} до {}", core_name_cap, ver)).await;

    let is_running = crate::controller::get_pid(&req.core).is_some();
    let arch = std::env::consts::ARCH;
    let mut asset_name = String::new();
    let mut url = String::new();

    if req.core == "xray" {
        let n = match arch {
            "aarch64" => "Xray-linux-arm64-v8a.zip",
            "mips" => "Xray-linux-mips32.zip",
            "mipsle" => "Xray-linux-mips32le.zip",
            _ => return make_res(false, Some("Архитектура не поддерживается".into()))
        };
        asset_name = n.to_string();
        url = format!("https://github.com/XTLS/Xray-core/releases/download/{}/{}", ver, n);
    } else if req.core == "mihomo" {
        let pat = match arch {
            "aarch64" => "arm64",
            "mips" => "mips-softfloat",
            "mipsle" => "mipsle-softfloat",
            _ => return make_res(false, Some("Архитектура не поддерживается".into()))
        };
        let client = reqwest::Client::builder().user_agent("XKeen").build().unwrap();
        if let Ok(r) = client.get("https://api.github.com/repos/MetaCubeX/mihomo/releases").send().await {
            let rels: Vec<GhRelease> = r.json().await.unwrap_or_default();
            if let Some(release) = rels.into_iter().find(|r| r.tag_name == ver) {
                if let Some(a) = release.assets.into_iter().find(|a| a.name.contains(&format!("mihomo-linux-{}", pat)) && a.name.ends_with(".gz")) {
                    asset_name = format!("mihomo-{}.gz", ver);
                    url = a.browser_download_url;
                }
            }
        }
        if url.is_empty() { return make_res(false, Some("Релиз или ассет не найден".into())); }
    }

    let tmp = Path::new("/opt/tmp");
    let _ = fs::create_dir_all(tmp).await;
    let archive_path = tmp.join(&asset_name);
    let bin_path = tmp.join(&req.core);

    log("INFO", format!("Загрузка: {}", url)).await;
    let client = reqwest::Client::builder().build().unwrap();
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return make_res(false, Some("Ошибка при скачивании файла".into()))
    };

    let mut file = match fs::File::create(&archive_path).await {
        Ok(f) => f, Err(e) => return make_res(false, Some(format!("Ошибка создания файла: {}", e)))
    };

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        if let Ok(b) = chunk {
            downloaded += b.len() as u64;
            let _ = file.write_all(&b).await;
        }
    }
    let _ = file.flush().await; drop(file);
    let size_mb = downloaded as f64 / 1024.0 / 1024.0;
    log("INFO", format!("Файл загружен ({:.1} МБ)", size_mb)).await;

    let (ap, bp, core_name) = (archive_path.clone(), bin_path.clone(), req.core.clone());
    let is_zip = asset_name.ends_with(".zip");

    log("INFO", "Распаковка...".into()).await;
    if tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let f = std::fs::File::open(&ap)?;
        let mut out = std::fs::File::create(&bp)?;
        if is_zip { std::io::copy(&mut zip::ZipArchive::new(f)?.by_name(&core_name)?, &mut out)?; }
        else { std::io::copy(&mut flate2::read::GzDecoder::new(f), &mut out)?; }
        Ok(())
    }).await.unwrap().is_err() { return make_res(false, Some("Ошибка распаковки".into())); }

    let target = format!("/opt/sbin/{}", req.core);

    if req.backup_core && Path::new(&target).exists() {
        let backup = format!("/opt/sbin/core-backup/{}-{}", req.core, Local::now().format("%Y%m%d-%H%M%S"));
        let _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", backup)).await;
        let _ = fs::copy(&target, &backup).await;
    }

    log("INFO", format!("Установка {}...", core_name_cap)).await;

    if fs::rename(&bin_path, &target).await.is_ok() {
        let _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if is_running {
          log("INFO", format!("Перезапуск {}...", core_name_cap)).await;
            crate::controller::soft_restart(&req.core).await;
        }
    } else {
        log("WARN", "Атомарная замена не удалась, использую fallback...".into()).await;
        let init = state.init_file.read().unwrap().clone();
        let xkeen = |act: &str| {
            let cmd = init.clone();
            let arg = act.to_string();
            async move {
                let log_file = OpenOptions::new().create(true).append(true).open(ERROR_LOG);
                let mut c = Command::new(&cmd);
                c.arg(&arg);
                if let Ok(f) = log_file {
                    c.stdout(Stdio::from(f.try_clone().unwrap())).stderr(Stdio::from(f));
                }
                c.status().await
            }
        };

        if is_running { let _ = xkeen("stop").await; }

        if let Err(e) = fs::copy(&bin_path, &target).await {
            return make_res(false, Some(format!("Ошибка установки: {}", e)));
        }
        let _ = fs::remove_file(&bin_path).await;
        let _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;

        if is_running {
            log("INFO", "Запуск XKeen...".into()).await;
            let _ = xkeen("start").await;
        }
    }

    let ap_bg = archive_path.clone();
    tokio::spawn(async move { let _ = fs::remove_file(ap_bg).await; });

    log("INFO", format!("Обновление {} до {} завершено", core_name_cap, ver)).await;
    make_res(true, None)
}