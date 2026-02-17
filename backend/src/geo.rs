use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use memmap2::{MmapOptions, Advice};
use prost::Message;
use prost::bytes::Buf;
use prost::encoding::{decode_key, decode_varint, skip_field, WireType, DecodeContext};
use regex::Regex;
use serde::Serialize;
use std::{collections::HashMap, net::IpAddr, fs::File};
use tokio::task;
use crate::types::*;
use std::sync::{Arc, RwLock};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::SystemTime;

#[derive(Serialize)]
struct GeoResponse { categories: Vec<String> }

#[derive(Serialize, Clone)]
pub struct GeoFilesResponse {
    site_files: Vec<String>,
    ip_files: Vec<String>,
}

fn to_v4(ip: &[u8]) -> Option<u32> { ip.try_into().ok().map(u32::from_be_bytes) }
fn to_v6(ip: &[u8]) -> Option<u128> { ip.try_into().ok().map(u128::from_be_bytes) }

fn scan_geo_file<F>(mut buf: &[u8], mut check_entry: F) -> Vec<String>
where F: FnMut(&mut &[u8]) -> Option<String> {
    let mut found = Vec::new();
    while buf.has_remaining() {
        let (tag, wire_type) = match decode_key(&mut buf) {
            Ok(k) => k,
            Err(_) => break,
        };

        if tag == 1 && wire_type == WireType::LengthDelimited {
            let len = decode_varint(&mut buf).unwrap_or(0) as usize;
            if buf.remaining() < len { break; }
            let mut entry_buf = &buf[..len];
            buf.advance(len);

            if let Some(country) = check_entry(&mut entry_buf) {
                found.push(country);
            }
        } else {
            let _ = skip_field(wire_type, tag, &mut buf, DecodeContext::default());
        }
    }
    found
}

fn find_ip_categories(data: &[u8], ip_str: &str) -> Result<Vec<String>, String> {
    let target: IpAddr = ip_str.parse().map_err(|_| format!("Некорректный IP: {}", ip_str))?;
    let (target_v4, target_v6) = match target {
        IpAddr::V4(v4) => (Some(u32::from(v4)), None),
        IpAddr::V6(v6) => (None, Some(u128::from(v6))),
    };

    Ok(scan_geo_file(data, |entry_buf| {
        GeoIP::decode(*entry_buf).ok().and_then(|entry| {
            entry.cidr.into_iter().find(|cidr| {
                let pfx = cidr.prefix as u32;
                match (cidr.ip.len(), target_v4, target_v6) {
                    (4, Some(t), _) => to_v4(&cidr.ip).map_or(false, |n| pfx <= 32 && (t >> (32 - pfx)) == (n >> (32 - pfx))),
                    (16, _, Some(t)) => to_v6(&cidr.ip).map_or(false, |n| pfx <= 128 && (t >> (128 - pfx)) == (n >> (128 - pfx))),
                    _ => false,
                }
            }).map(|_| entry.country_code)
        })
    }))
}

fn find_domain_categories(data: &[u8], domain: &str) -> Result<Vec<String>, String> {
    let dom_low = domain.to_lowercase();
    let dom_bytes = dom_low.as_bytes();

    Ok(scan_geo_file(data, |entry_buf| {
        GeoSite::decode(*entry_buf).ok().and_then(|entry| {
            entry.domain.into_iter().find(|rule| {
                let r_bytes = rule.value.as_bytes();
                match rule.domain_type {
                    0 => dom_low.contains(&rule.value),
                    1 => Regex::new(&rule.value).map_or(false, |re| re.is_match(&dom_low)),
                    2 => {
                        if dom_bytes.len() == r_bytes.len() {
                            dom_low == rule.value
                        } else if dom_bytes.len() > r_bytes.len() {
                            dom_bytes[dom_bytes.len() - r_bytes.len() - 1] == b'.'
                            && dom_low.ends_with(&rule.value)
                        } else {
                            false
                        }
                    },
                    3 => dom_low == rule.value,
                    _ => false,
                }
            }).map(|_| entry.country_code)
        })
    }))
}

pub fn list_geo_files(cache_arc: Arc<RwLock<crate::types::GeoCache>>) -> Result<GeoFilesResponse, String> {
    let mut site_files = Vec::new();
    let mut ip_files = Vec::new();
    let mut new_cache_entries = Vec::new();

    let entries = std::fs::read_dir(XRAY_ASSET).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "dat") {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let cached = {
                let cache = cache_arc.read().unwrap();
                cache.get(&name).cloned()
            };

            let (is_site, is_ip) = match cached {
                Some((cached_time, s, i)) if cached_time == mtime => (s, i),
                _ => {
                    let (mut s, mut i) = (false, false);
                    if let Ok(file) = File::open(&path) {
                        if let Ok(mmap) = unsafe { MmapOptions::new().map(&file) } {
                            let mut data = mmap.as_ref();
                            if let Ok((1, WireType::LengthDelimited)) = decode_key(&mut data) {
                                let len = decode_varint(&mut data).unwrap_or(0) as usize;
                                if data.remaining() >= len {
                                    let buf = &data[..len];
                                    s = GeoSite::decode(buf).map_or(false, |gs| !gs.domain.is_empty());
                                    i = GeoIP::decode(buf).map_or(false, |gi| !gi.cidr.is_empty());
                                }
                            }
                        }
                    }
                    new_cache_entries.push((name.clone(), mtime, s, i));
                    (s, i)
                }
            };

            if is_site { site_files.push(name.clone()); }
            if is_ip { ip_files.push(name); }
        }
    }
    if !new_cache_entries.is_empty() {
        let mut cache = cache_arc.write().unwrap();
        for (name, mtime, s, i) in new_cache_entries {
            cache.insert(name, (mtime, s, i));
        }
    }

    site_files.sort();
    ip_files.sort();
    Ok(GeoFilesResponse { site_files, ip_files })
}

pub async fn get_geo(State(state): State<AppState>) -> impl IntoResponse {
    let cache = state.geo_cache.clone();
    match task::spawn_blocking(move || list_geo_files(cache)).await {
        Ok(Ok(data)) => Json(ApiResponse { success: true, error: None, data: Some(data) }),
        Ok(Err(e)) => Json(ApiResponse::<GeoFilesResponse> { success: false, error: Some(e), data: None }),
        Err(e) => Json(ApiResponse::<GeoFilesResponse> { success: false, error: Some(format!("Task panic: {}", e)), data: None }),
    }
}

async fn handle_geo_request(params: HashMap<String, String>, is_ip: bool) -> impl IntoResponse {
    let filename = match params.get("file") {
        Some(f) => f,
        None => return Json(ApiResponse::<GeoResponse> { success: false, error: Some("Отсутствует название файла в запросе".into()), data: None }),
    };

    let target = match params.get(if is_ip { "ip" } else { "domain" }) {
        Some(t) => t.clone(),
        None => return Json(ApiResponse::<GeoResponse> { success: false, error: Some("Отсутствует домен/IP в запросе".into()), data: None }),
    };

    let path = format!("{}/{}", XRAY_ASSET, filename);
    let result = task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let file = File::open(&path).map_err(|e| format!("Ошибка открытия: {}", e))?;
        let mmap = unsafe { MmapOptions::new().map(&file).map_err(|e| format!("Ошибка mmap: {}", e))? };
        mmap.advise(Advice::Sequential).ok();

        if is_ip { find_ip_categories(&mmap, &target) } else { find_domain_categories(&mmap, &target) }
    }).await;

    match result {
        Ok(Ok(categories)) => Json(ApiResponse { success: true, error: None, data: Some(GeoResponse { categories }) }),
        Ok(Err(e)) => Json(ApiResponse::<GeoResponse> { success: false, error: Some(e), data: None }),
        Err(e) => Json(ApiResponse::<GeoResponse> { success: false, error: Some(format!("Ошибка: {}", e)), data: None }),
    }
}

pub async fn get_geoip(State(_state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    handle_geo_request(params, true).await
}

pub async fn get_geosite(State(_state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    handle_geo_request(params, false).await
}

#[derive(Message)]
struct GeoIP {
    #[prost(string, tag = "1")]
    country_code: String,
    #[prost(message, repeated, tag = "2")]
    cidr: Vec<CIDR>,
}

#[derive(Message)]
struct CIDR {
    #[prost(bytes, tag = "1")]
    ip: Vec<u8>,
    #[prost(uint32, tag = "2")]
    prefix: u32,
}

#[derive(Message)]
struct GeoSite {
    #[prost(string, tag = "1")]
    country_code: String,
    #[prost(message, repeated, tag = "2")]
    domain: Vec<Domain>,
}

#[derive(Message)]
struct Domain {
    #[prost(int32, tag = "1")]
    domain_type: i32,
    #[prost(string, tag = "2")]
    value: String,
}