use serde::{Deserialize, Serialize};
use std::io::BufReader;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Instant;
use tokio::sync::{Mutex, broadcast};
use tokio::task::AbortHandle;

pub const VERSION: &str = concat!("v", env!("CARGO_PKG_VERSION"));
pub const APP_CONFIG: &str = "/opt/etc/xkeen/xkeen-ui.json";
pub const APP_CONFIG_LEGACY: &str = "/opt/share/www/XKeen-UI/config.json";
pub const XRAY_CONF: &str = "/opt/etc/xray/configs";
pub const XRAY_ASSET: &str = "/opt/etc/xray/dat";
pub const MIHOMO_CONF: &str = "/opt/etc/mihomo";
pub const XKEEN_CONF: &str = "/opt/etc/xkeen";
pub const DEFAULT_ERROR_LOG: &str = "/opt/var/log/xray/error.log";
pub const DEFAULT_ACCESS_LOG: &str = "/opt/var/log/xray/access.log";
pub const XKEEN_UI_LOG: &str = "/opt/var/log/xkeen-ui.log";
pub const S99XKEEN: &str = "/opt/etc/init.d/S99xkeen";
pub const S99XKEEN_UI: &str = "/opt/etc/init.d/S99xkeen-ui";
pub const S24XRAY: &str = "/opt/etc/init.d/S24xray";

pub type GeoCache = std::collections::HashMap<String, (std::time::SystemTime, bool, bool)>;

#[derive(Clone)]
pub struct XrayLogPaths {
    pub error: String,
    pub access: String,
}

impl Default for XrayLogPaths {
    fn default() -> Self {
        Self {
            error: DEFAULT_ERROR_LOG.into(),
            access: DEFAULT_ACCESS_LOG.into(),
        }
    }
}

static XRAY_LOG_PATHS: LazyLock<RwLock<XrayLogPaths>> = LazyLock::new(|| RwLock::new(XrayLogPaths::default()));

fn normalize_xray_log_path(path: Option<&str>, fallback: &str) -> String {
    path.map(str::trim)
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case("none"))
        .unwrap_or(fallback)
        .to_string()
}

fn resolve_xray_log_paths() -> XrayLogPaths {
    let mut paths = XrayLogPaths::default();
    let Ok(entries) = std::fs::read_dir(XRAY_CONF) else {
        return paths;
    };

    let mut json_files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json")))
        .collect();

    json_files.sort();

    for path in json_files {
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let reader = BufReader::new(file);

        let Ok(json) = serde_json::from_reader::<_, serde_json::Value>(reader) else {
            continue;
        };

        if let Some(log) = json.get("log").and_then(|v| v.as_object()) {
            if let Some(access) = log.get("access").and_then(|v| v.as_str()) {
                paths.access = normalize_xray_log_path(Some(access), DEFAULT_ACCESS_LOG);
            }
            if let Some(error) = log.get("error").and_then(|v| v.as_str()) {
                paths.error = normalize_xray_log_path(Some(error), DEFAULT_ERROR_LOG);
            }
        }
    }

    paths
}

pub fn refresh_xray_log_paths() {
    *XRAY_LOG_PATHS.write().unwrap() = resolve_xray_log_paths();
}

pub fn error_log_path() -> String {
    XRAY_LOG_PATHS.read().unwrap().error.clone()
}

pub fn access_log_path() -> String {
    XRAY_LOG_PATHS.read().unwrap().access.clone()
}

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<RwLock<CoreInfo>>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub init_file: Arc<RwLock<Option<String>>>,
    pub http_client: reqwest::Client,
    pub update_checker: UpdateChecker,
    pub geo_cache: Arc<RwLock<GeoCache>>,
    pub log_tx: Arc<broadcast::Sender<String>>,
    pub log_watcher: Arc<Mutex<Option<AbortHandle>>>,
    pub app_config_lock: Arc<Mutex<()>>,
    pub service_op_lock: Arc<Mutex<()>>,
    pub debug: bool,
}

#[derive(Clone, Default)]
pub struct UpdateChecker {
    pub ui_outdated: Arc<RwLock<bool>>,
    pub core_outdated: Arc<RwLock<bool>>,
    pub last_ui_check: Arc<RwLock<Option<Instant>>>,
    pub last_core_check: Arc<RwLock<Option<Instant>>>,
    pub last_ui_toast: Arc<RwLock<Option<Instant>>>,
    pub last_core_toast: Arc<RwLock<Option<Instant>>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CoreInfo {
    pub name: String,
    pub conf_dir: String,
    pub is_json: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct GuiSettings {
    pub routing: bool,
    pub log: bool,
    pub auto_apply: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdaterSettings {
    pub auto_check_ui: bool,
    pub auto_check_core: bool,
    pub backup_core: bool,
    pub github_proxy: Vec<String>,
}

impl Default for UpdaterSettings {
    fn default() -> Self {
        Self {
            github_proxy: vec!["https://gh-proxy.com".into(), "https://ghfast.top".into()],
            backup_core: true,
            auto_check_ui: true,
            auto_check_core: true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LogSettings {
    pub timezone: i32,
}

impl Default for LogSettings {
    fn default() -> Self {
        Self { timezone: 3 }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ClashApiSettings {
    pub ping_url: String,
    pub ping_timeout: u32,
    pub show_source_name: bool,
}

impl Default for ClashApiSettings {
    fn default() -> Self {
        Self {
            ping_url: "https://www.gstatic.com/generate_204".into(),
            ping_timeout: 5000,
            show_source_name: false,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AuthSettings {
    pub enabled: bool,
    pub password_hash: Option<String>,
    pub session_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppendConfigPaths {
    pub xray: Vec<String>,
    pub mihomo: Vec<String>,
}

#[derive(Clone, Serialize, Default)]
pub struct AppSettings {
    pub gui: GuiSettings,
    pub updater: UpdaterSettings,
    pub log: LogSettings,
    pub clash_api: ClashApiSettings,
    pub append_config_paths: AppendConfigPaths,
    pub auth: AuthSettings,
}

impl<'de> Deserialize<'de> for AppSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawConfig {
            #[serde(default)]
            gui: GuiSettings,
            #[serde(default)]
            updater: UpdaterSettings,
            #[serde(default)]
            log: LogSettings,
            #[serde(default)]
            clash_api: ClashApiSettings,
            #[serde(default)]
            append_config_paths: AppendConfigPaths,
            #[serde(default)]
            auth: AuthSettings,
            #[serde(rename = "timezoneOffset")]
            legacy_tz: Option<i32>,
        }
        let mut raw = RawConfig::deserialize(deserializer)?;
        if let Some(tz) = raw.legacy_tz {
            raw.log.timezone = tz;
        }
        Ok(Self {
            gui: raw.gui,
            updater: raw.updater,
            log: raw.log,
            clash_api: raw.clash_api,
            append_config_paths: raw.append_config_paths,
            auth: raw.auth,
        })
    }
}

impl AppSettings {
    pub fn normalize_proxies(&mut self) {
        self.updater.github_proxy = self
            .updater
            .github_proxy
            .iter()
            .map(|p| {
                if p.starts_with("http") {
                    p.to_string()
                } else {
                    format!("https://{}", p.trim_start_matches("://"))
                }
            })
            .collect();
    }
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten)]
    pub data: Option<T>,
}

#[derive(Deserialize)]
pub struct UpdateReq {
    pub core: String,
    pub version: String,
    pub backup_core: bool,
    #[serde(default)]
    pub assets: Vec<String>,
}
