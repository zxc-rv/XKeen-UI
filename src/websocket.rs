use axum::{extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State}, response::IntoResponse};
use futures::{sink::SinkExt, stream::StreamExt};
use notify::{RecursiveMode, Watcher};
use std::{fs::File, io::{BufRead, BufReader, Seek, SeekFrom}, path::Path, sync::atomic::{AtomicU32, Ordering}};
use crate::{types::*, logs::process_log_line};

static WS_COUNTER: AtomicU32 = AtomicU32::new(0);

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

fn read_log_file(p: String, offset: u64, query: String, full: bool, tz: i32) -> (String, Vec<String>, u64) {
    let mut f = match File::open(&p) { Ok(f) => f, _ => return ("clear".into(), vec![], 0) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut current_pos = offset;

    if full && query.is_empty() && len > 128000 {
        let seek_pos = len - 128000;
        _ = f.seek(SeekFrom::Start(seek_pos));
        let mut reader = BufReader::new(&mut f);
        let mut discard = String::new();
        let skipped = reader.read_line(&mut discard).unwrap_or(0);
        current_pos = seek_pos + skipped as u64;
    } else if !full && len < offset {
        return ("clear".into(), vec![], 0);
    } else if full {
        current_pos = 0;
    }

    _ = f.seek(SeekFrom::Start(current_pos));
    let mut lines = Vec::new();
    let mut total_bytes = 0usize;
    let mut bytes_read = current_pos;
    let keywords: Vec<String> = query.split('|').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
    let reader = BufReader::new(f);

    for line in reader.lines().map_while(Result::ok) {
        let line_len = line.len() + 1;
        bytes_read += line_len as u64;

        let normalized = if !query.is_empty() {
            line.replace("[Debug]", "[DEBUG]").replace("level=debug", "level=DEBUG")
                .replace("[Info]", "[INFO]").replace("level=info", "level=INFO")
                .replace("[Warning]", "[WARN]").replace("level=warning", "level=WARN")
                .replace("[Error]", "[ERROR]").replace("level=error", "level=ERROR")
                .replace("[Fatal]", "[FATAL]").replace("level=fatal", "level=FATAL")
        } else {
            line.clone()
        };

        if query.is_empty() || keywords.iter().any(|k| normalized.contains(k)) {
            let proc = process_log_line(line, tz);
            if !proc.is_empty() {
                if full && !query.is_empty() {
                    total_bytes += line_len;
                    if total_bytes >= 128000 { break; }
                }
                lines.push(proc);
            }
        }
    }
    (if full { "initial".into() } else { "append".into() }, lines, bytes_read)
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let id = WS_COUNTER.fetch_add(1, Ordering::Relaxed);
    println!("[WS-{}] Connected (Total: {})", id, WS_COUNTER.load(Ordering::Relaxed));

    let (mut tx, mut rx) = socket.split();
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        if let Ok(e) = res { if e.kind.is_modify() { _ = msg_tx.send(()); } }
    }).unwrap();

    let mut path = ERROR_LOG.to_string();
    _ = watcher.watch(Path::new(&path), RecursiveMode::NonRecursive);
    let tz = state.settings.read().unwrap().log.timezone;
    let p_clone = path.clone();
    let (t, l, mut offset) = tokio::task::spawn_blocking(move ||
            read_log_file(p_clone, 0, "".into(), true, tz)
        ).await.unwrap();

    let init_msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": t, "lines": l}) };
    if tx.send(Message::Text(init_msg.to_string().into())).await.is_err() { return; }

    loop {
        tokio::select! {
            Some(msg) = rx.next() => {
                match msg {
                    Ok(Message::Text(txt)) => {
                        let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or_default();
                        let tz = state.settings.read().unwrap().log.timezone;
                        match v["type"].as_str() {
                            Some("switchFile") => {
                                _ = watcher.unwatch(Path::new(&path));
                                path = if v["file"] == "access.log" { ACCESS_LOG.into() } else { ERROR_LOG.into() };
                                _ = watcher.watch(Path::new(&path), RecursiveMode::NonRecursive);

                                let p = path.clone();
                                let (t, l, off) = tokio::task::spawn_blocking(move || read_log_file(p, 0, "".into(), true, tz)).await.unwrap();
                                offset = off;

                                let msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": t, "lines": l}) };
                                if tx.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            },
                            Some("filter") | Some("reload") => {
                                let q = v["query"].as_str().unwrap_or("").to_string();
                                let p = path.clone();
                                let (t, l, off) = tokio::task::spawn_blocking(move || read_log_file(p, 0, q, true, tz)).await.unwrap();
                                offset = off;

                                let msg = if l.is_empty() { serde_json::json!({"type": "clear"}) } else { serde_json::json!({"type": if v["type"] == "filter" { "filtered" } else { t.as_str() }, "lines": l}) };
                                if tx.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            },
                            Some("clear") => {
                                let p = path.clone();
                                offset = 0;
                                tokio::task::spawn_blocking(move || { File::create(p).ok(); });
                                if tx.send(Message::Text(serde_json::json!({"type": "clear"}).to_string().into())).await.is_err() { break; }
                            },
                            _ => {}
                        }
                    },
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            Some(_) = msg_rx.recv() => {
                let tz = state.settings.read().unwrap().log.timezone;
                let p = path.clone();
                let off_curr = offset;
                let (t, l, new_off) = tokio::task::spawn_blocking(move || read_log_file(p, off_curr, "".into(), false, tz)).await.unwrap();
                offset = new_off;

                if !l.is_empty() {
                    let content = l.join("\n");
                    if tx.send(Message::Text(serde_json::json!({"type": t, "content": content}).to_string().into())).await.is_err() { break; }
                } else if t == "clear" {
                     if tx.send(Message::Text(serde_json::json!({"type": "clear"}).to_string().into())).await.is_err() { break; }
                }
            }
        }
    }
    println!("[WS-{}] Disconnected", id);
    WS_COUNTER.fetch_sub(1, Ordering::Relaxed);
}