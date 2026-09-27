//! Тестер маршрутов: по домену/IP показывает, каким правилом активного ядра (mihomo/xray)
//! пойдёт трафик и в какой outbound. Разбивка по файлам — см. `tasks/route-tester-spec.md`.

pub mod cidr;
pub mod dns;
pub mod geodb;
pub mod idle_cache;
pub mod mihomo;
pub mod providers;
pub mod xray;

use crate::api_relay;
use crate::types::{ApiResponse, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use dns::Resolver;
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::time::Duration;
use tokio::time::Instant;

/// Транспорт, для которого проверяется маршрут.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    #[default]
    Tcp,
    Udp,
}

impl Network {
    /// Пока не вызывается: понадобится движкам для правила `NETWORK`.
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Network::Tcp => "tcp",
            Network::Udp => "udp",
        }
    }
}

/// Тело `POST /api/route-test`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTestRequest {
    pub targets: Vec<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub network: Network,
    #[serde(default)]
    pub source_ip: Option<IpAddr>,
    #[serde(default)]
    pub inbound_tag: Option<String>,
}

fn default_port() -> u16 {
    443
}

/// Нормализованная цель проверки: домен или IP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Domain(String),
    Ip(IpAddr),
}

impl Target {
    /// `"domain"` | `"ip"` — значение поля `RouteResult::kind`. Пока не вызывается: заполняется
    /// движками mihomo/xray при реализации `evaluate`.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            Target::Domain(_) => "domain",
            Target::Ip(_) => "ip",
        }
    }
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Target::Domain(d) => write!(f, "{d}"),
            Target::Ip(ip) => write!(f, "{ip}"),
        }
    }
}

/// Нормализует введённую пользователем строку в цель: убирает схему, userinfo, путь/query/fragment
/// и порт; IPv6 в скобках поддерживается. Домены приводятся к нижнему регистру, конечная точка
/// отбрасывается. Не-ASCII и некорректные имена — ошибка на русском.
pub fn normalize_target(raw: &str) -> Result<Target, String> {
    const INVALID: &str = "недопустимый домен";

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(INVALID.into());
    }

    let mut s = trimmed;
    if let Some((_, rest)) = s.split_once("://") {
        s = rest;
    }
    if let Some(idx) = s.find(['/', '?', '#']) {
        s = &s[..idx];
    }
    if let Some(idx) = s.rfind('@') {
        s = &s[idx + 1..];
    }

    let host = if let Some(rest) = s.strip_prefix('[') {
        let end = rest.find(']').ok_or_else(|| INVALID.to_string())?;
        &rest[..end]
    } else if let Ok(ip) = s.parse::<IpAddr>() {
        return Ok(Target::Ip(ip));
    } else {
        match s.rsplit_once(':') {
            Some((host_part, port_part))
                if !host_part.is_empty()
                    && !port_part.is_empty()
                    && port_part.chars().all(|c| c.is_ascii_digit())
                    && s.matches(':').count() == 1 =>
            {
                host_part
            }
            Some(_) => return Err(INVALID.into()),
            None => s,
        }
    };

    let host = host.trim();
    if host.is_empty() {
        return Err(INVALID.into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(Target::Ip(ip));
    }
    if !host.is_ascii() {
        return Err(INVALID.into());
    }

    let domain = host.trim_end_matches('.').to_lowercase();
    if !is_valid_domain(&domain) {
        return Err(INVALID.into());
    }
    Ok(Target::Domain(domain))
}

fn is_valid_domain(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > 253 {
        return false;
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// Контекст одной проверки: цель + параметры запроса, общие для mihomo и xray движков.
/// Поля читаются в `mihomo::Engine::evaluate`/`xray::Engine::evaluate` — пока те заглушки,
/// компилятор считает поля неиспользуемыми.
#[allow(dead_code)]
pub struct TestContext {
    pub target: Target,
    pub port: u16,
    pub network: Network,
    pub source_ip: Option<IpAddr>,
    pub inbound_tag: Option<String>,
}

/// Итог сравнения (три исхода, как в дизайне): правило сработало, дошли до дефолта, или сбой.
/// `Matched` пока не конструируется — заглушки движков всегда возвращают `Error`.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Matched,
    #[default]
    Default,
    Error,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedRule {
    pub index: usize,
    pub text: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalancerInfo {
    pub tag: String,
    pub selector: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRule {
    pub index: usize,
    pub text: String,
    pub reason: String,
}

/// Результат проверки одной цели. Заполняется движком (`mihomo`/`xray`) целиком: `target`/`kind`
/// берутся из `TestContext::target` (`Display`/`kind()`), остальное — по итогу сравнения правил.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResult {
    pub target: String,
    pub kind: String,
    pub outcome: Outcome,
    pub outbound: Option<String>,
    pub rule: Option<MatchedRule>,
    pub balancer: Option<BalancerInfo>,
    pub resolved_ips: Vec<IpAddr>,
    pub dns_source: Option<dns::DnsSource>,
    pub skipped: Vec<SkippedRule>,
    pub error: Option<String>,
}

impl RouteResult {
    /// Результат-ошибка для цели, не прошедшей нормализацию (или иной фатальный сбой по одной цели).
    pub fn error(target_raw: &str, msg: impl Into<String>) -> Self {
        Self {
            target: target_raw.to_string(),
            kind: "domain".into(),
            outcome: Outcome::Error,
            error: Some(msg.into()),
            ..Default::default()
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTestResponse {
    pub core: String,
    pub results: Vec<RouteResult>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTestMeta {
    pub core: String,
    pub inbound_tags: Vec<String>,
}

/// Компайл-тайм проверка: движки и резолвер должны оставаться `Send + Sync`, иначе
/// axum-хендлер `post_route_test` перестанет собираться (генерирует Future, которую
/// исполнитель tokio обязан гонять между потоками).
#[allow(dead_code)]
fn assert_send_sync<T: Send + Sync>() {}
#[allow(dead_code)]
fn _assert_route_test_bounds() {
    assert_send_sync::<mihomo::Engine>();
    assert_send_sync::<xray::Engine>();
    assert_send_sync::<dns::LiveResolver>();
}

/// Активное ядро, оборачивающее конкретный движок — нужно только чтобы не плодить
/// generic-параметр на границе хендлера (движки не object-safe из-за `async fn` в трейте).
enum ActiveEngine {
    Mihomo(mihomo::Engine),
    Xray(xray::Engine),
}

impl ActiveEngine {
    async fn load(core_name: &str) -> Result<Self, String> {
        if core_name == "mihomo" {
            mihomo::load().await.map(ActiveEngine::Mihomo)
        } else {
            xray::load().await.map(ActiveEngine::Xray)
        }
    }

    async fn evaluate<R: Resolver>(&self, ctx: &TestContext, resolver: &R) -> RouteResult {
        match self {
            ActiveEngine::Mihomo(e) => e.evaluate(ctx, resolver).await,
            ActiveEngine::Xray(e) => e.evaluate(ctx, resolver).await,
        }
    }

    fn warnings(&self) -> Vec<String> {
        match self {
            ActiveEngine::Mihomo(e) => e.warnings(),
            ActiveEngine::Xray(e) => e.warnings(),
        }
    }
}

/// `GET /api/route-test` — активное ядро и список inbound-тегов (только для xray).
pub async fn get_route_test_meta(State(state): State<AppState>) -> Response {
    let core_name = state.core.read().unwrap().name.clone();
    let inbound_tags = if core_name == "xray" {
        xray::inbound_tags().await.unwrap_or_default()
    } else {
        Vec::new()
    };
    Json(ApiResponse {
        success: true,
        error: None,
        data: Some(RouteTestMeta {
            core: core_name,
            inbound_tags,
        }),
    })
    .into_response()
}

struct ParsedTarget {
    raw: String,
    parsed: Result<Target, String>,
}

/// Нормализует и дедуплицирует цели, сохраняя порядок первого появления. Ключ дедупликации —
/// каноническое представление для валидных целей и очищенная строка для невалидных, поэтому
/// `X.com` и `https://x.com/` схлопываются в одну запись.
fn normalize_and_dedupe(raw_targets: Vec<String>) -> Vec<ParsedTarget> {
    let mut seen = HashSet::with_capacity(raw_targets.len());
    let mut out = Vec::with_capacity(raw_targets.len());
    for raw in raw_targets {
        let trimmed = raw.trim().to_string();
        let parsed = normalize_target(&raw);
        let key = match &parsed {
            Ok(target) => target.to_string(),
            Err(_) => trimmed.clone(),
        };
        if seen.insert(key) {
            out.push(ParsedTarget { raw: trimmed, parsed });
        }
    }
    out
}

/// Сколько целей вычисляется одновременно — не топим mihomo/файловую систему 500 параллельными
/// запросами разом, но и не ждём их строго по очереди (mihomo A+AAAA до 2×3с, DoH-фолбэк до 4с —
/// см. `dns.rs` — то есть до ~10с на одну цель в худшем случае).
const MAX_CONCURRENCY: usize = 8;
/// Максимум на одну цель — жёсткий бэкстоп поверх таймаутов внутри `dns.rs`/geodb.
const PER_TARGET_TIMEOUT: Duration = Duration::from_secs(10);
/// Общий бюджет на весь запрос (до 500 целей). После него необработанные цели получают ошибку без
/// попытки вычисления — см. `evaluate_targets`.
const REQUEST_BUDGET: Duration = Duration::from_secs(120);
const TIMEOUT_MESSAGE: &str = "превышено время ожидания";

/// Вычисляет `targets` через `eval` с ограниченным параллелизмом (`buffered` — сохраняет порядок
/// результатов таким же, как порядок входных целей, независимо от того, какая из них досчиталась
/// первой), с таймаутом на каждую цель и общим бюджетом `deadline` на весь запрос: как только он
/// истёк, необработанные цели получают `Outcome::Error` без вызова `eval` вообще (не тратим время
/// на заведомо просроченные попытки). Невалидные (не прошедшие нормализацию) цели возвращают ошибку
/// сразу, не через `eval` и не под таймаутом — там нечего вычислять.
///
/// Вынесено из `post_route_test` отдельной функцией, не завязанной на `ActiveEngine`/axum, чтобы
/// протестировать тайминги и сохранение порядка с управляемым фейковым `eval` под
/// `tokio::time::pause`, без реального движка/файлов конфигурации.
async fn evaluate_targets<F, Fut>(targets: &[ParsedTarget], deadline: Instant, eval: F) -> Vec<RouteResult>
where
    F: Fn(Target) -> Fut + Sync,
    Fut: Future<Output = RouteResult> + Send,
{
    // Каждое future боксируем в `Pin<Box<dyn Future + Send>>` до передачи в `stream::iter(...)
    // .buffered(_)`: без бокса rustc не может унифицировать замыкание, заимствующее элемент
    // `targets.iter()`, с обобщённым (higher-ranked) временем жизни, которого требует связка
    // `Stream::map`/`Buffered` («closure ... must implement FnOnce<...> for any two lifetimes») —
    // с однородным боксированным типом эта путаница с типами уходит.
    let futures: Vec<Pin<Box<dyn Future<Output = RouteResult> + Send + '_>>> = targets
        .iter()
        .map(|pt| {
            let raw = pt.raw.clone();
            let parsed = pt.parsed.clone();
            let eval = &eval;
            let fut = async move {
                let target = match parsed {
                    Ok(target) => target,
                    Err(e) => return RouteResult::error(&raw, e),
                };
                let now = Instant::now();
                if now >= deadline {
                    return RouteResult::error(&raw, TIMEOUT_MESSAGE.to_string());
                }
                let per_target_deadline = (now + PER_TARGET_TIMEOUT).min(deadline);
                match tokio::time::timeout_at(per_target_deadline, eval(target)).await {
                    Ok(result) => result,
                    Err(_) => RouteResult::error(&raw, TIMEOUT_MESSAGE.to_string()),
                }
            };
            Box::pin(fut) as Pin<Box<dyn Future<Output = RouteResult> + Send + '_>>
        })
        .collect();

    stream::iter(futures).buffered(MAX_CONCURRENCY).collect().await
}

/// `POST /api/route-test` — проверка списка целей активным ядром.
pub async fn post_route_test(
    State(state): State<AppState>, headers: HeaderMap, Json(req): Json<RouteTestRequest>,
) -> Response {
    if req.targets.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "нет целей для проверки".into());
    }

    let parsed_targets = normalize_and_dedupe(req.targets);
    if parsed_targets.len() > 500 {
        return error_response(StatusCode::BAD_REQUEST, "не более 500 целей".into());
    }

    let port_override = api_relay::header_value(&headers, "x-clash-port");
    let secret_override = api_relay::header_value(&headers, "x-clash-secret");
    let unix_override = api_relay::header_value(&headers, "x-clash-unix");
    let clash_target = api_relay::resolve_clash_target(port_override, secret_override, unix_override)
        .await
        .ok();
    let resolver = dns::LiveResolver::new(clash_target, state.http_client.clone());
    // Один резолвер на весь запрос: одинаковый домен из разных целей резолвится один раз
    // (см. `dns::CachingResolver`), а не заново на каждую цель.
    let resolver = dns::CachingResolver::new(&resolver);

    let core_name = state.core.read().unwrap().name.clone();
    let engine = match ActiveEngine::load(&core_name).await {
        Ok(e) => e,
        Err(e) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let deadline = Instant::now() + REQUEST_BUDGET;
    let results = evaluate_targets(&parsed_targets, deadline, |target: Target| {
        let ctx = TestContext {
            target,
            port: req.port,
            network: req.network,
            source_ip: req.source_ip,
            inbound_tag: req.inbound_tag.clone(),
        };
        let engine = &engine;
        let resolver = &resolver;
        async move { engine.evaluate(&ctx, resolver).await }
    })
    .await;

    Json(ApiResponse {
        success: true,
        error: None,
        data: Some(RouteTestResponse {
            core: core_name,
            results,
            warnings: engine.warnings(),
        }),
    })
    .into_response()
}

fn error_response(status: StatusCode, msg: String) -> Response {
    (
        status,
        Json(ApiResponse::<()> {
            success: false,
            error: Some(msg),
            data: None,
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_scheme_userinfo_path_query_fragment_and_port() {
        assert_eq!(
            normalize_target("https://User:pw@X.com:8443/a?b#c").unwrap(),
            Target::Domain("x.com".into())
        );
    }

    #[test]
    fn parses_ipv4_with_port() {
        assert_eq!(
            normalize_target("1.1.1.1:443").unwrap(),
            Target::Ip("1.1.1.1".parse().unwrap())
        );
    }

    #[test]
    fn parses_ipv4_without_port() {
        assert_eq!(
            normalize_target("1.1.1.1").unwrap(),
            Target::Ip("1.1.1.1".parse().unwrap())
        );
    }

    #[test]
    fn parses_bare_ipv6() {
        assert_eq!(normalize_target("::1").unwrap(), Target::Ip("::1".parse().unwrap()));
    }

    #[test]
    fn parses_bracketed_ipv6_with_port() {
        assert_eq!(
            normalize_target("[::1]:443").unwrap(),
            Target::Ip("::1".parse().unwrap())
        );
    }

    #[test]
    fn parses_bracketed_ipv6_without_port() {
        assert_eq!(normalize_target("[::1]").unwrap(), Target::Ip("::1".parse().unwrap()));
    }

    #[test]
    fn strips_trailing_dot_and_lowercases() {
        assert_eq!(
            normalize_target("YouTube.com.").unwrap(),
            Target::Domain("youtube.com".into())
        );
    }

    #[test]
    fn plain_domain_without_port_is_kept_as_is() {
        assert_eq!(
            normalize_target("youtube.com").unwrap(),
            Target::Domain("youtube.com".into())
        );
    }

    #[test]
    fn rejects_non_ascii_domain() {
        assert!(normalize_target("тест.рф").is_err());
    }

    #[test]
    fn rejects_rule_syntax_as_domain() {
        assert!(normalize_target("+.youtube.com").is_err());
    }

    #[test]
    fn rejects_empty_target() {
        assert!(normalize_target("").is_err());
        assert!(normalize_target("   ").is_err());
    }

    #[test]
    fn rejects_ambiguous_multi_colon_host() {
        assert!(normalize_target("a:b:c").is_err());
    }

    #[test]
    fn dedupe_preserves_order_and_collapses_equivalent_urls() {
        let parsed = normalize_and_dedupe(vec![
            "x.com".into(),
            "https://X.com/".into(),
            "1.1.1.1".into(),
            "x.com".into(),
        ]);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].parsed, Ok(Target::Domain("x.com".into())));
        assert_eq!(parsed[1].parsed, Ok(Target::Ip("1.1.1.1".parse().unwrap())));
    }

    fn parsed_domain(raw: &str, domain: &str) -> ParsedTarget {
        ParsedTarget {
            raw: raw.to_string(),
            parsed: Ok(Target::Domain(domain.to_string())),
        }
    }

    /// Под `start_paused = true` `tokio::time::sleep`/`timeout_at` продвигают виртуальные часы сами,
    /// как только у рантайма не остаётся другой работы — реального ожидания в тесте нет.
    #[tokio::test(start_paused = true)]
    async fn evaluate_targets_preserves_input_order_regardless_of_completion_order() {
        let targets = vec![
            parsed_domain("slow", "slow.example"),
            parsed_domain("fast", "fast.example"),
            parsed_domain("mid", "mid.example"),
        ];
        let deadline = Instant::now() + Duration::from_secs(1000);
        let results = evaluate_targets(&targets, deadline, |target| async move {
            let (label, delay_ms) = match &target {
                Target::Domain(d) if d == "slow.example" => ("slow", 300),
                Target::Domain(d) if d == "fast.example" => ("fast", 10),
                _ => ("mid", 100),
            };
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            RouteResult {
                outbound: Some(label.to_string()),
                ..RouteResult::default()
            }
        })
        .await;

        let order: Vec<&str> = results.iter().map(|r| r.outbound.as_deref().unwrap()).collect();
        assert_eq!(
            order,
            vec!["slow", "fast", "mid"],
            "результаты должны идти в порядке входных целей, а не в порядке завершения (fast/mid финишируют раньше slow)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn evaluate_targets_times_out_a_slow_target() {
        let targets = vec![parsed_domain("slow", "slow.example")];
        let deadline = Instant::now() + Duration::from_secs(1000);
        let results = evaluate_targets(&targets, deadline, |_target| async {
            tokio::time::sleep(PER_TARGET_TIMEOUT + Duration::from_secs(1)).await;
            RouteResult::default()
        })
        .await;

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].outcome, Outcome::Error);
        assert_eq!(results[0].error.as_deref(), Some(TIMEOUT_MESSAGE));
    }

    #[tokio::test(start_paused = true)]
    async fn evaluate_targets_skips_unstarted_work_once_overall_budget_is_gone() {
        let targets = vec![parsed_domain("a", "a.example")];
        // Бюджет уже "истёк" на момент вызова — под паузой время само не идёт, поэтому
        // `Instant::now()` внутри `evaluate_targets` останется равным (или позже) `deadline`.
        let deadline = Instant::now();
        let called = std::sync::atomic::AtomicBool::new(false);
        let results = evaluate_targets(&targets, deadline, |_target| {
            called.store(true, std::sync::atomic::Ordering::SeqCst);
            async { RouteResult::default() }
        })
        .await;

        assert!(
            !called.load(std::sync::atomic::Ordering::SeqCst),
            "eval не должен вызываться для цели, до которой не добрались в рамках общего бюджета"
        );
        assert_eq!(results[0].outcome, Outcome::Error);
        assert_eq!(results[0].error.as_deref(), Some(TIMEOUT_MESSAGE));
    }
}
