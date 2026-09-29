use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Json};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

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

pub fn repo_slug(url: &str) -> String {
    let s = url.trim().trim_end_matches('/');
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let s = s.strip_prefix("www.").unwrap_or(s);
    let s = match s.find('/') {
        Some(i) if s[..i].contains('.') => &s[i + 1..],
        _ => s,
    };
    s.strip_suffix(".git").unwrap_or(s).to_string()
}

pub fn valid_repo_url(url: &str) -> bool {
    let slug = repo_slug(url);
    let mut parts = slug.split('/');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(a), Some(b), None) if !a.is_empty() && !b.is_empty()
    )
}

pub fn get_repo(updater: &UpdaterSettings, core: &str) -> Option<String> {
    let (url, fallback) = match core {
        "xray" => (&updater.xray_repo, "XTLS/Xray-core"),
        "mihomo" => (&updater.mihomo_repo, "MetaCubeX/mihomo"),
        "self" => return Some("zxc-rv/XKeen-UI".into()),
        _ => return None,
    };
    Some(if valid_repo_url(url) {
        repo_slug(url)
    } else {
        fallback.into()
    })
}

pub fn pick_asset(assets: &[String], arch: &str, ver: &str) -> Option<String> {
    // архитектурные суффиксы: (mihomo-стиль, xray-стиль)
    let (m, x) = match arch {
        "aarch64" => ("arm64", "arm64-v8a"),
        "mips" if cfg!(target_endian = "little") => ("mipsle-softfloat", "mips32le"),
        "mips" => ("mips-softfloat", "mips32"),
        _ => return None,
    };

    // alpha-ассеты заканчиваются хешем, а в релизе ещё .deb/.rpm/.zip/.zst
    if ver == "Prerelease-Alpha" {
        let alpha = format!("linux-{}-alpha", m);
        return assets.iter().find(|a| a.ends_with(".gz") && a.contains(&alpha)).cloned();
    }

    // хвосты имени ассета без названия ядра:
    //   prizrak-core-linux-arm64-v1.19.31.gz -> linux-arm64-v1.19.31.gz
    //   Xray-linux-arm64-v8a.zip             -> linux-arm64-v8a.zip
    let tails = [format!("linux-{}-{}.gz", m, ver), format!("linux-{}.zip", x)];
    assets.iter().find(|a| tails.iter().any(|t| a.ends_with(t))).cloned()
}

async fn fetch_release_assets(
    client: &reqwest::Client, proxies: &[String], repo: &str, tag: &str,
) -> Vec<String> {
    let url = format!("{}/{}/releases/tags/{}", GITHUB_API, repo, tag);
    let list = std::iter::once(url.clone()).chain(
        proxies
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(|p| format!("{}/{}", p.trim_end_matches('/'), url)),
    );

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
        if let Ok(rel) = res.json::<GhRelease>().await {
            return rel.assets.into_iter().map(|a| a.name).collect();
        }
    }
    Vec::new()
}

pub async fn fetch_latest_version(
    client: &reqwest::Client,
    repo: &str,
    core: &str,
    proxies: &[String],
    current_ver: Option<&str>,
) -> Option<(String, String)> {
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
                    if let Some(hash) = asset.name.find("alpha-").and_then(|index| asset.name[index..].split('.').next()) {
                        return Some((hash.to_string(), "Prerelease-Alpha".into()));
                    }
                }
            }
        }

        if let Some(r) = rels.into_iter().find(|r| !r.prerelease) {
            let tag = r.tag_name.clone();
            return Some((tag.trim_start_matches('v').to_string(), tag));
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
    client: &reqwest::Client, url: &str, proxies: &[String], tmp_path: &Path,
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
                            if is_disk { "на диск" } else { "в ОЗУ" },
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

    let list = std::iter::once(url.to_string()).chain(proxies.iter().map(|p| format!("{}/{}", p, url)));
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
                if r.headers()
                    .get("content-type")
                    .map_or(false, |v| v.to_str().unwrap_or("").contains("text/html"))
                {
                    log(
                        "WARN",
                        if is_proxy {
                            format!("Прокси #{} вернул HTML", i)
                        } else {
                            "Прямой URL вернул HTML".into()
                        },
                    );
                    continue;
                }
                if let Some(res) = load(
                    r,
                    tmp_path,
                    &format!("{}{}", source, if is_proxy { format!(" #{}", i) } else { "".into() }),
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
async fn save(dl: DownloadResult, out_path: PathBuf) -> std::io::Result<()> {
    tokio::task::spawn_blocking(move || {
        let mut out = File::create(&out_path)?;
        match dl {
            DownloadResult::RAM(d) => out.write_all(&d)?,
            DownloadResult::Disk(p) => {
                std::io::copy(&mut File::open(&p)?, &mut out)?;
                _ = std::fs::remove_file(p);
            }
        }
        out.sync_data()
    })
    .await
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?
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

async fn install_yq(client: &reqwest::Client, proxies: &[String], tmp_dir: &Path) -> Result<(), String> {
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
    if let Err(e) = save(dl_res, tmp_dir.join("yq.bin")).await {
        return Err(format!("Ошибка записи yq: {}", e));
    }

    log("INFO", "Установка yq...".into());
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

pub async fn post_update(State(state): State<AppState>, Json(req): Json<UpdateReq>) -> impl IntoResponse {
    let (repo, proxies) = {
        let s = state.settings.read().unwrap();
        (get_repo(&s.updater, &req.core), s.updater.github_proxy.clone())
    };
    let Some(repo) = repo else {
        return response(false, Some("Неизвестное ядро".into()));
    };
    let ver = if req.version.starts_with(|c: char| c.is_ascii_digit()) {
        format!("v{}", req.version)
    } else {
        req.version.clone()
    };
    let mut core_cap = req.core.clone();
    if let Some(r) = core_cap.get_mut(0..1) {
        r.make_ascii_uppercase();
    }

    log(
        "INFO",
        format!(
            "Запущено обновление {} до {}",
            if req.core == "self" { "XKeen UI" } else { &core_cap },
            ver
        ),
    );

    let tmp_dir = Path::new("/opt/tmp");
    _ = fs::create_dir_all(tmp_dir).await;
    let arch = std::env::consts::ARCH;

    if req.core == "self" {
        let arch_suffix = match arch {
            "aarch64" => "arm64-v8a",
            "mips" if cfg!(target_endian = "little") => "mips32le",
            "mips" => "mips32",
            _ => return response(false, Some("Архитектура не поддерживается".into())),
        };

        log("INFO", "Загрузка исполняемого файла...".into());
        let bin_url = format!("{GITHUB_RELEASE}/{repo}/releases/download/{ver}/xkeen-ui-{arch_suffix}");
        let bin_d = match download(&state.http_client, &bin_url, &proxies, &tmp_dir.join("bin.tmp")).await {
            Ok(d) => d,
            Err(e) => return response(false, Some(e)),
        };

        log("INFO", "Установка обновления...".into());

        let source = tmp_dir.join(format!("xkeen-ui_{}", ver));
        if let Err(e) = save(bin_d, source.clone()).await {
            return response(false, Some(format!("Ошибка сохранения: {}", e)));
        }

        let integrity_check = tokio::task::spawn_blocking({
            let source = source.clone();
            move || -> Result<(), String> {
                let meta = std::fs::metadata(&source)
                    .map_err(|e| format!("Ошибка проверки файла: {}", e))?;
                if meta.len() < 1024 * 1024 {
                    return Err("Файл меньше 1МБ — повреждённый артефакт".into());
                }
                let mut f = std::fs::File::open(&source)
                    .map_err(|e| format!("Ошибка открытия файла: {}", e))?;
                let mut magic = [0u8; 4];
                f.read_exact(&mut magic)
                    .map_err(|e| format!("Ошибка чтения файла: {}", e))?;
                if magic != [0x7F, b'E', b'L', b'F'] {
                    return Err("Файл не является ELF-бинарём — отменено".into());
                }
                Ok(())
            }
        })
        .await
        .map_err(|e| format!("Ошибка проверки: {}", e))
        .and_then(|r| r);

        if let Err(e) = integrity_check {
            _ = std::fs::remove_file(&source);
            return response(false, Some(e));
        }

        let target = "/opt/sbin/xkeen-ui";
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
    let assets = if req.assets.is_empty() {
        log("INFO", format!("Получение списка ассетов релиза {}...", ver));
        fetch_release_assets(&state.http_client, &proxies, &repo, &ver).await
    } else {
        req.assets.clone()
    };

    let asset = if !assets.is_empty() {
        match pick_asset(&assets, arch, &ver) {
            Some(a) => a,
            None => {
                let msg = if matches!(arch, "aarch64" | "mips") {
                    "Не найден ассет для этой архитектуры в релизе"
                } else {
                    "Архитектура не поддерживается"
                };
                return response(false, Some(msg.into()));
            }
        }
    } else {
        // фолбэк: хардкод имён для стоковых репозиториев, если список ассетов получить не удалось
        match req.core.as_str() {
            "xray" => match arch {
                "aarch64" => "Xray-linux-arm64-v8a.zip".to_string(),
                "mips" if cfg!(target_endian = "little") => "Xray-linux-mips32le.zip".to_string(),
                "mips" => "Xray-linux-mips32.zip".to_string(),
                _ => return response(false, Some("Архитектура не поддерживается".into())),
            },
            "mihomo" if ver == "Prerelease-Alpha" => {
                return response(false, Some("Ассет не найден — обновите страницу и повторите".into()));
            }
            "mihomo" => {
                let m = match arch {
                    "aarch64" => "arm64",
                    "mips" if cfg!(target_endian = "little") => "mipsle-softfloat",
                    "mips" => "mips-softfloat",
                    _ => return response(false, Some("Архитектура не поддерживается".into())),
                };
                format!("mihomo-linux-{}-{}.gz", m, ver)
            }
            _ => return response(false, Some("Неизвестное ядро".into())),
        }
    };
    let url = format!("{}/{}/releases/download/{}/{}", GITHUB_RELEASE, repo, ver, asset);

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
    let dl_res = match download(&state.http_client, &url, &proxies, &tmp_dir.join("download.tmp")).await {
        Ok(r) => r,
        Err(e) => return response(false, Some(e)),
    };

    log("INFO", "Установка обновления...".into());
    let (core_name, is_zip) = (req.core.clone(), asset.ends_with(".zip"));

    fn unpack<R: Read + Seek>(rdr: R, out_path: &Path, core: &str, is_zip: bool) -> std::io::Result<()> {
        let mut out = File::create(out_path)?;
        if is_zip {
            let mut archive = zip::ZipArchive::new(rdr)?;
            let mut entry: Option<String> = None;
            for i in 0..archive.len() {
                if let Ok(f) = archive.by_index(i) {
                    let base = f.name().rsplit('/').next().unwrap_or(f.name()).to_string();
                    if !f.is_dir() && base.eq_ignore_ascii_case(core) {
                        entry = Some(f.name().to_string());
                        break;
                    }
                }
            }
            if entry.is_none() {
                let mut files: Vec<String> = Vec::new();
                for i in 0..archive.len() {
                    if let Ok(f) = archive.by_index(i) {
                        if !f.is_dir() {
                            files.push(f.name().to_string());
                        }
                    }
                }
                if files.len() == 1 {
                    entry = files.into_iter().next();
                }
            }
            let name = entry.ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "бинарник ядра не найден в архиве")
            })?;
            std::io::copy(&mut archive.by_name(&name)?, &mut out)?;
        } else {
            std::io::copy(&mut flate2::read::GzDecoder::new(rdr), &mut out)?;
        }
        out.sync_data()?;
        Ok(())
    }

    let tmp_name = format!("{}_{}", core_name, ver);
    let unpack = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let bin = tmp_dir.join(&tmp_name);
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

    if let Ok(Err(e)) | Err(e) = unpack.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string())) {
        return response(false, Some(format!("Ошибка распаковки: {}", e)));
    }

    let target = format!("/opt/sbin/{}", req.core);
    if req.backup_core && Path::new(&target).exists() {
        let bk = format!(
            "/opt/sbin/core-backup/{}-{}",
            req.core,
            (chrono::Utc::now() + chrono::Duration::hours(state.settings.read().unwrap().log.timezone as i64))
                .format("%Y%m%d-%H%M%S")
        );
        _ = fs::create_dir_all("/opt/sbin/core-backup").await;
        log("INFO", format!("Создание бэкапа: {}", bk));
        _ = fs::copy(&target, &bk).await;
    }

    let (run, source) = (
        !crate::controller::get_pid(&req.core).is_empty(),
        tmp_dir.join(format!("{}_{}", req.core, ver)),
    );
    if fs::rename(&source, &target).await.is_ok() {
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run {
            log("INFO", format!("Перезапуск {}...", core_cap));
            if let Err(e) = crate::controller::soft_restart(&req.core).await {
                log("ERROR", format!("{}", e));
                return response(false, Some(format!("{}", e)));
            }
        }
    } else {
        log("WARN", "Атомарная замена не удалась, фолбек на копирование...".into());
        if run {
            log("INFO", "Остановка XKeen...".into());
            _ = crate::controller::run_init_command(&state, &["stop"]).await;
        }
        if let Err(e) = fs::copy(&source, &target).await {
            return response(false, Some(format!("Ошибка установки: {}", e)));
        }
        _ = fs::remove_file(&source).await;
        _ = fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
        if run {
            log("INFO", "Запуск XKeen...".into());
            _ = crate::controller::run_init_command(&state, &["start", "on"]).await;
        }
    }

    log("INFO", format!("Обновление {} до {} завершено", core_cap, ver));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_repo_url() {
        assert_eq!(repo_slug("https://github.com/XTLS/Xray-core"), "XTLS/Xray-core");
        assert_eq!(repo_slug("https://github.com/MetaCubeX/mihomo/"), "MetaCubeX/mihomo");
        assert_eq!(repo_slug("github.com/zxc-rv/XKeen-UI"), "zxc-rv/XKeen-UI");
        assert_eq!(repo_slug("XTLS/Xray-core"), "XTLS/Xray-core");
        assert_eq!(repo_slug("https://github.com/owner/repo.git"), "owner/repo");
    }

    #[test]
    fn repo_url_validation() {
        assert!(valid_repo_url("https://github.com/XTLS/Xray-core"));
        assert!(valid_repo_url("XTLS/Xray-core"));
        assert!(!valid_repo_url("https://github.com"));
        assert!(!valid_repo_url(""));
        assert!(!valid_repo_url("   "));
    }

    #[test]
    fn repo_from_settings() {
        let mut s = UpdaterSettings::default();
        assert_eq!(get_repo(&s, "xray").as_deref(), Some("XTLS/Xray-core"));
        assert_eq!(get_repo(&s, "mihomo").as_deref(), Some("MetaCubeX/mihomo"));
        assert_eq!(get_repo(&s, "self").as_deref(), Some("zxc-rv/XKeen-UI"));

        s.xray_repo = "https://github.com/someone/xray-fork".into();
        assert_eq!(get_repo(&s, "xray").as_deref(), Some("someone/xray-fork"));

        s.xray_repo = "https://github.com".into();
        assert_eq!(get_repo(&s, "xray").as_deref(), Some("XTLS/Xray-core"));
    }

    #[test]
    fn picks_asset_by_arch_and_version() {
        let custom = vec![
            "prizrak-core-linux-arm64-v1.19.31.gz".to_string(),
            "prizrak-core-linux-arm64-compatible-v1.19.31.gz".to_string(),
            "prizrak-core-linux-mipsle-softfloat-v1.19.31.gz".to_string(),
            "prizrak-core-linux-mips-softfloat-v1.19.31.gz".to_string(),
            "prizrak-core-windows-arm64-v1.19.31.gz".to_string(),
            "prizrak-core-linux-arm64-v1.19.31.gz.sha256".to_string(),
        ];
        assert_eq!(
            pick_asset(&custom, "aarch64", "v1.19.31").as_deref(),
            Some("prizrak-core-linux-arm64-v1.19.31.gz")
        );
        if cfg!(target_endian = "little") {
            assert_eq!(
                pick_asset(&custom, "mips", "v1.19.31").as_deref(),
                Some("prizrak-core-linux-mipsle-softfloat-v1.19.31.gz")
            );
        } else {
            assert_eq!(
                pick_asset(&custom, "mips", "v1.19.31").as_deref(),
                Some("prizrak-core-linux-mips-softfloat-v1.19.31.gz")
            );
        }
        assert_eq!(pick_asset(&custom, "x86_64", "v1.19.31"), None);
    }

    #[test]
    fn picks_stock_assets() {
        let xray = vec![
            "Xray-linux-arm64-v8a.zip".to_string(),
            "Xray-linux-64.zip".to_string(),
            "Xray-windows-64.zip".to_string(),
            "Xray-macos-arm64.zip".to_string(),
            "geoip.dat".to_string(),
            "geosite.dat".to_string(),
        ];
        assert_eq!(
            pick_asset(&xray, "aarch64", "v25.9.6").as_deref(),
            Some("Xray-linux-arm64-v8a.zip")
        );

        let mihomo = vec![
            "mihomo-linux-arm64-v1.19.3.gz".to_string(),
            "mihomo-linux-arm64-compatible-v1.19.3.gz".to_string(),
            "mihomo-linux-mipsle-softfloat-v1.19.3.gz".to_string(),
            "mihomo-linux-64-v1.19.3.gz".to_string(),
        ];
        assert_eq!(
            pick_asset(&mihomo, "aarch64", "v1.19.3").as_deref(),
            Some("mihomo-linux-arm64-v1.19.3.gz")
        );

        let alpha = vec![
            "mihomo-linux-arm64-alpha-5a3f7c1e.deb".to_string(),
            "mihomo-linux-arm64-alpha-5a3f7c1e.rpm".to_string(),
            "mihomo-linux-arm64-alpha-5a3f7c1e.gz".to_string(),
            "mihomo-linux-mipsle-softfloat-alpha-5a3f7c1e.gz".to_string(),
        ];
        assert_eq!(
            pick_asset(&alpha, "aarch64", "Prerelease-Alpha").as_deref(),
            Some("mihomo-linux-arm64-alpha-5a3f7c1e.gz")
        );

        assert_eq!(pick_asset(&["Xray-linux-64.zip".to_string()], "aarch64", "v25.9.6"), None);
    }
}
