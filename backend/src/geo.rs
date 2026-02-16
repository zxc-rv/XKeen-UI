use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use prost::Message;
use serde::Serialize;
use std::{collections::HashMap, net::IpAddr, fs::File};
use ipnet::IpNet;
use regex::Regex;
use crate::types::*;
use prost::bytes::Buf;
use memmap2::{MmapOptions, Advice};

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

#[derive(Serialize)]
struct GeoResponse {
    categories: Vec<String>
}

#[derive(Serialize)]
struct GeoFilesResponse {
    files: Vec<String>
}

fn match_domain(query: &str, rule: &str, rule_type: i32) -> bool {
    match rule_type {
        0 => query.contains(rule),
        1 => Regex::new(rule).map(|r| r.is_match(query)).unwrap_or(false),
        2 => query == rule || query.strip_suffix(rule).map_or(false, |prefix| prefix.ends_with('.')),
        3 => query == rule,
        _ => false
    }
}

fn scan_geo_file<F>(path: &str, mut check_entry: F) -> Result<Vec<String>, Box<dyn std::error::Error>>
where
    F: FnMut(&mut &[u8]) -> Option<String>,
{
    let file = File::open(path)?;
    let mmap = unsafe {
        let map = MmapOptions::new().map(&file)?;
        map.advise(Advice::Sequential)?;
        map
    };
    let mut buf = &mmap[..];
    let mut found = Vec::new();

    while buf.has_remaining() {
        let (tag, wire_type) = match prost::encoding::decode_key(&mut buf) {
            Ok(k) => k,
            Err(_) => break,
        };

        if tag == 1 && wire_type == prost::encoding::WireType::LengthDelimited {
            let len = prost::encoding::decode_varint(&mut buf).unwrap_or(0) as usize;
            if buf.remaining() < len { break; }

            let mut entry_buf = &buf[..len];
            buf.advance(len);

            if let Some(country_code) = check_entry(&mut entry_buf) {
                found.push(country_code);
            }
        } else {
            let _ = prost::encoding::skip_field(wire_type, tag, &mut buf, prost::encoding::DecodeContext::default());
        }
    }

    Ok(found)
}

async fn find_ip_categories(geoip_path: &str, ip_str: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let target_ip: IpAddr = ip_str.parse()?;

    scan_geo_file(geoip_path, |entry_buf| {
        if let Ok(entry) = GeoIP::decode(entry_buf) {
            for cidr in &entry.cidr {
                let network = if cidr.ip.len() == 4 {
                    <[u8; 4]>::try_from(&cidr.ip[..]).ok()
                        .and_then(|bytes| IpNet::new(IpAddr::from(bytes), cidr.prefix as u8).ok())
                } else {
                    <[u8; 16]>::try_from(&cidr.ip[..]).ok()
                        .and_then(|bytes| IpNet::new(IpAddr::from(bytes), cidr.prefix as u8).ok())
                };

                if let Some(net) = network {
                    if net.contains(&target_ip) {
                        return Some(entry.country_code);
                    }
                }
            }
        }
        None
    })
}

async fn find_domain_categories(geosite_path: &str, domain: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let domain_lower = domain.to_lowercase();

    scan_geo_file(geosite_path, |entry_buf| {
        if let Ok(entry) = GeoSite::decode(entry_buf) {
            for rule in &entry.domain {
                let rule_lower = rule.value.to_lowercase();
                if match_domain(&domain_lower, &rule_lower, rule.domain_type) {
                    return Some(entry.country_code);
                }
            }
        }
        None
    })
}

pub async fn get_geo(State(_state): State<AppState>) -> impl IntoResponse {
    let mut files = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(XRAY_ASSET).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "dat") {
                if let Some(filename) = path.file_name() {
                    files.push(filename.to_string_lossy().into());
                }
            }
        }
    }
    files.sort();
    Json(ApiResponse { success: true, error: None, data: Some(GeoFilesResponse { files }) })
}

pub async fn get_geoip(State(_state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let filename = match params.get("file") {
        Some(f) => f,
        None => return Json(ApiResponse::<GeoResponse> { success: false, error: Some("missing file parameter".into()), data: None })
    };
    let ip = match params.get("ip") {
        Some(i) => i,
        None => return Json(ApiResponse::<GeoResponse> { success: false, error: Some("missing ip parameter".into()), data: None })
    };
    let path = format!("{}/{}", XRAY_ASSET, filename);
    match find_ip_categories(&path, ip).await {
        Ok(categories) => Json(ApiResponse { success: true, error: None, data: Some(GeoResponse { categories }) }),
        Err(e) => Json(ApiResponse::<GeoResponse> { success: false, error: Some(e.to_string()), data: None })
    }
}

pub async fn get_geosite(State(_state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> impl IntoResponse {
    let filename = match params.get("file") {
        Some(f) => f,
        None => return Json(ApiResponse::<GeoResponse> { success: false, error: Some("missing file parameter".into()), data: None })
    };
    let domain = match params.get("domain") {
        Some(d) => d,
        None => return Json(ApiResponse::<GeoResponse> { success: false, error: Some("missing domain parameter".into()), data: None })
    };
    let path = format!("{}/{}", XRAY_ASSET, filename);
    match find_domain_categories(&path, domain).await {
        Ok(categories) => Json(ApiResponse { success: true, error: None, data: Some(GeoResponse { categories }) }),
        Err(e) => Json(ApiResponse::<GeoResponse> { success: false, error: Some(e.to_string()), data: None })
    }
}