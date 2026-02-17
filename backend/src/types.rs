use serde::{Deserialize, Serialize};
use std::{sync::{Arc, RwLock}, time::Instant};

pub const VERSION: &str = concat!("v", env!("CARGO_PKG_VERSION"));
pub const APP_CONFIG: &str = "/opt/share/www/XKeen-UI/config.json";
pub const XRAY_CONF: &str = "/opt/etc/xray/configs";
pub const XRAY_ASSET: &str = "/opt/etc/xray/dat";
pub const MIHOMO_CONF: &str = "/opt/etc/mihomo";
pub const XKEEN_CONF: &str = "/opt/etc/xkeen";
pub const ERROR_LOG: &str = "/opt/var/log/xray/error.log";
pub const ACCESS_LOG: &str = "/opt/var/log/xray/access.log";
pub const S99XKEEN: &str = "/opt/etc/init.d/S99xkeen";
pub const S99XKEEN_UI: &str = "/opt/etc/init.d/S99xkeen-ui";
pub const STATIC_DIR: &str = "/opt/share/www/XKeen-UI";
pub const S24XRAY: &str = "/opt/etc/init.d/S24xray";

pub type GeoCache = std::collections::HashMap<String, (std::time::SystemTime, bool, bool)>;

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<RwLock<CoreInfo>>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub init_file: Arc<RwLock<String>>,
    pub http_client: reqwest::Client,
    pub update_checker: UpdateChecker,
    pub geo_cache: Arc<RwLock<GeoCache>>,
    pub _debug: bool,
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
pub struct LogSettings { pub timezone: i32 }

impl Default for LogSettings {
    fn default() -> Self { Self { timezone: 3 } }
}

#[derive(Clone, Serialize, Default)]
pub struct AppSettings {
    pub gui: GuiSettings,
    pub updater: UpdaterSettings,
    pub log: LogSettings,
}

impl<'de> Deserialize<'de> for AppSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where D: serde::Deserializer<'de> {
        #[derive(Deserialize)]
        struct RawConfig {
            #[serde(default)]
            gui: GuiSettings,
            #[serde(default)]
            updater: UpdaterSettings,
            #[serde(default)]
            log: LogSettings,
            #[serde(rename = "timezoneOffset")]
            legacy_tz: Option<i32>,
        }
        let mut raw = RawConfig::deserialize(deserializer)?;
        if let Some(tz) = raw.legacy_tz { raw.log.timezone = tz; }
        Ok(Self { gui: raw.gui, updater: raw.updater, log: raw.log })
    }
}

impl AppSettings {
    pub fn normalize_proxies(&mut self) {
        self.updater.github_proxy = self.updater.github_proxy.iter().map(|p| {
            if p.starts_with("http") { p.to_string() } else { format!("https://{}", p.trim_start_matches("://")) }
        }).collect();
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
}

#[derive(Serialize)]
pub struct ReleaseInfo {
    pub version: String,
    pub name: String,
    pub published_at: String,
    pub is_prerelease: bool,
}