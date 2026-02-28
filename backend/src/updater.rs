use axum::{extract::{Query, State}, response::{IntoResponse, Json}, http::{header, HeaderMap}};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, os::unix::fs::PermissionsExt, fs::File, io::{Cursor, Read, Seek, Write}};
use tokio::{process::Command, io::AsyncWriteExt, fs};
use futures_util::StreamExt;
use std::process::Stdio;
use crate::types::*;
use crate::logger::log;

const GITHUB_API: &str = "https://api.github.com/repos";
const GITHUB_RELEASE: &str = "https://github.com";
const JSDELIVR_API: &str = "https://data.jsdelivr.com/v1/package/gh";

#[derive(Deserialize)] pub struct ReleaseQuery { core: String }
#[derive(Deserialize)] struct GhRelease { tag_name: String, #[serde(default)] name: String, #[serde(default)] published_at: String, #[serde(default)] prerelease: bool, #[serde(default)] assets: Vec<GhAsset>, #[serde(default)] body: String }
#[derive(Deserialize, Default)] struct GhAsset { #[serde(default)] name: String, #[serde(default)] browser_download_url: String }
#[derive(Deserialize)] struct JsdResponse { versions: Vec<String> }

enum DownloadResult { RAM(Vec<u8>), Disk(PathBuf) }

fn get_repo(core: &str) -> Option<&'static str> {
    match core {
      "xray" => Some("XTLS/Xray-core"),
      "mihomo" => Some("MetaCubeX/mihomo"),
      "self" => Some("zxc-rv/XKeen-UI"),
      _ => None }
}

pub async fn fetch_latest_version(client: &reqwest::Client, core: &str) -> Option<String> {
    let repo = get_repo(core)?;
    let res = client.get(format!("{}/{}/releases?per_page=10", GITHUB_API, repo)).send().await.ok()?;
    let rels = res.json::<Vec<GhRelease>>().await.ok()?;
    rels.into_iter().find(|r| !r.prerelease).map(|r| r.tag_name.trim_start_matches('v').to_string())
}

fn response(success: bool, error: Option<String>) -> (HeaderMap, Json<Value>) {
    let mut h = HeaderMap::new(); h.insert(header::CONNECTION, "close".parse().unwrap());
    (h, Json(json!({ "success": success, "error": error })))
}

async fn download(client: &reqwest::Client, url: &str, proxies: &[String], tmp_path: &Path) -> Result<DownloadResult, String> {
    async fn load(r: reqwest::Response, path: &Path, source: &str) -> Option<DownloadResult> {
        let size = r.content_length().unwrap_or(0) as usize;
        let (mut stream, is_disk) = (r.bytes_stream(), size > 50 * 1024 * 1024);
        let mut file = if is_disk { Some(fs::File::create(path).await.ok()?) } else { None };
        let mut buf = if is_disk { Vec::new() } else { Vec::with_capacity(if size > 0 { size } else { 15 * 1024 * 1024 }) };

        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
                Ok(Some(Ok(chunk))) => if let Some(f) = &mut file {
                    if f.write_all(&chunk).await.is_err() { log("WARN", format!("Ошибка записи на диск ({})", source)); _ = fs::remove_file(path); return None; }
                } else { buf.extend_from_slice(&chunk); },
                Ok(None) => {
                    if !is_disk && buf.is_empty() { log("WARN", format!("Загрузка вернула 0 байт ({})", source)); return None; }
                    log("INFO", format!("Файл загружен {} ({:.1} МБ)", if is_disk { "на диск" } else { "в ОЗУ" }, (if is_disk { size } else { buf.len() }) as f64 / 1048576.0));
                    return Some(if is_disk { DownloadResult::Disk(path.to_path_buf()) } else { DownloadResult::RAM(buf) });
                }
                Ok(Some(Err(e))) => { log("WARN", format!("Соединение оборвалось ({}): {}", source, e)); break; }
                Err(_) => { log("WARN", format!("Таймаут загрузки ({})", source)); break; }
            }
        }
        if is_disk { _ = fs::remove_file(path).await; }
        None
    }

    let list = std::iter::once(url.to_string()).chain(proxies.iter().map(|p| format!("{}/{}", p, url)));
    for (i, u) in list.enumerate() {
        let (source, is_proxy) = if i == 0 { ("напрямую", false) } else { ("прокси", true) };
        if is_proxy { log("INFO", format!("Попытка загрузки через прокси #{}: {}", i, proxies[i-1])); }

        match client.get(&u).send().await {
            Ok(r) if r.status().is_success() => {
                if is_proxy && r.headers().get("content-type").map_or(false, |v| v.to_str().unwrap_or("").contains("text/html")) {
                    log("WARN", format!("Прокси #{} вернул HTML", i)); continue;
                }
                if let Some(res) = load(r, tmp_path, &format!("{}{}", source, if is_proxy { format!(" #{}", i) } else { "".into() })).await { return Ok(res); }
            }
            Ok(r) => log("WARN", format!("Ошибка загрузки: {}", r.status())),
            Err(e) => log("WARN", format!("Ошибка загрузки: {}", e)),
        }
    }
    log("ERROR", "Не удалось выполнить обновление".into());
    Err("Не удалось выполнить обновление".into())
}

pub async fn get_releases(State(state): State<AppState>, Query(q): Query<ReleaseQuery>) -> impl IntoResponse {
    let Some(repo) = get_repo(&q.core) else { return response(false, Some("Неизвестное ядро".into())); };

    if let Ok(res) = state.http_client.get(format!("{}/{}/releases?per_page=10", GITHUB_API, repo)).send().await {
        if let Ok(rels) = res.json::<Vec<GhRelease>>().await {
            return (HeaderMap::new(), Json(json!({ "success": true, "source": "github", "releases": rels.into_iter().map(|r| ReleaseInfo {
                version: r.tag_name.trim_start_matches('v').into(), name: r.name,
                published_at: r.published_at.split('T').next().unwrap_or("").into(), is_prerelease: r.prerelease, body: r.body
            }).collect::<Vec<_>>() })));
        }
    }
    if let Ok(res) = state.http_client.get(format!("{}/{}", JSDELIVR_API, repo)).send().await {
        if let Ok(jsd) = res.json::<JsdResponse>().await {
            return (HeaderMap::new(), Json(json!({ "success": true, "source": "jsdelivr", "releases": jsd.versions.into_iter().take(10).map(|v| ReleaseInfo {
                version: v.clone(), name: format!("Release {}", v), published_at: String::new(), is_prerelease: false, body: String::new()
            }).collect::<Vec<_>>() })));
        }
    }
    response(false, Some("Не удалось получить релизы".into()))
}

async fn install_jq() -> Result<(), String> {
    log("INFO", "Установка jq через opkg...".into());
    let update = Command::new("opkg").arg("update").status().await.map_err(|e| format!("opkg update: {}", e))?;
    if !update.success() { return Err("Ошибка обновления opkg кеша".into()); }
    let install = Command::new("opkg").args(["install", "jq"]).status().await.map_err(|e| format!("opkg install jq: {}", e))?;
    if !install.success() { return Err("Ошибка установки jq".into()); }
    log("INFO", "Пакет jq установлен".into());
    Ok(())
}

async fn install_yq(client: &reqwest::Client, proxies: &[String], tmp_dir: &Path) -> Result<(), String> {
    let arch = std::env::consts::ARCH;
    let url = match arch {
        "aarch64" => format!("{}/mikefarah/yq/releases/latest/download/yq_linux_arm64", GITHUB_RELEASE),
        "mips" if cfg!(target_endian = "little") => format!("{}/mikefarah/yq/releases/download/v4.52.2/yq_linux_mipsle", GITHUB_RELEASE),
        "mips" => format!("{}/mikefarah/yq/releases/download/v4.52.2/yq_linux_mips", GITHUB_RELEASE),
        _ => return Err("Архитектура не поддерживается для yq".into()),
    };

    log("INFO", format!("Загрузка yq: {}", url));
    let dl_res = download(client, &url, proxies, &tmp_dir.join("yq.tmp")).await?;

    let target = "/opt/sbin/yq";
    let tmp_bin = tmp_dir.join("yq.bin");
    let written = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut out = File::create(&tmp_bin)?;
        match dl_res {
            DownloadResult::RAM(d) => out.write_all(&d)?,
            DownloadResult::Disk(p) => { std::io::copy(&mut File::open(&p)?, &mut out)?; _ = std::fs::remove_file(p); }
        }
        out.sync_data()
    }).await;

    if let Ok(Err(e)) | Err(e) = written.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) {
        return Err(format!("Ошибка записи yq: {}", e));
    }

    let src = tmp_dir.join("yq.bin");
    if fs::rename(&src, target).await.is_err() {
        fs::copy(&src, target).await.map_err(|e| format!("Ошибка установки yq: {}", e))?;
        _ = fs::remove_file(&src).await;
    }
    _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;
    log("INFO", "Пакет yq установлен".into());
    Ok(())
}

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let Some(repo) = get_repo(&req.core) else { return response(false, Some("Неизвестное ядро".into())); };
    let ver = if req.version.chars().next().map_or(false, |c| c.is_ascii_digit()) { format!("v{}", req.version) } else { req.version.clone() };
    let core_cap = req.core.chars().next().map(|c| c.to_uppercase().to_string() + &req.core[1..]).unwrap_or_default();

    log("INFO", format!("Запущено обновление {} до {}", if req.core == "self" { "XKeen UI" } else { &core_cap }, ver));

    let tmp_dir = Path::new("/opt/tmp"); _ = fs::create_dir_all(tmp_dir).await;
    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let arch = std::env::consts::ARCH;

    if req.core == "self" {
        let a = match arch {
          "aarch64" => "arm64-v8a",
          "mips" if cfg!(target_endian = "little") => "mips32le",
          "mips" => "mips32",
          _ => return response(false, Some("Архитектура не поддерживается".into()))
        };

        log("INFO", "Загрузка файлов...".into());
        let (bin, stat) = (tmp_dir.join("bin.tmp"), tmp_dir.join("static.tmp"));
        let bin_url = format!("{}/{}/releases/download/{}/xkeen-ui-{}", GITHUB_RELEASE, repo, ver, a);
        let stat_url = format!("{}/{}/releases/download/{}/xkeen-ui-static.tar.gz", GITHUB_RELEASE, repo, ver);
        let (b_res, s_res) = tokio::join!(
            download(&state.http_client, &bin_url, &proxies, &bin),
            download(&state.http_client, &stat_url, &proxies, &stat)
        );
        let (bin_d, stat_d) = match (b_res, s_res) { (Ok(b), Ok(s)) => (b, s), (Err(e), _) | (_, Err(e)) => return response(false, Some(e)) };

        log("INFO", "Сохранение и распаковка файлов...".into());
        let unpack = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            if let Ok(e) = std::fs::read_dir(STATIC_DIR) {
                for p in e.flatten().map(|x| x.path()) {
                    if !["monaco-editor", "local_mode.js", "config.json"].contains(&p.file_name().and_then(|n| n.to_str()).unwrap_or("")) {
                        _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
                    }
                }
            }
            let mut out = File::create(tmp_dir.join("xkeen-ui"))?;
            match bin_d {
              DownloadResult::RAM(d) => out.write_all(&d)?,
              DownloadResult::Disk(p) => {
                std::io::copy(&mut File::open(&p)?, &mut out)?;
                _ = std::fs::remove_file(p);
              }
            }

            fn unpack<R: Read>(r: R) -> std::io::Result<()> { tar::Archive::new(flate2::read::GzDecoder::new(r)).unpack(STATIC_DIR) }

            match &stat_d {
                DownloadResult::RAM(d) => unpack(Cursor::new(d.clone()))?,
                DownloadResult::Disk(p) => unpack(File::open(p)?)?
            };
            if let DownloadResult::Disk(p) = stat_d { _ = std::fs::remove_file(p); }
            Ok(())
        }).await;

        if let Ok(Err(e)) | Err(e) = unpack.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) { return response(false, Some(format!("Ошибка распаковки: {}", e))); }

        log("INFO", "Установка обновления...".into());
        let (target, source) = ("/opt/sbin/xkeen-ui", tmp_dir.join("xkeen-ui"));
        if let Err(e) = fs::rename(&source, target).await { return response(false, Some(format!("Ошибка установки: {}", e))); }

        _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;
        _ = tokio::task::spawn_blocking(rustix::fs::sync).await;

        log("INFO", format!("Обновление XKeen UI до {} завершено", ver));
        if Path::new(S99XKEEN_UI).exists() {
            log("INFO", "Перезапуск...".into());
            _ = Command::new(S99XKEEN_UI).arg("restart").stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        } else {
          log("WARN", "Init скрипт панели не найден, требуется ручной перезапуск".into());
        }
        return response(true, None);
    }

    let (asset, url) = match req.core.as_str() {
        "xray" => {
            let x = match arch {
              "aarch64" => "Xray-linux-arm64-v8a.zip",
              "mips" if cfg!(target_endian = "little") => "Xray-linux-mips32le.zip",
              "mips" => "Xray-linux-mips32.zip",
              _ => return response(false, Some("Архитектура не поддерживается".into()))
            };
            (x.into(), format!("{GITHUB_RELEASE}/{repo}/releases/download/{ver}/{x}"))
        },
        "mihomo" => {
            let m = match arch {
              "aarch64" => "arm64",
              "mips" if cfg!(target_endian = "little") => "mipsle-softfloat",
              "mips" => "mips-softfloat",
              _ => return response(false, Some("Архитектура не поддерживается".into()))
            };
            if ver == "Prerelease-Alpha" {
                let mut found = None;
                if let Ok(res) = state.http_client.get(format!("{}/{}/releases?per_page=10", GITHUB_API, repo)).send().await {
                    if let Ok(rels) = res.json::<Vec<GhRelease>>().await {
                        found = rels.into_iter().find(|r| r.tag_name == ver).and_then(|r| r.assets.into_iter().find(|a| a.name.contains(&format!("mihomo-linux-{}", m)) && a.name.ends_with(".gz")));
                    }
                }
                match found {
                  Some(a) => (a.name, a.browser_download_url),
                  None => return response(false, Some("Релиз или ассет не найден".into()))
                }
            } else {
              let n = format!("mihomo-linux-{}-{}.gz", m, ver);
              (n.clone(), format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, n))
            }
        },
        _ => return response(false, Some("Неизвестное ядро".into()))
    };

    match req.core.as_str() {
        "xray" if !Path::new("/opt/bin/jq").exists() => {
            log("WARN", "Пакет jq не найден".into());
            if let Err(e) = install_jq().await { return response(false, Some(e)); }
        }
        "mihomo" if !Path::new("/opt/sbin/yq").exists() => {
            log("WARN", "Пакет yq не найден".into());
            if let Err(e) = install_yq(&state.http_client, &proxies, tmp_dir).await { return response(false, Some(e)); }
        }
        _ => {}
    }

    log("INFO", format!("Загрузка: {}", url));
    let dl_res = match download(&state.http_client, &url, &proxies, &tmp_dir.join("download.tmp")).await { Ok(r) => r, Err(e) => return response(false, Some(e)) };

    log("INFO", "Распаковка файла...".into());
    let (core_name, is_zip) = (req.core.clone(), asset.ends_with(".zip"));

    fn unpack<R: Read + Seek>(rdr: R, out_path: &Path, core: &str, is_zip: bool) -> std::io::Result<()> {
        let mut out = File::create(out_path)?;
        if is_zip { std::io::copy(&mut zip::ZipArchive::new(rdr)?.by_name(core)?, &mut out)?; }
        else { std::io::copy(&mut flate2::read::GzDecoder::new(rdr), &mut out)?; }
        out.sync_data()?;
        Ok(())
    }

    let unpack = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let bin = tmp_dir.join(&core_name);
        match dl_res {
            DownloadResult::RAM(d) => unpack(Cursor::new(d), &bin, &core_name, is_zip)?,
            DownloadResult::Disk(p) => {
              unpack(File::open(&p)?, &bin, &core_name, is_zip)?;
              _ = std::fs::remove_file(p);
            }
        };
        Ok(())
    }).await;

    if let Ok(Err(e)) | Err(e) = unpack.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) { return response(false, Some(format!("Ошибка распаковки: {}", e))); }

    let target = format!("/opt/sbin/{}", req.core);
    if req.backup_core && Path::new(&target).exists() {
        let bk = format!("/opt/sbin/core-backup/{}-{}", req.core, (chrono::Utc::now() + chrono::Duration::hours(state.settings.read().unwrap().log.timezone as i64)).format("%Y%m%d-%H%M%S"));
        _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", bk));
        _ = fs::copy(&target, &bk).await;
    }

    log("INFO", "Установка обновления...".into());
    let (run, source) = (crate::controller::get_pid(&req.core).is_some(), tmp_dir.join(&req.core));
    if fs::rename(&source, &target).await.is_ok() {
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run { log("INFO", format!("Перезапуск {}...", core_cap)); crate::controller::soft_restart(&req.core).await; }
    } else {
        log("WARN", "Атомарная замена не удалась, фолбек на копирование...".into());
        let init = state.init_file.read().unwrap().clone();
        if run { _ = Command::new(&init).arg("stop").status().await; }
        if let Err(e) = fs::copy(&source, &target).await { return response(false, Some(format!("Ошибка установки: {}", e))); }
        _ = fs::remove_file(&source).await; _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run { log("INFO", "Запуск XKeen...".into()); _ = Command::new(&init).arg("start").status(); }
    }

    log("INFO", format!("Обновление {} до {} завершено", core_cap, ver));
    { let mut c = state.update_checker.core_outdated.write().unwrap(); *c = false; }
    { let mut c = state.update_checker.last_core_check.write().unwrap(); *c = None; }
    *state.update_checker.last_core_toast.write().unwrap() = None;

    response(true, None)
}