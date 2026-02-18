use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use memmap2::{MmapOptions, Advice};
use prost::bytes::Buf;
use prost::encoding::{decode_key, decode_varint, skip_field, WireType, DecodeContext};
use regex::Regex;
use serde::Serialize;
use std::{collections::HashMap, net::IpAddr, fs::File, path::Path};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;
use tokio::task;
use crate::types::*;

#[derive(Serialize)]
struct GeoResponse { categories: Vec<String> }

#[derive(Serialize, Clone)]
pub struct GeoFilesResponse {
    site_files: Vec<String>,
    ip_files: Vec<String>,
}

fn scan_geo_file<F>(mut buf: &[u8], mut check_entry: F) -> Vec<String>
where F: FnMut(&[u8]) -> Option<String> {
    let mut found = Vec::new();
    while buf.has_remaining() {
        let (tag, wire_type) = match decode_key(&mut buf) {
            Ok(k) => k,
            Err(_) => break,
        };
        if tag == 1 && wire_type == WireType::LengthDelimited {
            let len = decode_varint(&mut buf).unwrap_or(0) as usize;
            if buf.remaining() < len { break; }
            let entry = &buf[..len];
            buf.advance(len);
            if let Some(country) = check_entry(entry) {
                found.push(country);
            }
        } else {
            let _ = skip_field(wire_type, tag, &mut buf, DecodeContext::default());
        }
    }
    found
}

fn match_cidr_raw(ip: &[u8], prefix: u32, target_v4: Option<u32>, target_v6: Option<u128>) -> bool {
    match (ip.len(), target_v4, target_v6) {
        (4, Some(t), _) => {
            if prefix == 0 { return true; }
            if prefix > 32 { return false; }
            let n = u32::from_be_bytes(ip.try_into().unwrap());
            (t >> (32 - prefix)) == (n >> (32 - prefix))
        }
        (16, _, Some(t)) => {
            if prefix == 0 { return true; }
            if prefix > 128 { return false; }
            let n = u128::from_be_bytes(ip.try_into().unwrap());
            (t >> (128 - prefix)) == (n >> (128 - prefix))
        }
        _ => false,
    }
}

fn parse_cidr_and_match(mut buf: &[u8], target_v4: Option<u32>, target_v6: Option<u128>) -> bool {
    let (mut cidr_ip, mut prefix) = (&[][..], 0u32);
    while buf.has_remaining() {
        let Ok((t, wt)) = decode_key(&mut buf) else { break };
        match (t, wt) {
            (1, WireType::LengthDelimited) => {
                let Ok(l) = decode_varint(&mut buf) else { break };
                let l = l as usize;
                if buf.remaining() < l { break; }
                cidr_ip = &buf[..l];
                buf.advance(l);
            }
            (2, WireType::Varint) => {
                let Ok(v) = decode_varint(&mut buf) else { break };
                prefix = v as u32;
            }
            _ => { let _ = skip_field(wt, t, &mut buf, DecodeContext::default()); }
        }
    }
    match_cidr_raw(cidr_ip, prefix, target_v4, target_v6)
}

fn parse_domain_and_match(mut buf: &[u8], dom_low: &str) -> bool {
    let (mut domain_type, mut value) = (0i32, "");
    while buf.has_remaining() {
        let Ok((t, wt)) = decode_key(&mut buf) else { break };
        match (t, wt) {
            (1, WireType::Varint) => {
                let Ok(v) = decode_varint(&mut buf) else { break };
                domain_type = v as i32;
            }
            (2, WireType::LengthDelimited) => {
                let Ok(l) = decode_varint(&mut buf) else { break };
                let l = l as usize;
                if buf.remaining() < l { break; }
                value = std::str::from_utf8(&buf[..l]).unwrap_or("");
                buf.advance(l);
            }
            _ => { let _ = skip_field(wt, t, &mut buf, DecodeContext::default()); }
        }
    }
    match domain_type {
        0 => dom_low.contains(value),
        1 => Regex::new(value).map_or(false, |re| re.is_match(dom_low)),
        2 => dom_low == value || (
            dom_low.len() > value.len()
            && dom_low.ends_with(value)
            && dom_low.as_bytes()[dom_low.len() - value.len() - 1] == b'.'
        ),
        3 => dom_low == value,
        _ => false,
    }
}

fn find_ip_categories(data: &[u8], ip_str: &str) -> Result<Vec<String>, String> {
    let target: IpAddr = ip_str.parse().map_err(|_| format!("Некорректный IP: {}", ip_str))?;
    let (target_v4, target_v6) = match target {
        IpAddr::V4(v4) => (Some(u32::from(v4)), None),
        IpAddr::V6(v6) => (None, Some(u128::from(v6))),
    };

    Ok(scan_geo_file(data, |entry| {
        let mut country_code = "";
        let mut buf = entry;
        while buf.has_remaining() {
            let Ok((tag, wire_type)) = decode_key(&mut buf) else { break };
            match (tag, wire_type) {
                (1, WireType::LengthDelimited) => {
                    let Ok(len) = decode_varint(&mut buf) else { break };
                    let len = len as usize;
                    if buf.remaining() < len { break; }
                    country_code = std::str::from_utf8(&buf[..len]).unwrap_or("");
                    buf.advance(len);
                }
                (2, WireType::LengthDelimited) => {
                    let Ok(len) = decode_varint(&mut buf) else { break };
                    let len = len as usize;
                    if buf.remaining() < len { break; }
                    let cidr_buf = &buf[..len];
                    buf.advance(len);
                    if parse_cidr_and_match(cidr_buf, target_v4, target_v6) {
                        return Some(country_code.to_string());
                    }
                }
                _ => { let _ = skip_field(wire_type, tag, &mut buf, DecodeContext::default()); }
            }
        }
        None
    }))
}

fn find_domain_categories(data: &[u8], domain: &str) -> Vec<String> {
    let dom_low = domain.to_lowercase();

    scan_geo_file(data, |entry| {
        let mut country_code = "";
        let mut buf = entry;
        while buf.has_remaining() {
            let Ok((tag, wire_type)) = decode_key(&mut buf) else { break };
            match (tag, wire_type) {
                (1, WireType::LengthDelimited) => {
                    let Ok(len) = decode_varint(&mut buf) else { break };
                    let len = len as usize;
                    if buf.remaining() < len { break; }
                    country_code = std::str::from_utf8(&buf[..len]).unwrap_or("");
                    buf.advance(len);
                }
                (2, WireType::LengthDelimited) => {
                    let Ok(len) = decode_varint(&mut buf) else { break };
                    let len = len as usize;
                    if buf.remaining() < len { break; }
                    let dom_buf = &buf[..len];
                    buf.advance(len);
                    if parse_domain_and_match(dom_buf, &dom_low) {
                        return Some(country_code.to_string());
                    }
                }
                _ => { let _ = skip_field(wire_type, tag, &mut buf, DecodeContext::default()); }
            }
        }
        None
    })
}

fn detect_geo_file_type(data: &[u8]) -> (bool, bool) {
    let mut buf = data;
    let Ok((1, WireType::LengthDelimited)) = decode_key(&mut buf) else { return (false, false) };
    let len = decode_varint(&mut buf).unwrap_or(0) as usize;
    if buf.remaining() < len { return (false, false); }
    let mut entry = &buf[..len];
    while entry.has_remaining() {
        let Ok((tag, wire_type)) = decode_key(&mut entry) else { break };
        if tag == 2 && wire_type == WireType::LengthDelimited {
            let len = decode_varint(&mut entry).unwrap_or(0) as usize;
            if entry.remaining() < len { break; }
            let mut sub = &entry[..len];
            while sub.has_remaining() {
                let Ok((sub_tag, sub_wt)) = decode_key(&mut sub) else { break };
                match (sub_tag, sub_wt) {
                    (1, WireType::Varint)          => return (true, false),
                    (1, WireType::LengthDelimited) => return (false, true),
                    (2, WireType::Varint)          => return (false, true),
                    (2, WireType::LengthDelimited) => return (true, false),
                    _ => { let _ = skip_field(sub_wt, sub_tag, &mut sub, DecodeContext::default()); }
                }
            }
            break;
        }
        let _ = skip_field(wire_type, tag, &mut entry, DecodeContext::default());
    }
    (false, false)
}

fn safe_asset_path(filename: &str) -> Option<std::path::PathBuf> {
    let base = Path::new(XRAY_ASSET);
    let path = base.join(Path::new(filename).file_name()?);
    path.starts_with(base).then_some(path)
}

pub fn list_geo_files(cache_arc: Arc<RwLock<crate::types::GeoCache>>) -> Result<GeoFilesResponse, String> {
    let mut site_files = Vec::new();
    let mut ip_files = Vec::new();
    let mut new_cache_entries = Vec::new();

    let entries = std::fs::read_dir(XRAY_ASSET).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map_or(false, |ft| ft.is_file()) && path.extension().map_or(false, |ext| ext == "dat") {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let cached = {
                let cache = cache_arc.read().unwrap();
                cache.get(&name).cloned()
            };

            let (is_site, is_ip) = match cached {
                Some((cached_time, s, i)) if cached_time == mtime => (s, i),
                _ => {
                    let (s, i) = File::open(&path)
                        .ok()
                        .and_then(|f| unsafe { MmapOptions::new().map(&f) }.ok())
                        .map(|mmap| detect_geo_file_type(&mmap))
                        .unwrap_or((false, false));
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
    let Some(filename) = params.get("file").cloned() else {
        return Json(ApiResponse::<GeoResponse> { success: false, error: Some("Отсутствует название файла в запросе".into()), data: None });
    };
    let Some(target) = params.get(if is_ip { "ip" } else { "domain" }).cloned() else {
        return Json(ApiResponse::<GeoResponse> { success: false, error: Some("Отсутствует домен/IP в запросе".into()), data: None });
    };
    let Some(path) = safe_asset_path(&filename) else {
        return Json(ApiResponse::<GeoResponse> { success: false, error: Some("Некорректное имя файла".into()), data: None });
    };

    let result = task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let file = File::open(&path).map_err(|e| format!("Ошибка открытия: {}", e))?;
        let mmap = unsafe { MmapOptions::new().map(&file).map_err(|e| format!("Ошибка mmap: {}", e))? };
        mmap.advise(Advice::Sequential).ok();
        if is_ip { find_ip_categories(&mmap, &target) } else { Ok(find_domain_categories(&mmap, &target)) }
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