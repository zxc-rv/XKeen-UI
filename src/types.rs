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
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub timezone_offset: i32,
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
    #[serde(rename = "backupCore")]
    pub backup_core: bool,
}

#[derive(Serialize)]
pub struct ReleaseInfo {
    pub version: String,
    pub name: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
    #[serde(rename = "isPrerelease")]
    pub is_prerelease: bool,
}