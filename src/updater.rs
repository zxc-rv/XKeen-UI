use axum::{extract::{Query, State}, response::{IntoResponse, Json}, http::{header, HeaderMap}};
use serde::Deserialize;
use serde_json::json;
use std::{path::Path, os::unix::fs::PermissionsExt};
use tokio::{process::Command, io::AsyncWriteExt, fs};
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

#[derive(Deserialize)]
struct JsdResponse { versions: Vec<String> }

async fn log(lvl: &str, msg: String) {
    let line = crate::logs::format_plain_log(lvl, &msg);
    if lvl == "ERROR" { eprintln!("{}", msg); } else { println!("{}", msg); }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG).await {
        _ = f.write_all(line.as_bytes()).await;
    }
}

fn make_res(success: bool, error: Option<String>) -> (HeaderMap, Json<serde_json::Value>) {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONNECTION, "close".parse().unwrap());
    (headers, Json(json!({ "success": success, "error": error })))
}

async fn download(url: &str, proxies: &[String]) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    match client.get(url).send().await {
        Ok(r) if r.status().is_success() => {
            use futures_util::StreamExt;
            let mut stream = r.bytes_stream();
            let mut buffer = Vec::new();

            loop {
                let chunk_timeout = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    stream.next()
                );

                match chunk_timeout.await {
                    Ok(Some(Ok(chunk))) => {
                        buffer.extend_from_slice(&chunk);
                    }
                    Ok(Some(Err(e))) => {
                        log("WARN", format!("Загрузка напрямую оборвалась: {}", e)).await;
                        break;
                    }
                    Ok(None) => {
                        if buffer.len() > 0 {
                            return Ok(buffer);
                        }
                        log("WARN", "Загрузка напрямую вернула 0 байт".into()).await;
                        break;
                    }
                    Err(_) => {
                        log("WARN", "Таймаут загрузки напрямую".into()).await;
                        break;
                    }
                }
            }
        }
        Ok(r) => log("WARN", format!("Ошибка загрузки напрямую: {}", r.status())).await,
        Err(e) => log("WARN", format!("Ошибка загрузки напрямую: {}", e)).await,
    }

    for (i, proxy) in proxies.iter().enumerate() {
        let proxied_url = format!("{}/{}", proxy, url);
        log("INFO", format!("Попытка через прокси #{}: {}", i + 1, proxy)).await;

        match client.get(&proxied_url).send().await {
            Ok(r) if r.status().is_success() => {
                let content_type = r.headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");

                if content_type.contains("text/html") {
                    log("WARN", format!("Прокси #{} вернул HTML вместо файла", i + 1)).await;
                    continue;
                }

                use futures_util::StreamExt;
                let mut stream = r.bytes_stream();
                let mut buffer = Vec::new();

                loop {
                    let chunk_timeout = tokio::time::timeout(
                        std::time::Duration::from_secs(15),
                        stream.next()
                    );

                    match chunk_timeout.await {
                        Ok(Some(Ok(chunk))) => {
                            buffer.extend_from_slice(&chunk);
                        }
                        Ok(Some(Err(e))) => {
                            log("WARN", format!("Потеряно соединение с пркоси #{}: {}", i + 1, e)).await;
                            break;
                        }
                        Ok(None) => {
                            let size = buffer.len();
                            if size == 0 {
                                log("WARN", format!("Прокси #{} вернул 0 байт", i + 1)).await;
                                break;
                            }
                            if size < 1024 * 1024 {
                                log("WARN", format!("Прокси #{} вернул подозрительно маленький файл ({} байт)", i + 1, size)).await;
                                break;
                            }
                            log("INFO", format!("Загрузка через прокси #{} успешна", i + 1)).await;
                            return Ok(buffer);
                        }
                        Err(_) => {
                            log("WARN", format!("Таймаут загрузки через прокси #{}", i + 1)).await;
                            break;
                        }
                    }
                }
                continue;
            },
            Ok(r) => log("WARN", format!("Прокси #{} вернул HTTP {}", i + 1, r.status())).await,
            Err(e) => log("WARN", format!("Прокси #{} недоступен: {}", i + 1, e)).await,
        }
    }

    Err("Не удалось загрузить файл ни напрямую, ни через прокси".into())
}

pub async fn get_releases(Query(q): Query<ReleaseQuery>) -> impl IntoResponse {
    let (repo, jsd_url) = match q.core.as_str() {
        "xray" => ("XTLS/Xray-core", "https://data.jsdelivr.com/v1/package/gh/XTLS/Xray-core"),
        "mihomo" => ("MetaCubeX/mihomo", "https://data.jsdelivr.com/v1/package/gh/MetaCubeX/mihomo"),
        _ => return make_res(false, Some("Неизвестное ядро".into()))
    };

    let client = reqwest::Client::builder()
        .user_agent("XKeen")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();

    match client.get(format!("https://api.github.com/repos/{}/releases", repo)).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(rels) = r.json::<Vec<GhRelease>>().await {
                let data: Vec<ReleaseInfo> = rels.into_iter().take(10).map(|r| ReleaseInfo {
                    version: r.tag_name.trim_start_matches('v').to_string(),
                    name: r.name,
                    published_at: r.published_at.split('T').next().unwrap_or("").to_string(),
                    is_prerelease: r.prerelease
                }).collect();
                return (HeaderMap::new(), Json(json!({ "success": true, "releases": data })));
            }
        },
        _ => {}
    }

    match client.get(jsd_url).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(jsd) = r.json::<JsdResponse>().await {
                let data: Vec<ReleaseInfo> = jsd.versions.into_iter().take(10).map(|v| ReleaseInfo {
                    version: v.clone(),
                    name: format!("Release {}", v),
                    published_at: String::new(),
                    is_prerelease: false
                }).collect();
                return (HeaderMap::new(), Json(json!({ "success": true, "releases": data })));
            }
        },
        _ => {}
    }

    (HeaderMap::new(), Json(json!({ "success": false, "error": "Не удалось получить релизы ни через GitHub API, ни через jsDelivr" })))
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let ver = if req.version.chars().next().map_or(false, |c| c.is_ascii_digit()) {
        format!("v{}", req.version)
    } else {
        req.version.clone()
    };
    let mut c = req.core.chars();
    let core_name_cap = match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    };

    log("INFO", format!("Запущено обновление {} до {}", core_name_cap, ver)).await;

    let running = crate::controller::get_pid(&req.core).is_some();
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

        let client = reqwest::Client::builder()
            .user_agent("XKeen")
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();

        if let Ok(r) = client.get("https://api.github.com/repos/MetaCubeX/mihomo/releases").send().await {
            if r.status().is_success() {
                if let Ok(rels) = r.json::<Vec<GhRelease>>().await {
                    if let Some(rel) = rels.into_iter().find(|r| r.tag_name == ver) {
                        if let Some(a) = rel.assets.into_iter().find(|a| a.name.contains(&format!("mihomo-linux-{}", pat)) && a.name.ends_with(".gz")) {
                            asset_name = a.name.clone();
                            url = a.browser_download_url;
                        }
                    }
                }
            }
        }

        if url.is_empty() {
            let inferred_name = format!("mihomo-linux-{}-{}.gz",
                match pat {
                    "arm64" => "arm64",
                    "mips-softfloat" => "mips-hardfloat",
                    "mipsle-softfloat" => "mipsle-hardfloat",
                    _ => pat
                }, ver);
            asset_name = inferred_name.clone();
            url = format!("https://github.com/MetaCubeX/mihomo/releases/download/{}/{}", ver, inferred_name);
        }
    }

    if url.is_empty() { return make_res(false, Some("Релиз или ассет не найден".into())); }

    log("INFO", format!("Загрузка: {}", url)).await;

    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let data = match download(&url, &proxies).await {
        Ok(d) => d,
        Err(e) => return make_res(false, Some(e))
    };

    let size = data.len();
    let size_mb = size as f64 / 1024.0 / 1024.0;
    let tmp_dir = Path::new("/opt/tmp");
    if fs::create_dir_all(tmp_dir).await.is_err() { return make_res(false, Some("Ошибка создания tmp директории".into())); }
    let dl_tmp = tmp_dir.join("download.tmp");
    let bin_path = tmp_dir.join(&req.core);
    let is_large = size > 50 * 1024 * 1024;
    let is_zip = asset_name.ends_with(".zip");

    if is_large {
        if let Err(_) = fs::write(&dl_tmp, &data).await {
            return make_res(false, Some("Ошибка записи на диск".into()));
        }
    }

    log("INFO", format!("Файл загружен{} ({:.1} МБ)", if is_large { " на диск" } else { " в ОЗУ" }, size_mb)).await;
    log("INFO", "Распаковка...".into()).await;

    let (ap, bp, cn, file_data) = (dl_tmp.clone(), bin_path.clone(), req.core.clone(), if is_large { None } else { Some(data) });
    let extract_res = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut out = std::fs::File::create(&bp)?;
        if is_zip {
            if let Some(b) = file_data {
                let mut arc = zip::ZipArchive::new(std::io::Cursor::new(b))?;
                std::io::copy(&mut arc.by_name(&cn)?, &mut out)?;
            } else {
                let mut arc = zip::ZipArchive::new(std::fs::File::open(&ap)?)?;
                std::io::copy(&mut arc.by_name(&cn)?, &mut out)?;
            }
        } else {
            let r: Box<dyn std::io::Read> = if let Some(ref b) = file_data {
                Box::new(std::io::Cursor::new(b))
            } else {
                Box::new(std::fs::File::open(&ap)?)
            };
            std::io::copy(&mut flate2::read::GzDecoder::new(r), &mut out)?;
        }
        Ok(())
    }).await;

    _ = fs::remove_file(&dl_tmp).await;

    match extract_res {
        Ok(Ok(())) => {},
        Ok(Err(e)) => return make_res(false, Some(format!("Ошибка распаковки: {}", e))),
        Err(_) => return make_res(false, Some("Ошибка распаковки (panic)".into()))
    }

    let target = format!("/opt/sbin/{}", req.core);
    if req.backup_core && Path::new(&target).exists() {
        let tz = state.settings.read().unwrap().logs.timezone;
        let now = chrono::Utc::now() + chrono::Duration::hours(tz as i64);
        let backup = format!("/opt/sbin/core-backup/{}-{}", req.core, now.format("%Y%m%d-%H%M%S"));
        _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", backup)).await;
        _ = fs::copy(&target, &backup).await;
    }

    log("INFO", format!("Установка {}...", core_name_cap)).await;

    if fs::rename(&bin_path, &target).await.is_ok() {
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if running {
            log("INFO", format!("Перезапуск {}...", core_name_cap)).await;
            crate::controller::soft_restart(&req.core).await;
        }
    } else {
        log("WARN", "Атомарная замена не удалась, использую fallback...".into()).await;
        let init = state.init_file.read().unwrap().clone();
        if running { _ = Command::new(&init).arg("stop").status().await; }
        if let Err(e) = fs::copy(&bin_path, &target).await {
            return make_res(false, Some(format!("Ошибка установки: {}", e)));
        }
        _ = fs::remove_file(&bin_path).await;
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if running {
            log("INFO", "Запуск XKeen...".into()).await;
            _ = Command::new(&init).arg("start").status().await;
        }
    }
    log("INFO", format!("Обновление {} до {} завершено", core_name_cap, ver)).await;
    make_res(true, None)
}