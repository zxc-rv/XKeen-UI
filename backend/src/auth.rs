use argon2::password_hash::SaltString;
use argon2::password_hash::rand_core::OsRng;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::types::{APP_CONFIG, ApiResponse, AppState};

const SESSION_COOKIE: &str = "session_id";
const MAX_ATTEMPTS: u32 = 5;
const LOCKOUT_SECS: u64 = 60;

static BRUTE_CACHE: LazyLock<Mutex<HashMap<String, (u32, Instant)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Deserialize)]
pub struct PasswordReq {
    password: String,
    #[serde(default)]
    remember: bool,
}

fn now_ts() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn get_client_ip(headers: &HeaderMap, addr: SocketAddr) -> String {
    headers
        .get("x-real-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| addr.ip().to_string())
}

fn get_session_cookie<'a>(headers: &'a HeaderMap) -> Option<&'a str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| pair.trim().strip_prefix("session_id="))
}

fn is_session_valid(session_ids: &[String], cookie: &str) -> bool {
    let ts = now_ts();
    session_ids.iter().any(|id| {
        if id == cookie {
            return true;
        }
        if let Some((uid, exp_str)) = id.split_once(':') {
            if uid == cookie {
                return exp_str.parse::<u64>().unwrap_or(0) > ts;
            }
        }
        false
    })
}

fn set_cookie_header(headers_in: &HeaderMap, value: String, max_age: u64) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let secure = if headers_in.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https") {
        "Secure; "
    } else {
        ""
    };
    let cookie = if max_age > 0 {
        format!(
            "{}={}; HttpOnly; {}SameSite=Strict; Path=/; Max-Age={}",
            SESSION_COOKIE, value, secure, max_age
        )
    } else {
        format!(
            "{}={}; HttpOnly; {}SameSite=Strict; Path=/",
            SESSION_COOKIE, value, secure
        )
    };
    headers.insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    headers
}

fn clear_cookie_header() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_static("session_id=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
    );
    headers
}

pub async fn get_login_info(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let s = state.settings.read().unwrap();
    let authenticated =
        get_session_cookie(&headers).map_or(false, |cookie| is_session_valid(&s.auth.session_ids, cookie));
    Json(serde_json::json!({
        "enabled": s.auth.enabled,
        "has_password": s.auth.password_hash.is_some(),
        "authenticated": authenticated
    }))
}

pub async fn post_setup(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<PasswordReq>,
) -> impl IntoResponse {
    if state.settings.read().unwrap().auth.password_hash.is_some() {
        return (
            StatusCode::FORBIDDEN,
            Json(ApiResponse::<()> {
                success: false,
                error: Some("Password already set".into()),
                data: None,
            }),
        )
            .into_response();
    }

    let password = req.password;
    let hash = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .unwrap();
    let session_id = Uuid::new_v4().to_string();
    let ttl = 86400;
    let session_val = format!("{}:{}", session_id, now_ts() + ttl);

    update_auth(&state, |auth| {
        auth.password_hash = Some(hash);
        auth.session_ids.push(session_val);
    })
    .await;

    (
        set_cookie_header(&headers, session_id, 0),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn post_login(
    State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap,
    Json(req): Json<PasswordReq>,
) -> Response {
    let ip = get_client_ip(&headers, addr);
    {
        let mut cache = BRUTE_CACHE.lock().unwrap();
        let entry = cache.entry(ip.clone()).or_insert((0, Instant::now()));
        if entry.1.elapsed() > Duration::from_secs(LOCKOUT_SECS) {
            entry.0 = 0;
        }
        if entry.0 >= MAX_ATTEMPTS {
            println!("{} [WARN] Authorization blocked [{}]", crate::logger::ts(), ip);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ApiResponse::<()> {
                    success: false,
                    error: Some(format!(
                        "Слишком много попыток. Повторите через {} секунд",
                        LOCKOUT_SECS
                    )),
                    data: None,
                }),
            )
                .into_response();
        }
    }

    let hash = match state.settings.read().unwrap().auth.password_hash.clone() {
        Some(h) => h,
        None => {
            return (
                StatusCode::FORBIDDEN,
                Json(ApiResponse::<()> {
                    success: false,
                    error: Some("No password set".into()),
                    data: None,
                }),
            )
                .into_response();
        }
    };

    let password = req.password;
    let is_valid = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false);

    if !is_valid {
        let mut cache = BRUTE_CACHE.lock().unwrap();
        let entry = cache.entry(ip.clone()).or_insert((0, Instant::now()));
        entry.0 += 1;
        entry.1 = Instant::now();
        println!(
            "{} [WARN] Incorrect password attempt [{}] ({}/{})",
            crate::logger::ts(),
            ip,
            entry.0,
            MAX_ATTEMPTS
        );
        return (
            StatusCode::UNAUTHORIZED,
            Json(ApiResponse::<()> {
                success: false,
                error: Some("Неверный пароль".into()),
                data: None,
            }),
        )
            .into_response();
    }

    BRUTE_CACHE.lock().unwrap().remove(&ip);
    println!("{} [INFO] Successful auth {}", crate::logger::ts(), ip);

    let max_age = if req.remember { 2592000 } else { 0 };
    let backend_ttl = if req.remember { 2592000 } else { 86400 };

    let session_id = Uuid::new_v4().to_string();
    let session_val = format!("{}:{}", session_id, now_ts() + backend_ttl);

    update_auth(&state, |auth| {
        auth.session_ids.push(session_val);
    })
    .await;

    (
        set_cookie_header(&headers, session_id, max_age),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
        .into_response()
}

pub async fn post_logout(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(cookie) = get_session_cookie(&headers) {
        let cookie = cookie.to_string();
        update_auth(&state, |auth| {
            auth.session_ids.retain(|id| !id.starts_with(&cookie) && id != &cookie)
        })
        .await;
    }
    (
        clear_cookie_header(),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
}

pub async fn post_auth_reset(State(state): State<AppState>) -> impl IntoResponse {
    update_auth(&state, |auth| {
        auth.password_hash = None;
        auth.session_ids.clear();
    })
    .await;
    (
        clear_cookie_header(),
        Json(ApiResponse::<()> {
            success: true,
            error: None,
            data: None,
        }),
    )
}

pub async fn auth_middleware(state: AppState, request: Request, next: Next) -> Response {
    let enabled = state.settings.read().unwrap().auth.enabled;
    if !enabled {
        return next.run(request).await;
    }
    let session_ids = state.settings.read().unwrap().auth.session_ids.clone();
    if session_ids.is_empty() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let is_valid = get_session_cookie(request.headers()).map_or(false, |c| is_session_valid(&session_ids, c));
    if !is_valid {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    next.run(request).await
}

fn hash_password(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .unwrap()
        .to_string()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

async fn update_auth(state: &AppState, modify: impl FnOnce(&mut crate::types::AuthSettings)) {
    {
        let mut s = state.settings.write().unwrap();
        modify(&mut s.auth);

        let ts = now_ts();
        s.auth.session_ids.retain(|id| {
            if let Some((_, exp)) = id.split_once(':') {
                exp.parse::<u64>().unwrap_or(0) > ts
            } else {
                true
            }
        });
    }
    save_auth_to_config(state).await;
}

async fn save_auth_to_config(state: &AppState) {
    let _guard = state.app_config_lock.lock().await;
    let auth = state.settings.read().unwrap().auth.clone();
    let mut file_json: serde_json::Value = tokio::fs::read_to_string(APP_CONFIG)
        .await
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or(serde_json::json!({}));
    file_json["auth"] = serde_json::to_value(auth).unwrap();
    let serialized = serde_json::to_string_pretty(&file_json).unwrap();
    let tmp = format!("{}.tmp", APP_CONFIG);
    if tokio::fs::write(&tmp, &serialized).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, APP_CONFIG).await;
    }
}
