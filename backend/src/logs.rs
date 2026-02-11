use chrono::{DateTime, Duration, NaiveDateTime};
use regex::Regex;
use once_cell::sync::Lazy;

static ANSI_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1b\[\d+m").unwrap());
static LVL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\[(debug|info|warn|warning|error|fatal)\]").unwrap());
static XRAY_TIME_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"time="([^"]+)" level=(\w+) msg="?(.*?)""#).unwrap());

pub fn format_plain_log(level: &str, msg: &str) -> String {
    let timestamp = chrono::Local::now().format("%Y/%m/%d %H:%M:%S.%6f").to_string();
    format!("{} [{}] {}\n", timestamp, level.to_uppercase(), msg)
}

pub fn process_log_line(line: String, tz: i32) -> String {
    if line.is_empty() { return String::new(); }
    let mut out = line;
    let offset = Duration::hours(tz as i64);

    if out.contains("time=") {
        if let Some(caps) = XRAY_TIME_RE.captures(&out) {
            let ts = DateTime::parse_from_rfc3339(&caps[1])
                .map(|t| t + offset)
                .map(|t| t.format("%Y/%m/%d %H:%M:%S%.6f").to_string())
                .unwrap_or(caps[1].into());
            out = format!("{} [{}] {}", ts, caps[2].to_uppercase(), &caps[3]);
        }
    } else if out.chars().count() > 19 {
        let chars: Vec<char> = out.chars().collect();
        if chars.len() > 4 && chars[4] == '/' {
            let date_part: String = chars[..19].iter().collect();
            if let Ok(t) = NaiveDateTime::parse_from_str(&date_part, "%Y/%m/%d %H:%M:%S") {
                let rest_chars: Vec<char> = chars[19..].iter().cloned().collect();
                let new_rest = if !rest_chars.is_empty() && rest_chars[0] == '.' && rest_chars.len() >= 10 && rest_chars[1..10].iter().all(|c| c.is_digit(10)) {
                    let mut nr = rest_chars[0..7].iter().collect::<String>();
                    nr.push_str(&rest_chars[10..].iter().collect::<String>());
                    nr
                } else {
                    rest_chars.iter().collect()
                };
                out = format!("{}{}", (t + offset).format("%Y/%m/%d %H:%M:%S"), new_rest);
            }
        }
    }

    out = ANSI_RE.replace_all(&out, |caps: &regex::Captures| {
        match &caps[0] {
            "\x1b[32m" | "\x1b[92m" => r#"<span style="color: #00cc00;">"#,
            "\x1b[31m" | "\x1b[91m" => r#"<span style="color: #ef4444;">"#,
            "\x1b[33m" | "\x1b[93m" => r#"<span style="color: #f59e0b;">"#,
            "\x1b[96m"             => r#"<span style="color: #8BCEF7;">"#,
            "\x1b[0m"              => "</span>",
            _                      => "",
        }
    }).to_string();

    out = LVL_RE.replace_all(&out, |caps: &regex::Captures| {
        let l = caps[1].to_lowercase();
        let cls = if l == "warning" { "warn" } else { &l };
        format!(r#"<span class="log-badge log-badge-{}" data-filter="{}">{}</span>"#, cls, cls.to_uppercase(), cls.to_uppercase())
    }).to_string();

    format!(r#"<div class="log-line">{}</div>"#, out)
}