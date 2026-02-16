use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use prost::Message;
use serde::Serialize;
use std::{collections::HashMap, net::IpAddr};
use ipnet::IpNet;
use regex::Regex;
use crate::types::*;

#[derive(Message)]
struct GeoIPList {
    #[prost(message, repeated, tag = "1")]
    entry: Vec<GeoIP>,
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
struct GeoSiteList {
    #[prost(message, repeated, tag = "1")]
    entry: Vec<GeoSite>,
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
        2 => query == rule || query.ends_with(&format!(".{}", rule)),
        3 => query == rule,
        _ => false
    }
}

async fn find_ip_categories(geoip_path: &str, ip_str: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let data = tokio::fs::read(geoip_path).await?;
    let geolist = GeoIPList::decode(&data[..])?;
    let ip: IpAddr = ip_str.parse()?;
    let mut found = Vec::with_capacity(2);
    for entry in geolist.entry {
        for cidr in &entry.cidr {
            let network = if cidr.ip.len() == 4 {
                match <[u8; 4]>::try_from(&cidr.ip[..]) {
                    Ok(bytes) => IpNet::new(IpAddr::from(bytes), cidr.prefix as u8)?,
                    Err(_) => continue,
                }
            } else {
                match <[u8; 16]>::try_from(&cidr.ip[..]) {
                    Ok(bytes) => IpNet::new(IpAddr::from(bytes), cidr.prefix as u8)?,
                    Err(_) => continue,
                }
            };
            if network.contains(&ip) {
                found.push(entry.country_code);
                break;
            }
        }
    }
    Ok(found)
}

async fn find_domain_categories(geosite_path: &str, domain: &str) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let data = tokio::fs::read(geosite_path).await?;
    let geolist = GeoSiteList::decode(&data[..])?;
    let domain_lower = domain.to_lowercase();
    let mut found = Vec::with_capacity(2);
    for entry in geolist.entry {
        for rule in &entry.domain {
            let rule_lower = rule.value.to_lowercase();
            if match_domain(&domain_lower, &rule_lower, rule.domain_type) {
                found.push(entry.country_code);
                break;
            }
        }
    }
    Ok(found)
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