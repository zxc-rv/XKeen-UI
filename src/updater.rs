use axum::{extract::{Query, State}, response::{IntoResponse, Json}, http::{header, HeaderMap}};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, os::unix::fs::PermissionsExt, fs::File, io::{Cursor, Read, Seek}};
use tokio::{process::Command, io::AsyncWriteExt, fs};
use futures_util::StreamExt;
use crate::types::*;

const GITHUB_API: &str = "https://api.github.com/repos";
const GITHUB_RELEASE: &str = "https://github.com";
const JSDELIVR_API: &str = "https://data.jsdelivr.com/v1/package/gh";
const XRAY_REPO: &str = "XTLS/Xray-core";
const MIHOMO_REPO: &str = "MetaCubeX/mihomo";
const XKEEN_UI_REPO: &str = "zxc-rv/XKeen-UI";

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

enum DownloadResult { RAM(Vec<u8>), Disk(PathBuf) }

fn get_repo(core: &str) -> Option<&'static str> {
    match core { "xray" => Some(XRAY_REPO), "mihomo" => Some(MIHOMO_REPO), "self" => Some(XKEEN_UI_REPO), _ => None }
}

async fn log(lvl: &str, msg: String) {
    let line = crate::logs::format_plain_log(lvl, &msg);
    if lvl == "ERROR" { eprintln!("{}", msg); } else { println!("{}", msg); }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(ERROR_LOG).await {
        _ = f.write_all(line.as_bytes()).await;
    }
}

fn response(success: bool, error: Option<String>) -> (HeaderMap, Json<Value>) {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONNECTION, "close".parse().unwrap());
    (headers, Json(json!({ "success": success, "error": error })))
}

async fn download(client: &reqwest::Client, url: &str, proxies: &[String], tmp_path: &Path) -> Result<DownloadResult, String> {
    const MB: usize = 1024 * 1024;
    async fn load(r: reqwest::Response, tmp_path: &Path, src: &str) -> Option<DownloadResult> {
        let size = r.content_length().unwrap_or(0) as usize;
        let mut stream = r.bytes_stream();
        if size > 50 * MB {
            let mut file = fs::File::create(tmp_path).await.ok()?;
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
                    Ok(Some(Ok(chunk))) => if file.write_all(&chunk).await.is_err() {
                        log("WARN", format!("Ошибка записи на диск ({})", src)).await;
                        _ = fs::remove_file(tmp_path).await; return None;
                    },
                    Ok(None) => {
                        log("INFO", format!("Файл загружен на диск ({:.1} МБ)", size as f64 / MB as f64)).await;
                        return Some(DownloadResult::Disk(tmp_path.to_path_buf()));
                    }
                    Ok(Some(Err(e))) => { log("WARN", format!("Соединение оборвалось ({}): {}", src, e)).await; _ = fs::remove_file(tmp_path).await; return None; }
                    Err(_) => { log("WARN", format!("Таймаут загрузки ({})", src)).await; _ = fs::remove_file(tmp_path).await; return None; }
                }
            }
        } else {
            let mut buf = Vec::with_capacity(if size > 0 { size } else { 15 * MB });
            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
                    Ok(Some(Ok(chunk))) => buf.extend_from_slice(&chunk),
                    Ok(None) => {
                        if buf.is_empty() { log("WARN", format!("Загрузка вернула 0 байт ({})", src)).await; return None; }
                        log("INFO", format!("Файл загружен в ОЗУ ({:.1} МБ)", buf.len() as f64 / MB as f64)).await;
                        return Some(DownloadResult::RAM(buf));
                    }
                    Ok(Some(Err(e))) => { log("WARN", format!("Соединение оборвалось ({}): {}", src, e)).await; return None; }
                    Err(_) => { log("WARN", format!("Таймаут загрузки ({})", src)).await; return None; }
                }
            }
        }
    }

    match client.get(url).send().await {
        Ok(r) if r.status().is_success() => if let Some(res) = load(r, tmp_path, "direct").await { return Ok(res); },
        Ok(r) => log("WARN", format!("Ошибка загрузки: {}", r.status())).await,
        Err(e) => log("WARN", format!("Ошибка загрузки: {}", e)).await,
    }

    for (i, proxy) in proxies.iter().enumerate() {
        let p_url = format!("{}/{}", proxy, url);
        log("INFO", format!("Попытка загрузки через прокси #{}: {}", i + 1, proxy)).await;
        match client.get(&p_url).send().await {
            Ok(r) if r.status().is_success() => {
                if r.headers().get("content-type").map_or(false, |v| v.to_str().unwrap_or("").contains("text/html")) {
                    log("WARN", format!("Прокси #{} вернул HTML", i + 1)).await; continue;
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
    if let Ok(r) = state.http_client.get(format!("{}/{}/releases?per_page=10", GITHUB_API, repo)).send().await {
        if let Ok(rels) = r.json::<Vec<GhRelease>>().await {
            let releases = rels.into_iter().map(|r| ReleaseInfo {
                version: r.tag_name.trim_start_matches('v').into(),
                name: r.name,
                published_at: r.published_at.split('T').next().unwrap_or("").into(),
                is_prerelease: r.prerelease
            }).collect::<Vec<_>>();
            return (HeaderMap::new(), Json(json!({ "success": true, "releases": releases })));
        }
    }
    if let Ok(r) = state.http_client.get(format!("{}/{}", JSDELIVR_API, repo)).send().await {
        if let Ok(jsd) = r.json::<JsdResponse>().await {
            let releases = jsd.versions.into_iter().take(10).map(|v| {
                let name = format!("Release {}", v);
                ReleaseInfo { version: v, name, published_at: String::new(), is_prerelease: false }
            }).collect::<Vec<_>>();
            return (HeaderMap::new(), Json(json!({ "success": true, "releases": releases })));
        }
    }
    response(false, Some("Не удалось получить релизы".into()))
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let Some(repo) = get_repo(&req.core) else { return response(false, Some("Неизвестное ядро".into())); };
    let ver = if req.version.chars().next().map_or(false, |c| c.is_ascii_digit()) { format!("v{}", req.version) } else { req.version.clone() };
    let core_cap = req.core.chars().next().map(|c| c.to_uppercase().to_string() + &req.core[1..]).unwrap_or_default();

    log("INFO", format!("Запущено обновление {} до {}", core_cap, ver)).await;

    if req.core == "self" {
        let arch = std::env::consts::ARCH;
        let bin_name = match arch {
            "aarch64" => "xkeen-ui-arm64-v8a",
            "mips" if cfg!(target_endian = "little") => "xkeen-ui-mips32le",
            "mips" => "xkeen-ui-mips32",
            _ => return response(false, Some("Архитектура не поддерживается".into()))
        };

        let bin_url = format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, bin_name);
        let static_url = format!("{}/{}/releases/download/{}/xkeen-ui-static.tar.gz", GITHUB_RELEASE, repo, ver);

        let tmp_dir = Path::new("/opt/tmp");
        _ = fs::create_dir_all(tmp_dir).await;
        let proxies = state.settings.read().unwrap().updater.github_proxy.clone();

        log("INFO", format!("Загрузка: {}", bin_url)).await;
        let bin_tmp = tmp_dir.join("xkeen-ui.bin.tmp");
        let bin_res = match download(&state.http_client, &bin_url, &proxies, &bin_tmp).await {
            Ok(r) => r, Err(e) => return response(false, Some(e))
        };

        log("INFO", format!("Загрузка: {}", static_url)).await;
        let static_tmp = tmp_dir.join("static.tar.gz.tmp");
        let static_res = match download(&state.http_client, &static_url, &proxies, &static_tmp).await {
            Ok(r) => r, Err(e) => return response(false, Some(e))
        };

        let bin_file = tmp_dir.join("xkeen-ui");
        match bin_res {
            DownloadResult::RAM(data) => {
                if fs::write(&bin_file, data).await.is_err() {
                    return response(false, Some("Ошибка записи бинарника".into()));
                }
            }
            DownloadResult::Disk(p) => {
                if fs::rename(&p, &bin_file).await.is_err() {
                    return response(false, Some("Ошибка перемещения бинарника".into()));
                }
            }
        }

        log("INFO", "Распаковка static файлов...".into()).await;
        let www_dir = PathBuf::from("/opt/share/www/XKeen-UI");
        let unpack_result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            use flate2::read::GzDecoder;
            use tar::Archive;
            let reader: Box<dyn Read> = match &static_res {
                DownloadResult::RAM(data) => Box::new(Cursor::new(data.clone())),
                DownloadResult::Disk(p) => Box::new(File::open(p)?)
            };
            let gz = GzDecoder::new(reader);
            let mut archive = Archive::new(gz);
            archive.unpack(&www_dir)?;
            if let DownloadResult::Disk(p) = &static_res {
                _ = std::fs::remove_file(p);
            }
            Ok(())
        }).await;

        if let Ok(Err(e)) = unpack_result {
            return response(false, Some(format!("Ошибка распаковки static: {}", e)));
        }
        if unpack_result.is_err() {
            return response(false, Some("Ошибка распаковки static (panic)".into()));
        }

        let target = "/opt/sbin/xkeen-ui";
        if req.backup_core && Path::new(target).exists() {
            let tz = state.settings.read().unwrap().log.timezone as i64;
            let now = chrono::Utc::now() + chrono::Duration::hours(tz);
            let bk = format!("/opt/sbin/core-backup/xkeen-ui-{}", now.format("%Y%m%d-%H%M%S"));
            _ = fs::create_dir_all("/opt/sbin/core-backup").await;
            log("INFO", format!("Создание бэкапа: {}", bk)).await;
            _ = fs::copy(target, &bk).await;
        }

        log("INFO", "Установка обновления...".into()).await;
        if fs::rename(&bin_file, target).await.is_err() {
            if let Err(e) = fs::copy(&bin_file, target).await {
                return response(false, Some(format!("Ошибка установки: {}", e)));
            }
            _ = fs::remove_file(&bin_file).await;
        }
        _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;

        log("INFO", format!("Обновление панели до {} завершено", ver)).await;

        if Path::new(S99XKEEN_UI).exists() {
            let restart_cmd = format!("sleep 1 && {} start > /dev/null 2>&1 &", S99XKEEN_UI);
            log("INFO", "Перезапуск панели...".into()).await;
            _ = Command::new("sh").args(&["-c", &restart_cmd]).spawn();
            tokio::spawn(async { std::process::exit(0); });
        } else {
            log("WARN", "Init скрипт панели не найден, требуется ручной перезапуск".into()).await;
        }
        return response(true, None);
    }

    let arch = std::env::consts::ARCH;
    let (asset_name, url) = match req.core.as_str() {
        "xray" => {
            let x = match arch {
                "aarch64" => "Xray-linux-arm64-v8a.zip",
                "mips" if cfg!(target_endian = "little") => "Xray-linux-mips32le.zip",
                "mips" => "Xray-linux-mips32.zip",
                _ => return response(false, Some("Архитектура не поддерживается".into()))
            };
            (x.into(), format!("{GITHUB_RELEASE}/{repo}/releases/download/{ver}/{x}"))
        }
        "mihomo" => {
            let m = match arch {
                "aarch64" => "arm64",
                "mips" if cfg!(target_endian = "little") => "mipsle-softfloat",
                "mips" => "mips-softfloat",
                _ => return response(false, Some("Архитектура не поддерживается".into()))
            };
            if ver == "Prerelease-Alpha" {
              let mut found = None;
                if let Ok(r) = state.http_client.get(format!("{}/{}/releases?per_page=10", GITHUB_API, repo)).send().await {
                    if let Ok(rels) = r.json::<Vec<GhRelease>>().await {
                        found = rels.into_iter().find(|r| r.tag_name == ver)
                            .and_then(|r| r.assets.into_iter().find(|a| a.name.contains(&format!("mihomo-linux-{}", m)) && a.name.ends_with(".gz")));
                    }
                }
                match found {
                    Some(a) => (a.name, a.browser_download_url),
                    None => return response(false, Some("Релиз или ассет не найден".into()))
                }
            } else {
                let n = format!("mihomo-linux-{}-{}.gz", m, ver);
                let url = format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, n);
                (n, url)
            }
        }
        _ => return response(false, Some("Неизвестное ядро".into()))
    };

    log("INFO", format!("Загрузка: {}", url)).await;
    let tmp_dir = Path::new("/opt/tmp");
    _ = fs::create_dir_all(tmp_dir).await;
    let dl_tmp = tmp_dir.join("download.tmp");
    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let res = match download(&state.http_client, &url, &proxies, &dl_tmp).await {
        Ok(r) => r, Err(e) => return response(false, Some(e))
    };

    log("INFO", "Распаковка файла...".into()).await;
    let (bin, core_name, is_zip) = (tmp_dir.join(&req.core), req.core.clone(), asset_name.ends_with(".zip"));

    fn unpack_stream<R: Read + Seek>(rdr: R, out_path: &Path, core: &str, is_zip: bool) -> std::io::Result<()> {
        let mut out = File::create(out_path)?;
        if is_zip {
            let mut arc = zip::ZipArchive::new(rdr)?;
            std::io::copy(&mut arc.by_name(core)?, &mut out)?;
        } else {
            std::io::copy(&mut flate2::read::GzDecoder::new(rdr), &mut out)?;
        }
        out.sync_data()?;
        Ok(())
    }

    let extracted = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        match res {
            DownloadResult::RAM(d) => unpack_stream(Cursor::new(d), &bin, &core_name, is_zip)?,
            DownloadResult::Disk(p) => {
                unpack_stream(File::open(&p)?, &bin, &core_name, is_zip)?;
                _ = std::fs::remove_file(p);
            }
        };
        Ok(())
    }).await;

    if let Ok(Err(e)) = extracted { return response(false, Some(format!("Ошибка распаковки: {}", e))); }
    if extracted.is_err() { return response(false, Some("Ошибка распаковки (panic)".into())); }

    let target = format!("/opt/sbin/{}", req.core);
    if req.backup_core && Path::new(&target).exists() {
        let tz = state.settings.read().unwrap().log.timezone as i64;
        let now = chrono::Utc::now() + chrono::Duration::hours(tz);
        let bk = format!("/opt/sbin/core-backup/{}-{}", req.core, now.format("%Y%m%d-%H%M%S"));
        _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", bk)).await;
        _ = fs::copy(&target, &bk).await;
    }

    log("INFO", "Установка обновления...".into()).await;
    let running = crate::controller::get_pid(&req.core).is_some();
    let src = tmp_dir.join(&req.core);

    if fs::rename(&src, &target).await.is_ok() {
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if running {
            log("INFO", format!("Перезапуск {}...", core_cap)).await;
            crate::controller::soft_restart(&req.core).await;
        }
    } else {
        log("WARN", "Атомарная замена не удалась, использую fallback...".into()).await;
        let init = state.init_file.read().unwrap().clone();
        if running { _ = Command::new(&init).arg("stop").status().await; }
        if let Err(e) = fs::copy(&src, &target).await { return response(false, Some(format!("Ошибка установки: {}", e))); }
        _ = fs::remove_file(&src).await;
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if running {
            log("INFO", "Запуск XKeen...".into()).await;
            _ = Command::new(&init).arg("start").status().await;
        }
    }
    log("INFO", format!("Обновление {} до {} завершено", core_cap, ver)).await;
    response(true, None)
}