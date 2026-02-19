use crate::types::*;
use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use memmap2::{MmapOptions, Advice};
use prost::bytes::Buf;
use prost::encoding::{decode_key, decode_varint, skip_field, WireType, DecodeContext};
use regex_lite::Regex;
use serde::Serialize;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;
use std::{collections::HashMap, net::IpAddr, fs::File, path::Path};
use tokio::task;

#[derive(Serialize, Clone)]
pub struct GeoFilesResponse { site_files: Vec<String>, ip_files: Vec<String> }

#[derive(Serialize)]
struct GeoQueryResponse { categories: Vec<String> }

fn read_len_delim<'a>(buf: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = decode_varint(buf).ok()? as usize;
    if buf.remaining() < len { return None; }
    let slice = &buf[..len];
    buf.advance(len);
    Some(slice)
}

fn find_categories<F: FnMut(&[u8]) -> bool>(data: &[u8], mut matches: F) -> Vec<String> {
    let mut found = Vec::new();
    let mut buf = data;
    while buf.has_remaining() {
        let Ok((tag, wt)) = decode_key(&mut buf) else { break };
        let Some(entry) = (tag == 1 && wt == WireType::LengthDelimited)
            .then(|| read_len_delim(&mut buf))
            .flatten()
        else {
            let _ = skip_field(wt, tag, &mut buf, DecodeContext::default());
            continue;
        };
        let mut buf2 = entry;
        let mut country_code = "";
        while buf2.has_remaining() {
            let Ok((tag, wt)) = decode_key(&mut buf2) else { break };
            match (tag, wt) {
                (1, WireType::LengthDelimited) => {
                    let Some(s) = read_len_delim(&mut buf2) else { break };
                    country_code = std::str::from_utf8(s).unwrap_or("");
                }
                (2, WireType::LengthDelimited) => {
                    let Some(payload) = read_len_delim(&mut buf2) else { break };
                    if matches(payload) { found.push(country_code.to_string()); break; }
                }
                _ => { let _ = skip_field(wt, tag, &mut buf2, DecodeContext::default()); }
            }
        }
    }
    found
}

fn parse_cidr_and_match(mut buf: &[u8], target_v4: Option<u32>, target_v6: Option<u128>) -> bool {
    let (mut cidr_ip, mut prefix) = (&[][..], 0u32);
    while buf.has_remaining() {
        let Ok((t, wt)) = decode_key(&mut buf) else { break };
        match (t, wt) {
            (1, WireType::LengthDelimited) => { let Some(s) = read_len_delim(&mut buf) else { break }; cidr_ip = s; }
            (2, WireType::Varint) => { let Ok(v) = decode_varint(&mut buf) else { break }; prefix = v as u32; }
            _ => { let _ = skip_field(wt, t, &mut buf, DecodeContext::default()); }
        }
    }
    match (cidr_ip.len(), target_v4, target_v6) {
        (4, Some(t), _) => prefix <= 32 && { let n = u32::from_be_bytes(cidr_ip.try_into().unwrap()); prefix == 0 || (t >> (32 - prefix)) == (n >> (32 - prefix)) },
        (16, _, Some(t)) => prefix <= 128 && { let n = u128::from_be_bytes(cidr_ip.try_into().unwrap()); prefix == 0 || (t >> (128 - prefix)) == (n >> (128 - prefix)) },
        _ => false,
    }
}

fn parse_domain_and_match(mut buf: &[u8], dom_low: &str) -> bool {
    let (mut domain_type, mut value) = (0i32, "");
    while buf.has_remaining() {
        let Ok((t, wt)) = decode_key(&mut buf) else { break };
        match (t, wt) {
            (1, WireType::Varint) => { let Ok(v) = decode_varint(&mut buf) else { break }; domain_type = v as i32; }
            (2, WireType::LengthDelimited) => { let Some(s) = read_len_delim(&mut buf) else { break }; value = std::str::from_utf8(s).unwrap_or(""); }
            _ => { let _ = skip_field(wt, t, &mut buf, DecodeContext::default()); }
        }
    }
    match domain_type {
        0 => dom_low.contains(value),
        1 => Regex::new(value).map_or(false, |re: regex_lite::Regex| re.is_match(dom_low)),
        2 => dom_low == value || (dom_low.len() > value.len() && dom_low.ends_with(value) && dom_low.as_bytes()[dom_low.len() - value.len() - 1] == b'.'),
        3 => dom_low == value,
        _ => false,
    }
}

fn detect_geo_file_type(data: &[u8]) -> (bool, bool) {
    let mut buf = data;
    let Ok((1, WireType::LengthDelimited)) = decode_key(&mut buf) else { return (false, false) };
    let Some(mut entry) = read_len_delim(&mut buf) else { return (false, false) };
    while entry.has_remaining() {
        let Ok((tag, wt)) = decode_key(&mut entry) else { break };
        if tag == 2 && wt == WireType::LengthDelimited {
            let Some(mut sub) = read_len_delim(&mut entry) else { break };
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
        let _ = skip_field(wt, tag, &mut entry, DecodeContext::default());
    }
    (false, false)
}

pub fn list_geo_files(cache_arc: Arc<RwLock<crate::types::GeoCache>>) -> Result<GeoFilesResponse, String> {
    let mut site_files = Vec::new();
    let mut ip_files = Vec::new();
    let mut new_cache_entries = Vec::new();

    for entry in std::fs::read_dir(XRAY_ASSET).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !entry.file_type().map_or(false, |ft| ft.is_file()) { continue; }
        if path.extension().map_or(true, |ext| ext != "dat") { continue; }

        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        let cached = cache_arc.read().unwrap().get(&name).cloned();
        let (is_site, is_ip) = match cached {
            Some((cached_time, s, i)) if cached_time == mtime => (s, i),
            _ => {
                let result = File::open(&path).ok()
                    .and_then(|f| unsafe { MmapOptions::new().map(&f) }.ok())
                    .map(|mmap| detect_geo_file_type(&mmap))
                    .unwrap_or((false, false));
                new_cache_entries.push((name.clone(), mtime, result.0, result.1));
                result
            }
        };
        if is_site { site_files.push(name.clone()); }
        if is_ip { ip_files.push(name); }
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

pub async fn get_geoip(State(_): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    geo_query_handler(params, true).await
}

pub async fn get_geosite(State(_): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    geo_query_handler(params, false).await
}

async fn geo_query_handler(params: HashMap<String, String>, is_ip: bool) -> impl IntoResponse {
    let key = if is_ip { "ip" } else { "domain" };
    let (Some(filename), Some(target)) = (params.get("file"), params.get(key)) else {
        return Json(ApiResponse::<GeoQueryResponse> { success: false, error: Some(format!("Отсутствует file или {key}")), data: None });
    };
    let base = Path::new(XRAY_ASSET);
    let Some(path) = Path::new(filename).file_name().map(|n| base.join(n)).filter(|p| p.starts_with(base)) else {
        return Json(ApiResponse::<GeoQueryResponse> { success: false, error: Some("Некорректное имя файла".into()), data: None });
    };
    let target = target.clone();
    let result = task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let file = File::open(&path).map_err(|e| format!("Ошибка открытия: {}", e))?;
        let mmap = unsafe { MmapOptions::new().map(&file).map_err(|e| format!("Ошибка mmap: {}", e))? };
        mmap.advise(Advice::Sequential).ok();
        if is_ip {
            let target: IpAddr = target.parse().map_err(|_| format!("Некорректный IP: {}", target))?;
            let (v4, v6) = match target {
                IpAddr::V4(v4) => (Some(u32::from(v4)), None),
                IpAddr::V6(v6) => (None, Some(u128::from(v6))),
            };
            Ok(find_categories(&mmap, |buf| parse_cidr_and_match(buf, v4, v6)))
        } else {
            let dom_low = target.to_lowercase();
            Ok(find_categories(&mmap, |buf| parse_domain_and_match(buf, &dom_low)))
        }
    }).await;

    match result {
        Ok(Ok(categories)) => Json(ApiResponse { success: true, error: None, data: Some(GeoQueryResponse { categories }) }),
        Ok(Err(e)) => Json(ApiResponse::<GeoQueryResponse> { success: false, error: Some(e), data: None }),
        Err(e) => Json(ApiResponse::<GeoQueryResponse> { success: false, error: Some(format!("Ошибка: {}", e)), data: None }),
    }
}