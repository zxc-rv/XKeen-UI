use crate::logger::log;
use crate::types::*;
use axum::{
    extract::State,
    http::{HeaderMap, header},
    response::{IntoResponse, Json},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::process::Stdio;
use std::{
    fs::File,
    io::{Cursor, Read, Seek, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{fs, io::AsyncWriteExt, process::Command};

const GITHUB_API: &str = "https://api.github.com/repos";
const GITHUB_RELEASE: &str = "https://github.com";

#[derive(Deserialize)]
struct GhAsset {
    name: String,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

enum DownloadResult {
    RAM(Vec<u8>),
    Disk(PathBuf),
}

fn get_repo(core: &str) -> Option<&'static str> {
    match core {
        "xray" => Some("XTLS/Xray-core"),
        "mihomo" => Some("MetaCubeX/mihomo"),
        "self" => Some("zxc-rv/XKeen-UI"),
        _ => None,
    }
}

pub async fn fetch_latest_version(
    client: &reqwest::Client,
    core: &str,
    proxies: &[String],
    current_ver: Option<&str>,
) -> Option<String> {
    let repo = get_repo(core)?;
    let url = format!("{}/{}/releases?per_page=10", GITHUB_API, repo);
    let list = std::iter::once(url.clone()).chain(
        proxies
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(|p| format!("{}/{}", p.trim_end_matches('/'), url)),
    );

    let is_alpha = current_ver.map_or(false, |v| v.contains("alpha"));

    for u in list {
        let res = match client
            .get(&u)
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        if res
            .headers()
            .get("content-type")
            .map_or(false, |v| v.to_str().unwrap_or("").contains("text/html"))
        {
            continue;
        }
        let rels = match res.json::<Vec<GhRelease>>().await {
            Ok(v) => v,
            Err(_) => continue,
        };

        if is_alpha && core == "mihomo" {
            if let Some(r) = rels.iter().find(|r| r.tag_name == "Prerelease-Alpha") {
                for asset in &r.assets {
                    if let Some(idx) = asset.name.find("alpha-") {
                        let hash = asset.name[idx..]
                            .trim_end_matches(".gz")
                            .trim_end_matches(".zip");
                        return Some(hash.to_string());
                    }
                }
            }
        }

        if let Some(r) = rels.into_iter().find(|r| !r.prerelease) {
            return Some(r.tag_name.trim_start_matches('v').to_string());
        }
    }
    None
}

fn response(success: bool, error: Option<String>) -> (HeaderMap, Json<Value>) {
    let mut h = HeaderMap::new();
    h.insert(header::CONNECTION, "close".parse().unwrap());
    (h, Json(json!({ "success": success, "error": error })))
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    proxies: &[String],
    tmp_path: &Path,
) -> Result<DownloadResult, String> {
    async fn load(r: reqwest::Response, path: &Path, source: &str) -> Option<DownloadResult> {
        let size = r.content_length().unwrap_or(0) as usize;
        let (mut stream, is_disk) = (r.bytes_stream(), size > 50 * 1024 * 1024);
        let mut file = if is_disk {
            Some(fs::File::create(path).await.ok()?)
        } else {
            None
        };
        let mut buf = if is_disk {
            Vec::new()
        } else {
            Vec::with_capacity(if size > 0 { size } else { 5 * 1024 * 1024 })
        };

        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    if let Some(f) = &mut file {
                        if f.write_all(&chunk).await.is_err() {
                            log("WARN", format!("Ошибка записи на диск ({})", source));
                            _ = fs::remove_file(path);
                            return None;
                        }
                    } else {
                        buf.extend_from_slice(&chunk);
                    }
                }
                Ok(None) => {
                    if !is_disk && buf.is_empty() {
                        log("WARN", format!("Загрузка вернула 0 байт ({})", source));
                        return None;
                    }
                    log(
                        "INFO",
                        format!(
                            "Файл загружен {} ({:.1} МБ)",
                            if is_disk {
                                "на диск"
                            } else {
                                "в ОЗУ"
                            },
                            (if is_disk { size } else { buf.len() }) as f64 / 1048576.0
                        ),
                    );
                    return Some(if is_disk {
                        DownloadResult::Disk(path.to_path_buf())
                    } else {
                        DownloadResult::RAM(buf)
                    });
                }
                Ok(Some(Err(e))) => {
                    log("WARN", format!("Соединение оборвалось ({}): {}", source, e));
                    break;
                }
                Err(_) => {
                    log("WARN", format!("Таймаут загрузки ({})", source));
                    break;
                }
            }
        }
        if is_disk {
            _ = fs::remove_file(path).await;
        }
        None
    }

    let list =
        std::iter::once(url.to_string()).chain(proxies.iter().map(|p| format!("{}/{}", p, url)));
    for (i, u) in list.enumerate() {
        let (source, is_proxy) = if i == 0 {
            ("напрямую", false)
        } else {
            ("прокси", true)
        };
        if is_proxy {
            log(
                "INFO",
                format!("Попытка загрузки через прокси #{}: {}", i, proxies[i - 1]),
            );
        }

        match client.get(&u).send().await {
            Ok(r) if r.status().is_success() => {
                if is_proxy
                    && r.headers()
                        .get("content-type")
                        .map_or(false, |v| v.to_str().unwrap_or("").contains("text/html"))
                {
                    log("WARN", format!("Прокси #{} вернул HTML", i));
                    continue;
                }
                if let Some(res) = load(
                    r,
                    tmp_path,
                    &format!(
                        "{}{}",
                        source,
                        if is_proxy {
                            format!(" #{}", i)
                        } else {
                            "".into()
                        }
                    ),
                )
                .await
                {
                    return Ok(res);
                }
            }
            Ok(r) => log("WARN", format!("Ошибка загрузки: {}", r.status())),
            Err(e) => log("WARN", format!("Ошибка загрузки: {}", e)),
        }
    }
    log("ERROR", "Не удалось выполнить обновление".into());
    Err("Не удалось выполнить обновление".into())
}

async fn install_jq() -> Result<(), String> {
    log("INFO", "Установка jq через opkg...".into());
    let update = Command::new("opkg")
        .arg("update")
        .status()
        .await
        .map_err(|e| format!("opkg update: {}", e))?;
    if !update.success() {
        return Err("Ошибка обновления opkg кеша".into());
    }
    let install = Command::new("opkg")
        .args(["install", "jq"])
        .status()
        .await
        .map_err(|e| format!("opkg install jq: {}", e))?;
    if !install.success() {
        return Err("Ошибка установки jq".into());
    }
    log("INFO", "Пакет jq установлен".into());
    Ok(())
}

async fn install_yq(
    client: &reqwest::Client,
    proxies: &[String],
    tmp_dir: &Path,
) -> Result<(), String> {
    let arch = std::env::consts::ARCH;
    let url = match arch {
        "aarch64" => format!(
            "{}/mikefarah/yq/releases/latest/download/yq_linux_arm64",
            GITHUB_RELEASE
        ),
        "mips" if cfg!(target_endian = "little") => format!(
            "{}/mikefarah/yq/releases/download/v4.52.2/yq_linux_mipsle",
            GITHUB_RELEASE
        ),
        "mips" => format!(
            "{}/mikefarah/yq/releases/download/v4.52.2/yq_linux_mips",
            GITHUB_RELEASE
        ),
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
            DownloadResult::Disk(p) => {
                std::io::copy(&mut File::open(&p)?, &mut out)?;
                _ = std::fs::remove_file(p);
            }
        }
        out.sync_data()
    })
    .await;

    if let Ok(Err(e)) | Err(e) =
        written.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    {
        return Err(format!("Ошибка записи yq: {}", e));
    }

    let src = tmp_dir.join("yq.bin");
    if fs::rename(&src, target).await.is_err() {
        fs::copy(&src, target)
            .await
            .map_err(|e| format!("Ошибка установки yq: {}", e))?;
        _ = fs::remove_file(&src).await;
    }
    _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;
    log("INFO", "Пакет yq установлен".into());
    Ok(())
}

pub async fn post_update(
    State(state): State<AppState>,
    Json(req): Json<UpdateReq>,
) -> impl IntoResponse {
    let Some(repo) = get_repo(&req.core) else {
        return response(false, Some("Неизвестное ядро".into()));
    };
    let ver = if req
        .version
        .chars()
        .next()
        .map_or(false, |c| c.is_ascii_digit())
    {
        format!("v{}", req.version)
    } else {
        req.version.clone()
    };
    let core_cap = req
        .core
        .chars()
        .next()
        .map(|c| c.to_uppercase().to_string() + &req.core[1..])
        .unwrap_or_default();

    log(
        "INFO",
        format!(
            "Запущено обновление {} до {}",
            if req.core == "self" {
                "XKeen UI"
            } else {
                &core_cap
            },
            ver
        ),
    );

    let tmp_dir = Path::new("/opt/tmp");
    _ = fs::create_dir_all(tmp_dir).await;
    let proxies = state.settings.read().unwrap().updater.github_proxy.clone();
    let arch = std::env::consts::ARCH;

    if req.core == "self" {
        let a = match arch {
            "aarch64" => "arm64-v8a",
            "mips" if cfg!(target_endian = "little") => {
                if Path::new("/lib/ld-musl-mipsel-sf.so.1").exists() {
                    "mips32le"
                } else {
                    "mips32le-gnu"
                }
            }
            "mips" => "mips32",
            _ => return response(false, Some("Архитектура не поддерживается".into())),
        };

        log("INFO", "Загрузка исполняемого файла...".into());
        let bin_url = format!(
            "{}/{}/releases/download/{}/xkeen-ui-{}",
            GITHUB_RELEASE, repo, ver, a
        );
        let bin_d = match download(
            &state.http_client,
            &bin_url,
            &proxies,
            &tmp_dir.join("bin.tmp"),
        )
        .await
        {
            Ok(d) => d,
            Err(e) => return response(false, Some(e)),
        };

        log("INFO", "Сохранение файла...".into());
        let unpack = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut out = File::create(tmp_dir.join("xkeen-ui"))?;
            match bin_d {
                DownloadResult::RAM(d) => out.write_all(&d)?,
                DownloadResult::Disk(p) => {
                    std::io::copy(&mut File::open(&p)?, &mut out)?;
                    _ = std::fs::remove_file(p);
                }
            }
            out.sync_data()
        })
        .await;

        if let Ok(Err(e)) | Err(e) =
            unpack.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        {
            return response(false, Some(format!("Ошибка распаковки: {}", e)));
        }

        log("INFO", "Установка обновления...".into());
        let (target, source) = ("/opt/sbin/xkeen-ui", tmp_dir.join("xkeen-ui"));
        if let Err(e) = fs::rename(&source, target).await {
            return response(false, Some(format!("Ошибка установки: {}", e)));
        }

        _ = fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).await;
        _ = tokio::task::spawn_blocking(rustix::fs::sync).await;

        log("INFO", format!("Обновление XKeen UI до {} завершено", ver));
        if Path::new(S99XKEEN_UI).exists() {
            log("INFO", "Перезапуск...".into());
            _ = Command::new(S99XKEEN_UI)
                .arg("restart")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        } else {
            log(
                "WARN",
                "Init скрипт панели не найден, требуется ручной перезапуск".into(),
            );
        }
        return response(true, None);
    }

    let (asset, url) = match req.core.as_str() {
        "xray" => {
            let x = match arch {
                "aarch64" => "Xray-linux-arm64-v8a.zip",
                "mips" if cfg!(target_endian = "little") => "Xray-linux-mips32le.zip",
                "mips" => "Xray-linux-mips32.zip",
                _ => return response(false, Some("Архитектура не поддерживается".into())),
            };
            (
                x.into(),
                format!("{GITHUB_RELEASE}/{repo}/releases/download/{ver}/{x}"),
            )
        }
        "mihomo" => {
            let m = match arch {
                "aarch64" => "arm64",
                "mips" if cfg!(target_endian = "little") => "mipsle-softfloat",
                "mips" => "mips-softfloat",
                _ => return response(false, Some("Архитектура не поддерживается".into())),
            };
            if ver == "Prerelease-Alpha" {
                let arch_suffix = format!("mihomo-linux-{}", m);
                let found = req
                    .assets
                    .into_iter()
                    .find(|a| a.contains(&arch_suffix) && a.ends_with(".gz"));

                match found {
                    Some(name) => (
                        name.clone(),
                        format!(
                            "{}/{}/releases/download/{}/{}",
                            GITHUB_RELEASE, repo, ver, name
                        ),
                    ),
                    None => {
                        return response(
                            false,
                            Some("Ассет не найден — обновите страницу и повторите".into()),
                        );
                    }
                }
            } else {
                let n = format!("mihomo-linux-{}-{}.gz", m, ver);
                (
                    n.clone(),
                    format!(
                        "{}/{}/releases/download/{}/{}",
                        GITHUB_RELEASE, repo, ver, n
                    ),
                )
            }
        }
        _ => return response(false, Some("Неизвестное ядро".into())),
    };

    match req.core.as_str() {
        "xray" if !Path::new("/opt/bin/jq").exists() => {
            log("WARN", "Пакет jq не найден".into());
            if let Err(e) = install_jq().await {
                return response(false, Some(e));
            }
        }
        "mihomo" if !Path::new("/opt/sbin/yq").exists() => {
            log("WARN", "Пакет yq не найден".into());
            if let Err(e) = install_yq(&state.http_client, &proxies, tmp_dir).await {
                return response(false, Some(e));
            }
        }
        _ => {}
    }

    log("INFO", format!("Загрузка: {}", url));
    let dl_res = match download(
        &state.http_client,
        &url,
        &proxies,
        &tmp_dir.join("download.tmp"),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return response(false, Some(e)),
    };

    log("INFO", "Распаковка файла...".into());
    let (core_name, is_zip) = (req.core.clone(), asset.ends_with(".zip"));

    fn unpack<R: Read + Seek>(
        rdr: R,
        out_path: &Path,
        core: &str,
        is_zip: bool,
    ) -> std::io::Result<()> {
        let mut out = File::create(out_path)?;
        if is_zip {
            std::io::copy(&mut zip::ZipArchive::new(rdr)?.by_name(core)?, &mut out)?;
        } else {
            std::io::copy(&mut flate2::read::GzDecoder::new(rdr), &mut out)?;
        }
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
    })
    .await;

    if let Ok(Err(e)) | Err(e) =
        unpack.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    {
        return response(false, Some(format!("Ошибка распаковки: {}", e)));
    }

    let target = format!("/opt/sbin/{}", req.core);
    if req.backup_core && Path::new(&target).exists() {
        let bk = format!(
            "/opt/sbin/core-backup/{}-{}",
            req.core,
            (chrono::Utc::now()
                + chrono::Duration::hours(state.settings.read().unwrap().log.timezone as i64))
            .format("%Y%m%d-%H%M%S")
        );
        _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", bk));
        _ = fs::copy(&target, &bk).await;
    }

    log("INFO", "Установка обновления...".into());
    let (run, source) = (
        !crate::controller::get_pid(&req.core).is_empty(),
        tmp_dir.join(&req.core),
    );
    if fs::rename(&source, &target).await.is_ok() {
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run {
            log("INFO", format!("Перезапуск {}...", core_cap));
            crate::controller::soft_restart(&req.core).await;
        }
    } else {
        log(
            "WARN",
            "Атомарная замена не удалась, фолбек на копирование...".into(),
        );
        let init = state.init_file.read().unwrap().clone();
        if run {
            if let Some(ref init) = init {
                _ = Command::new(init).arg("stop").status().await;
            }
        }
        if let Err(e) = fs::copy(&source, &target).await {
            return response(false, Some(format!("Ошибка установки: {}", e)));
        }
        _ = fs::remove_file(&source).await;
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run {
            if let Some(ref init) = init {
                log("INFO", "Запуск XKeen...".into());
                _ = Command::new(init).arg("start").status().await;
            }
        }
    }

    log(
        "INFO",
        format!("Обновление {} до {} завершено", core_cap, ver),
    );
    {
        let mut c = state.update_checker.core_outdated.write().unwrap();
        *c = false;
    }
    {
        let mut c = state.update_checker.last_core_check.write().unwrap();
        *c = None;
    }
    *state.update_checker.last_core_toast.write().unwrap() = None;

    response(true, None)
}
