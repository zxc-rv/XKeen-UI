use chrono::{DateTime, Duration, NaiveDateTime};
use regex_lite::Regex;
use std::sync::LazyLock;

static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[\d+m").unwrap());
static LVL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[(debug|info|warn|warning|error|fatal)\]").unwrap());
static XRAY_TIME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"time="([^"]+)" level=(\w+) msg="?(.*?)""#).unwrap());

pub const TS_FMT: &str = "%Y/%m/%d %H:%M:%S.%6f";

pub fn ts() -> String {
    chrono::Local::now().format(TS_FMT).to_string()
}

pub fn format_plain_log(level: &str, msg: &str) -> String {
    let timestamp = chrono::Local::now().format(TS_FMT).to_string();
    format!("{} [{}] {}\n", timestamp, level.to_uppercase(), msg)
}

pub fn log(lvl: &str, msg: String) {
    let line = format_plain_log(lvl, &msg);
    if lvl == "ERROR" {
        eprint!("{}", line);
    } else {
        print!("{}", line);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::types::error_log_path())
    {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn process_log_line(line: String, tz: i32) -> String {
    if line.is_empty() {
        return String::new();
    }
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
    } else {
        let bytes = out.as_bytes();
        if bytes.len() > 19 && bytes[4] == b'/' && out.is_char_boundary(19) {
            if let Ok(t) = NaiveDateTime::parse_from_str(&out[..19], "%Y/%m/%d %H:%M:%S") {
                let rest = &out[19..];
                let rest_bytes = rest.as_bytes();
                let trim_micros = rest_bytes.len() >= 10
                    && rest_bytes[0] == b'.'
                    && rest_bytes[1..10].iter().all(|b| b.is_ascii_digit());
                let formatted_ts = (t + offset).format("%Y/%m/%d %H:%M:%S").to_string();
                out = if trim_micros {
                    format!("{}{}{}", formatted_ts, &rest[..7], &rest[10..])
                } else {
                    format!("{}{}", formatted_ts, rest)
                };
            }
        }
    }

    out = ANSI_RE
        .replace_all(&out, |caps: &regex_lite::Captures<'_>| match &caps[0] {
            "\x1b[32m" | "\x1b[92m" => r#"<span style="color: #00cc00;">"#,
            "\x1b[31m" | "\x1b[91m" => r#"<span style="color: #ef4444;">"#,
            "\x1b[33m" | "\x1b[93m" => r#"<span style="color: #f59e0b;">"#,
            "\x1b[96m" => r#"<span style="color: #8BCEF7;">"#,
            "\x1b[0m" => "</span>",
            _ => "",
        })
        .to_string();

    out = LVL_RE
        .replace_all(&out, |caps: &regex_lite::Captures<'_>| {
            let l = caps[1].to_lowercase();
            let cls = if l == "warning" { "warn" } else { &l };
            format!(
                r#"<span class="log-badge log-badge-{}" data-filter="{}">{}</span>"#,
                cls,
                cls.to_uppercase(),
                cls.to_uppercase()
            )
        })
        .to_string();

    format!(r#"<div class="log-line">{}</div>"#, out)
}
