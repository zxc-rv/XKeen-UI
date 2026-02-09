use axum::{extract::{Query, State}, response::{IntoResponse, Json}, http::{header, HeaderMap}};
use serde::Deserialize;
use serde_json::json;
use std::{path::{Path, PathBuf}, os::unix::fs::PermissionsExt, fs::File, io::Cursor};
use tokio::{process::Command, io::AsyncWriteExt, fs};
use futures_util::StreamExt;
use crate::types::*;

const GITHUB_API: &str = "https://api.github.com/repos";
const GITHUB_RELEASE: &str = "https://github.com";
const JSDELIVR_API: &str = "https://data.jsdelivr.com/v1/package/gh";
const XRAY_REPO: &str = "XTLS/Xray-core";
const MIHOMO_REPO: &str = "MetaCubeX/mihomo";

#[derive(Deserialize)]
pub struct ReleaseQuery { core: String }

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)] name: String,
    #[serde(default)] published_at: String,
    #[serde(default)] prerelease: bool,
    #[serde(default)] assets: Vec<GhAsset>
}

#[derive(Deserialize, Default)]
struct GhAsset {
    #[serde(default)] name: String,
    #[serde(default)] browser_download_url: String
}

#[derive(Deserialize)]
struct JsdResponse { versions: Vec<String> }

enum DownloadResult {
    RAM(Vec<u8>),
    Disk(PathBuf)
}

fn get_repo(core: &str) -> Option<&'static str> {
    match core {
        "xray" => Some(XRAY_REPO),
        "mihomo" => Some(MIHOMO_REPO),
        _ => None,
    }
}

async fn log(lvl: &str, msg: String) {
    let line = crate::logs::format_plain_log(lvl, &msg);
    if lvl == "ERROR" { eprintln!("{}", msg); } else { println!("{}", msg); }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG).await {
        _ = f.write_all(line.as_bytes()).await;
    }
}

fn response(success: bool, error: Option<String>) -> (HeaderMap, Json<serde_json::Value>) {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONNECTION, "close".parse().unwrap());
    (headers, Json(json!({ "success": success, "error": error })))
}

async fn download(client: &reqwest::Client, url: &str, proxies: &[String], tmp_path: &Path) -> Result<DownloadResult, String> {
    const MB: usize = 1024 * 1024;
    async fn load(r: reqwest::Response, tmp_path: &Path, src: &str) -> Option<DownloadResult> {
        let size_hint = r.content_length().unwrap_or(0) as usize;
        let mut stream = r.bytes_stream();
        if size_hint > 50 * MB {
            let mut file = fs::File::create(tmp_path).await.ok()?;
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
                    Ok(Some(Ok(chunk))) => {
                        if file.write_all(&chunk).await.is_err() {
                            log("WARN", format!("Ошибка записи на диск ({})", src)).await;
                            _ = fs::remove_file(tmp_path).await;
                            return None;
                        }
                    }
                    Ok(None) => {
                        log("INFO", format!("Файл загружен на диск ({:.1} МБ)", size_hint as f64 / MB as f64)).await;
                        return Some(DownloadResult::Disk(tmp_path.to_path_buf()));
                    }
                    Ok(Some(Err(e))) => {
                        log("WARN", format!("Соединение оборвалось ({}): {}", src, e)).await;
                        _ = fs::remove_file(tmp_path).await;
                        return None;
                    }
                    Err(_) => {
                        log("WARN", format!("Таймаут загрузки ({})", src)).await;
                        _ = fs::remove_file(tmp_path).await;
                        return None;
                    }
                }
            }
        } else {
            let mut buffer = Vec::with_capacity(if size_hint > 0 { size_hint } else { 15 * MB });
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
                    Ok(Some(Ok(chunk))) => buffer.extend_from_slice(&chunk),
                    Ok(None) => {
                        if buffer.is_empty() {
                            log("WARN", format!("Загрузка вернула 0 байт ({})", src)).await;
                            return None;
                        }
                        log("INFO", format!("Файл загружен в ОЗУ ({:.1} МБ)", buffer.len() as f64 / MB as f64)).await;
                        return Some(DownloadResult::RAM(buffer));
                    }
                    Ok(Some(Err(e))) => {
                        log("WARN", format!("Соединение оборвалось ({}): {}", src, e)).await;
                        return None;
                    }
                    Err(_) => {
                        log("WARN", format!("Таймаут загрузки ({})", src)).await;
                        return None;
                    }
                }
            }
        }
    }

    match client.get(url).send().await {
        Ok(r) if r.status().is_success() => { if let Some(res) = load(r, tmp_path, "direct").await { return Ok(res); }}
        Ok(r) => log("WARN", format!("Ошибка загрузки: {}", r.status())).await,
        Err(e) => log("WARN", format!("Ошибка загрузки: {}", e)).await,
    }

    for (i, proxy) in proxies.iter().enumerate() {
        let proxied_url = format!("{}/{}", proxy, url);
        log("INFO", format!("Попытка загрузки через прокси #{}: {}", i + 1, proxy)).await;
        match client.get(&proxied_url).send().await {
            Ok(r) if r.status().is_success() => {
                let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");
                if ct.contains("text/html") {
                    log("WARN", format!("Прокси #{} вернул HTML", i + 1)).await;
                    continue;
                }
                if let Some(res) = load(r, tmp_path, &format!("proxy #{}", i + 1)).await { return Ok(res); }
            }
            Ok(r) => log("WARN", format!("Ошибка загрузки: {}", r.status())).await,
            Err(e) => log("WARN", format!("Ошибка загрузки: {}", e)).await,
        }
    }
    log("ERROR", "Не удалось выполнить обновление".into()).await;
    Err("Не удалось выполнить обновление".into())
}

pub async fn get_releases(State(state): State<AppState>, Query(q): Query<ReleaseQuery>) -> impl IntoResponse {
    let Some(repo) = get_repo(&q.core) else { return response(false, Some("Неизвестное ядро".into())); };
    let api_url = format!("{}/{}/releases?per_page=10", GITHUB_API, repo);
    if let Ok(r) = state.http_client.get(&api_url).send().await {
        if let Ok(rels) = r.json::<Vec<GhRelease>>().await {
            let data: Vec<_> = rels.into_iter().map(|r| ReleaseInfo {
                version: r.tag_name.trim_start_matches('v').to_string(),
                name: r.name,
                published_at: r.published_at.split('T').next().unwrap_or("").to_string(),
                is_prerelease: r.prerelease
            }).collect();
            return (HeaderMap::new(), Json(json!({ "success": true, "releases": data })));
        }
    }

    let jsd_url = format!("{}/{}", JSDELIVR_API, repo);
    if let Ok(r) = state.http_client.get(&jsd_url).send().await {
        if let Ok(jsd) = r.json::<JsdResponse>().await {
            let data: Vec<_> = jsd.versions.into_iter().take(10).map(|v| ReleaseInfo {
                version: v.clone(), name: format!("Release {}", v), published_at: String::new(), is_prerelease: false
            }).collect();
            return (HeaderMap::new(), Json(json!({ "success": true, "releases": data })));
        }
    }
    response(false, Some("Не удалось получить релизы".into()))
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let Some(repo) = get_repo(&req.core) else { return response(false, Some("Неизвестное ядро".into())); };
    let ver = if req.version.chars().next().map_or(false, |c| c.is_ascii_digit()) { format!("v{}", req.version) } else { req.version.clone() };
    let core_name_cap = req.core.chars().next().map(|c| c.to_uppercase().to_string() + &req.core[1..]).unwrap_or_default();

    log("INFO", format!("Запущено обновление {} до {}", core_name_cap, ver)).await;

    let running = crate::controller::get_pid(&req.core).is_some();
    let arch = std::env::consts::ARCH;
    let (asset_name, url) = match req.core.as_str() {
        "xray" => {
            let x = match arch {
                "aarch64" => "Xray-linux-arm64-v8a.zip",
                "mips" => if cfg!(target_endian = "little") { "Xray-linux-mips32le.zip" } else { "Xray-linux-mips32.zip" },
                _ => return response(false, Some("Архитектура не поддерживается".into()))
            };
            (x.to_string(), format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, x))
        }
        "mihomo" => {
            let m = match arch {
                "aarch64" => "arm64",
                "mips" => if cfg!(target_endian = "little") { "mipsle-softfloat" } else { "mips-softfloat" },
                _ => return response(false, Some("Архитектура не поддерживается".into()))
            };
            let mut asset = None;
            let api_url = format!("{}/{}/releases?per_page=10", GITHUB_API, repo);
            if let Ok(r) = state.http_client.get(&api_url).send().await {
                if let Ok(rels) = r.json::<Vec<GhRelease>>().await {
                    asset = rels.into_iter()
                        .find(|r| r.tag_name == ver)
                        .and_then(|r| r.assets.into_iter().find(|a| a.name.contains(&format!("mihomo-linux-{}", m)) && a.name.ends_with(".gz")));
                }
            }
            match asset {
                Some(a) => (a.name, a.browser_download_url),
                None => {
                    let name = format!("mihomo-linux-{}-v{}.gz", m, req.version);
                    (name.clone(), format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, name))
                }
            }
        }
        _ => return response(false, Some("Неизвестное ядро".into()))
    };

    log("INFO", format!("Загрузка: {}", url)).await;

    let tmp_dir = Path::new("/opt/tmp");
    _ = fs::create_dir_all(tmp_dir).await;

    let dl_tmp = tmp_dir.join("download.tmp");
    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let result = match download(&state.http_client, &url, &proxies, &dl_tmp).await {
        Ok(r) => r,
        Err(e) => return response(false, Some(e))
    };

    log("INFO", "Распаковка...".into()).await;
    let bin_path = tmp_dir.join(&req.core);
    let core_name = req.core.clone();
    let is_zip = asset_name.ends_with(".zip");
    let extracted = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut out = File::create(&bin_path)?;
        match result {
            DownloadResult::RAM(data) => {
                if is_zip {
                    let mut arc = zip::ZipArchive::new(Cursor::new(data))?;
                    std::io::copy(&mut arc.by_name(&core_name)?, &mut out)?;
                } else {
                    std::io::copy(&mut flate2::read::GzDecoder::new(Cursor::new(data)), &mut out)?;
                }
            }
            DownloadResult::Disk(path) => {
                if is_zip {
                    let mut arc = zip::ZipArchive::new(File::open(&path)?)?;
                    std::io::copy(&mut arc.by_name(&core_name)?, &mut out)?;
                } else {
                    std::io::copy(&mut flate2::read::GzDecoder::new(File::open(&path)?), &mut out)?;
                }
                drop(out);
                _ = std::fs::remove_file(&path);
            }
        }
        Ok(())
    }).await;

    match extracted {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return response(false, Some(format!("Ошибка распаковки: {}", e))),
        Err(_) => return response(false, Some("Ошибка распаковки (panic)".into()))
    }

    let target = format!("/opt/sbin/{}", req.core);

    if req.backup_core && Path::new(&target).exists() {
        let tz = state.settings.read().unwrap().log.timezone;
        let now = chrono::Utc::now() + chrono::Duration::hours(tz as i64);
        let backup = format!("/opt/sbin/core-backup/{}-{}", req.core, now.format("%Y%m%d-%H%M%S"));
        _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", backup)).await;
        _ = fs::copy(&target, &backup).await;
    }

    log("INFO", "Установка...".into()).await;

    if fs::rename(tmp_dir.join(&req.core), &target).await.is_ok() {
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if running {
            log("INFO", format!("Перезапуск {}...", core_name_cap)).await;
            crate::controller::soft_restart(&req.core).await;
        }
    } else {
        log("WARN", "Атомарная замена не удалась, использую fallback...".into()).await;
        let init = state.init_file.read().unwrap().clone();
        if running { _ = Command::new(&init).arg("stop").status().await; }
        let extracted_path = tmp_dir.join(&req.core);
        if let Err(e) = fs::copy(&extracted_path, &target).await { return response(false, Some(format!("Ошибка установки: {}", e))); }
        _ = fs::remove_file(&extracted_path).await;
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if running {
            log("INFO", "Запуск XKeen...".into()).await;
            _ = Command::new(&init).arg("start").status().await;
        }
    }

    log("INFO", format!("Обновление {} до {} завершено", core_name_cap, ver)).await;
    response(true, None)
}
