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

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    #[serde(alias = "timezoneOffset", alias = "timezone-offset")]
    pub timezone: i32,

    #[serde(alias = "githubProxy", alias = "github-proxy")]
    pub github_proxy: Vec<String>,

    #[serde(alias = "autoApply", alias = "auto-apply")]
    pub auto_apply: bool,

    #[serde(alias = "backupCore", alias = "backup-core")]
    pub backup_core: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            timezone: 3,
            github_proxy: vec![
                "https://gh-proxy.com".to_string(),
                "https://ghfast.top".to_string(),
            ],
            auto_apply: false,
            backup_core: true,
        }
    }
}

impl AppSettings {
    pub fn normalize_proxies(&mut self) {
        self.github_proxy = self.github_proxy.iter().map(|p| {
            let p = p.trim();
            if p.starts_with("http://") || p.starts_with("https://") {
                p.to_string()
            } else {
                format!("https://{}", p.trim_start_matches("://"))
            }
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