use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

pub const VERSION: &str = concat!("v", env!("CARGO_PKG_VERSION"));
pub const APP_CONFIG: &str = "/opt/share/www/XKeen-UI/config.json";
pub const XRAY_CONF: &str = "/opt/etc/xray/configs";
pub const XRAY_ASSET: &str = "/opt/etc/xray/dat";
pub const MIHOMO_CONF: &str = "/opt/etc/mihomo";
pub const XKEEN_CONF: &str = "/opt/etc/xkeen";
pub const ERROR_LOG: &str = "/opt/var/log/xray/error.log";
pub const ACCESS_LOG: &str = "/opt/var/log/xray/access.log";
pub const S99XKEEN: &str = "/opt/etc/init.d/S99xkeen";
pub const S24XRAY: &str = "/opt/etc/init.d/S24xray";

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<RwLock<CoreInfo>>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub init_file: Arc<RwLock<String>>,
    pub _debug: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CoreInfo {
    pub name: String,
    pub conf_dir: String,
    pub is_json: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct GuiSettings {
    pub routing: bool,
    pub log: bool,
    pub auto_apply: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct UpdaterSettings {
    pub github_proxy: Vec<String>,
    pub backup_core: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct LogSettings { pub timezone: i32 }

#[derive(Clone, Serialize)]
pub struct AppSettings {
    pub gui: GuiSettings,
    pub updater: UpdaterSettings,
    pub log: LogSettings,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ConfigMigration {
    New {
        gui: GuiSettings,
        updater: UpdaterSettings,
        log: LogSettings,
    },
    Legacy {
        #[serde(rename = "timezoneOffset")]
        timezone_offset: i32,
    },
}

impl<'de> Deserialize<'de> for AppSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where D: serde::Deserializer<'de> {
        match ConfigMigration::deserialize(deserializer)? {
            ConfigMigration::New { log, gui, updater } => Ok(Self { log, gui, updater }),
            ConfigMigration::Legacy { timezone_offset } => {
                let mut s = Self::default();
                s.log.timezone = timezone_offset;
                Ok(s)
            }
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            gui: GuiSettings {
              auto_apply: false,
              routing: false,
              log: false,
            },
            updater: UpdaterSettings {
                github_proxy: vec!["https://gh-proxy.com".into(), "https://ghfast.top".into()],
                backup_core: true,
            },
            log: LogSettings { timezone: 3 },
        }
    }
}

impl AppSettings {
    pub fn normalize_proxies(&mut self) {
        self.updater.github_proxy = self.updater.github_proxy.iter().map(|p| {
            let p = p.trim();
            if p.starts_with("http") { p.to_string() }
            else { format!("https://{}", p.trim_start_matches("://")) }
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