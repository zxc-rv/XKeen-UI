use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use serde::Deserialize;
use serde_json::json;
use std::{fs::{File, OpenOptions}, io::{self, copy, Write}, path::Path, process::Stdio, os::unix::fs::PermissionsExt};
use tokio::{process::Command, io::AsyncWriteExt};
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
    #[serde(default)]
    prerelease: bool,
}

#[derive(Deserialize)]
struct GhReleaseDetail {
    tag_name: String,
    name: String,
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

pub async fn get_releases(Query(q): Query<ReleaseQuery>) -> impl IntoResponse {
    let url = match q.core.as_str() {
        "xray" => "https://api.github.com/repos/XTLS/Xray-core/releases",
        "mihomo" => "https://api.github.com/repos/MetaCubeX/mihomo/releases",
        _ => return Json(json!({ "success": false, "error": "Неизвестное ядро" })),
    };

    let client = reqwest::Client::builder()
        .user_agent("XKeen")
        .timeout(std::time::Duration::from_secs(10))
        .build().unwrap();

    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => return Json(json!({ "success": false, "error": e.to_string() })),
    };

    if !resp.status().is_success() {
        return Json(json!({ "success": false, "error": format!("GitHub API: {}", resp.status()) }));
    }

    let gh_releases: Vec<GhRelease> = match resp.json().await {
        Ok(j) => j,
        Err(e) => return Json(json!({ "success": false, "error": e.to_string() })),
    };

    let releases: Vec<ReleaseInfo> = gh_releases.into_iter()
        .take(10)
        .map(|r| ReleaseInfo {
            version: r.tag_name.trim_start_matches('v').to_string(),
            name: r.name,
            published_at: r.published_at.split('T').next().unwrap_or("").to_string(),
            is_prerelease: r.prerelease,
        })
        .collect();

    Json(json!({ "success": true, "releases": releases }))
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let log = |level: &str, msg: String| {
        let log_msg = crate::logs::format_plain_log(level, &msg);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(ERROR_LOG) {
            let _ = file.write_all(log_msg.as_bytes());
        }
        eprintln!("{}", msg);
    };

    log("INFO", format!("Запуск обновления {} до версии {}", req.core, req.version));

    let ver = if req.version.starts_with('v') { req.version.clone() } else { format!("v{}", req.version) };
    let arch = std::env::consts::ARCH;

    let asset = match (req.core.as_str(), arch) {
        ("xray", "aarch64") => Some("Xray-linux-arm64-v8a.zip"),
        ("xray", "mips") => Some("Xray-linux-mips32.zip"),
        ("xray", "mipsle") => Some("Xray-linux-mips32le.zip"),
        ("mihomo", "aarch64") => Some("mihomo-linux-arm64"),
        ("mihomo", "mips") => Some("mihomo-linux-mips-softfloat"),
        ("mihomo", "mipsle") => Some("mihomo-linux-mipsle-softfloat"),
        _ => None
    };

    let Some(asset_base) = asset else {
        log("ERROR", "Архитектура не поддерживается".to_string());
        return Json(json!({ "success": false, "error": "Неподдерживаемая архитектура" }));
    };

    let asset_name = if req.core == "mihomo" {
        format!("{}-{}.gz", asset_base, ver)
    } else {
        asset_base.to_string()
    };

    let url = if req.core == "xray" {
        format!("https://github.com/XTLS/Xray-core/releases/download/{}/{}", ver, asset_name)
    } else {
        let api_url = "https://api.github.com/repos/MetaCubeX/mihomo/releases";
        let client = reqwest::Client::builder()
            .user_agent("XKeen")
            .timeout(std::time::Duration::from_secs(10))
            .build().unwrap();

        match client.get(api_url).send().await {
            Ok(r) if r.status().is_success() => {
                match r.json::<Vec<GhReleaseDetail>>().await {
                    Ok(releases) => {
                        let target_release = releases.iter().find(|rel| {
                            rel.tag_name == ver || rel.tag_name == format!("v{}", ver) ||
                            rel.name.contains(&req.version) || rel.tag_name.contains(&req.version)
                        });

                        match target_release {
                            Some(rel) => {
                                let arch_pattern = match arch {
                                    "aarch64" => "arm64",
                                    "mips" => "mips-softfloat",
                                    "mipsle" => "mipsle-softfloat",
                                    _ => ""
                                };
                                let pattern = format!("mihomo-linux-{}", arch_pattern);

                                match rel.assets.iter().find(|a| a.name.starts_with(&pattern) && a.name.ends_with(".gz")) {
                                    Some(asset) => asset.browser_download_url.clone(),
                                    None => {
                                        log("ERROR", "Ошибка определения архитектуры".to_string());
                                        return Json(json!({ "success": false, "error": "Asset не найден" }));
                                    }
                                }
                            },
                            None => {
                                log("ERROR", format!("Релиз {} не найден", req.version));
                                return Json(json!({ "success": false, "error": "Релиз не найден" }));
                            }
                        }
                    },
                    Err(e) => {
                        log("ERROR", format!("Ошибка получения данных релизов: {}", e));
                        return Json(json!({ "success": false, "error": "Ошибка API" }));
                    }
                }
            },
            Ok(r) => {
                log("ERROR", format!("Ошибка GitHub API: {}", r.status()));
                return Json(json!({ "success": false, "error": format!("Ошибка GitHub API: {}", r.status()) }));
            },
            Err(e) => {
                log("ERROR", format!("Ошибка запроса GitHub API: {}", e));
                return Json(json!({ "success": false, "error": format!("Сетевая ошибка: {}", e) }));
            }
        }
    };

    let tmp_dir = Path::new("/opt/tmp");
    if let Err(e) = tokio::fs::create_dir_all(tmp_dir).await {
        return Json(json!({ "success": false, "error": format!("Ошибка создания tmp: {}", e) }));
    }

    let archive_path = tmp_dir.join(&asset_name);
    log("INFO", format!("Скачивание: {}", url));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build().unwrap();

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            log("ERROR", format!("Ошибка HTTP запроса: {}", e));
            return Json(json!({ "success": false, "error": format!("Ошибка запроса: {}", e) }));
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        log("ERROR", format!("HTTP ошибка: {}", status));
        return Json(json!({ "success": false, "error": format!("Файл не найден ({})", status) }));
    }

    let mut file = match tokio::fs::File::create(&archive_path).await {
        Ok(f) => f,
        Err(e) => {
            log("ERROR", format!("Ошибка создания файла: {}", e));
            return Json(json!({ "success": false, "error": "Ошибка создания файла" }));
        }
    };

    let mut stream = resp.bytes_stream();
    let mut downloaded = 0u64;
    while let Some(chunk_result) = stream.next().await {
        let bytes = match chunk_result {
            Ok(b) => b,
            Err(e) => {
                log("ERROR", format!("Ошибка чтения данных: {}", e));
                return Json(json!({ "success": false, "error": "Ошибка скачивания" }));
            }
        };
        downloaded += bytes.len() as u64;
        if file.write_all(&bytes).await.is_err() {
            log("ERROR", "Ошибка записи в файл".to_string());
            return Json(json!({ "success": false, "error": "Ошибка записи файла" }));
        }
    }

    log("INFO", format!("Загрузка завершена ({:.2} МБ)", downloaded as f64 / 1024.0 / 1024.0));

    let bin_path = tmp_dir.join(&req.core);
    let is_zip = asset_name.ends_with(".zip");
    let archive_p = archive_path.clone();
    let bin_p = bin_path.clone();

    log("INFO", "Распаковка архива...".to_string());
    let extract_res = tokio::task::spawn_blocking(move || -> io::Result<()> {
        let f = File::open(&archive_p)?;
        let mut out = File::create(&bin_p)?;
        if is_zip {
            let mut zip = zip::ZipArchive::new(f)?;
            copy(&mut zip.by_name("xray")?, &mut out)?;
        } else {
            copy(&mut flate2::read::GzDecoder::new(f), &mut out)?;
        }
        Ok(())
    }).await.unwrap();

    if let Err(e) = extract_res {
        log("ERROR", format!("Ошибка распаковки: {}", e));
        return Json(json!({ "success": false, "error": format!("Ошибка распаковки: {}", e) }));
    }
    log("INFO", "Распаковка завершена".to_string());
    let _ = tokio::fs::remove_file(&archive_path).await;

    let init_file = state.init_file.read().unwrap().clone();
    let run_svc = |act: &str| {
        let cmd = init_file.clone();
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

    let is_running = crate::control::get_pid(&req.core).is_some();
    if is_running {
        log("INFO", "Остановка сервиса...".to_string());
        if let Err(e) = run_svc("stop").await {
              return Json(json!({ "success": false, "error": format!("Ошибка остановки: {}", e) }));
        }
    }

    let target_path = format!("/opt/sbin/{}", req.core);
    if req.backup_core && Path::new(&target_path).exists() {
        let backup_dir = "/opt/sbin/core-backup";
        let _ = tokio::fs::create_dir_all(backup_dir).await;
        let backup = format!("{}/{}-{}", backup_dir, req.core, Local::now().format("%Y%m%d-%H%M%S"));
        log("INFO", format!("Создание бэкапа в {}", backup));
        if let Err(e) = tokio::fs::rename(&target_path, &backup).await {
            log("ERROR", format!("Ошибка создания бэкапа: {}", e));
            return Json(json!({ "success": false, "error": format!("Ошибка бэкапа: {}", e) }));
        }
        log("INFO", "Бэкап создан успешно".to_string());
    } else {
        let _ = tokio::fs::remove_file(&target_path).await;
    }

    log("INFO", "Перемещение ядра в /opt/sbin...".to_string());
    if let Err(e) = tokio::fs::rename(&bin_path, &target_path).await {
        log("ERROR", format!("Ошибка перемещения ядра: {}", e));
        return Json(json!({ "success": false, "error": format!("Ошибка перемещения ядра: {}", e) }));
    }

    if let Err(e) = std::fs::set_permissions(&target_path, std::fs::Permissions::from_mode(0o755)) {
        log("ERROR", format!("Ошибка установки прав: {}", e));
        return Json(json!({ "success": false, "error": format!("Ошибка прав доступа: {}", e) }));
    }
    log("INFO", "Ядро успешно перемещено".to_string());

    if is_running {
        log("INFO", "Запуск сервиса...".to_string());
        if let Err(e) = run_svc("start").await {
            log("ERROR", format!("Ошибка запуска сервиса: {}", e));
            return Json(json!({ "success": false, "error": format!("Ошибка запуска: {}", e) }));
        }
    }

    log("INFO", format!("Обновление {} до версии {} успешно выполнено", req.core, req.version));
    Json(json!({ "success": true }))
}