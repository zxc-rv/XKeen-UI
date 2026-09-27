//! Резолвинг домена для тестера маршрутов: mihomo `GET /dns/query` через `ClashTarget`,
//! фолбэк — DoH (`geo::resolve_domain`). Таймаут — 3 с на попытку к mihomo, до 4 с суммарно на
//! DoH-фолбэк (`geo::resolve_domain` сам может идти до 20 с — 2 провайдера × 2 типа записи × 5 с —
//! это нормально для `/api/geo`, где это единственный запрос, но недопустимо на цель тестера
//! маршрутов, где таких резолвов может быть до 500; функция `geo.rs` не трогаем, обрезаем таймаутом
//! только здесь). `CachingResolver` — обёртка с кэшем на весь HTTP-запрос `/api/route-test`, чтобы
//! один и тот же домен из разных целей резолвился один раз (см. `route_test::mod::post_route_test`).

use crate::api_relay::{self, ClashTarget};
use crate::geo;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(3);
const DOH_FALLBACK_TIMEOUT: Duration = Duration::from_secs(4);

/// Источник резолва, попадает в `RouteResult::dns_source`.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DnsSource {
    Mihomo,
    Doh,
}

/// Резолвер домена в набор IP. `async fn` в трейте — используется только через generic-параметр
/// (`fn evaluate<R: Resolver>`), никогда как `dyn Resolver`. Супертрейты `Send + Sync` нужны, чтобы
/// рекурсивный вычислитель правил (`mihomo::eval_predicate`) мог боксировать future как `Send` —
/// иначе axum-хендлер `post_route_test` не соберётся (см. `route_test::mod::_assert_route_test_bounds`).
/// Через `<R: Resolver>` эти супертрейты автоматически доступны везде, включая заморож`ённый
/// `ActiveEngine::evaluate<R: Resolver>` в `mod.rs` — его не нужно трогать. Возвращаем
/// `impl Future + Send` явно (а не `async fn` в трейте), т.к. супертрейты трейта сами по себе на
/// возвращаемый `impl Future` метода не переносятся.
pub trait Resolver: Send + Sync {
    fn resolve(
        &self, domain: &str,
    ) -> impl std::future::Future<Output = Result<(Vec<IpAddr>, DnsSource), String>> + Send;
}

/// Боевой резолвер: mihomo REST API (если ядро mihomo и передан `ClashTarget`), иначе DoH.
pub struct LiveResolver {
    clash: Option<ClashTarget>,
    http: reqwest::Client,
}

impl LiveResolver {
    pub fn new(clash: Option<ClashTarget>, http: reqwest::Client) -> Self {
        Self { clash, http }
    }

    /// Тип 1 (A); AAAA (28) пробуем только если A не вернул ни одной записи — как у mihomo
    /// (`resolver.ResolveIP` предпочитает IPv4).
    async fn query_mihomo(&self, target: &ClashTarget, domain: &str) -> Result<Vec<IpAddr>, String> {
        let ips = Self::query_mihomo_type(target, &self.http, domain, "A", 1).await?;
        if !ips.is_empty() {
            return Ok(ips);
        }
        Self::query_mihomo_type(target, &self.http, domain, "AAAA", 28).await
    }

    async fn query_mihomo_type(
        target: &ClashTarget, default_client: &reqwest::Client, domain: &str, qtype: &str, rtype_code: i32,
    ) -> Result<Vec<IpAddr>, String> {
        #[derive(serde::Deserialize)]
        struct DnsQueryResponse {
            #[serde(rename = "Answer")]
            answer: Option<Vec<DnsAnswer>>,
        }
        #[derive(serde::Deserialize)]
        struct DnsAnswer {
            #[serde(rename = "type")]
            rtype: i32,
            data: String,
        }

        let path = format!("dns/query?name={}&type={}", urlencoding::encode(domain), qtype);

        let (url, client, secret): (String, reqwest::Client, Option<String>) = match target {
            ClashTarget::Tcp { host, port, secret } => (
                api_relay::build_url("http", host, port, &path, None),
                default_client.clone(),
                secret.clone(),
            ),
            ClashTarget::Unix { path: socket_path } => {
                let url = api_relay::build_url("http", "127.0.0.1", "80", &path, None);
                let client = reqwest::Client::builder()
                    .unix_socket(socket_path.clone())
                    .user_agent("XKeen-UI")
                    .timeout(RESOLVE_TIMEOUT)
                    .build()
                    .map_err(|e| e.to_string())?;
                (url, client, None)
            }
        };

        let mut req = client.get(&url).timeout(RESOLVE_TIMEOUT);
        if let Some(secret) = secret {
            req = req.header("Authorization", format!("Bearer {secret}"));
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("mihomo DNS ответил {}", resp.status()));
        }
        let parsed: DnsQueryResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(parsed
            .answer
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a.rtype == rtype_code)
            .filter_map(|a| a.data.parse::<IpAddr>().ok())
            .collect())
    }
}

impl Resolver for LiveResolver {
    async fn resolve(&self, domain: &str) -> Result<(Vec<IpAddr>, DnsSource), String> {
        if let Some(target) = &self.clash
            && let Ok(ips) = self.query_mihomo(target, domain).await
            && !ips.is_empty()
        {
            return Ok((ips, DnsSource::Mihomo));
        }
        // `geo::resolve_domain` сама по себе не ограничена по времени так жёстко, как нужно тестеру
        // маршрутов (см. doc-комментарий модуля) — обрезаем её здесь, не трогая саму функцию.
        let ip = match tokio::time::timeout(DOH_FALLBACK_TIMEOUT, geo::resolve_domain(&self.http, domain)).await {
            Ok(result) => result?,
            Err(_) => return Err("истёк таймаут DoH-резолва".to_string()),
        };
        Ok((vec![ip], DnsSource::Doh))
    }
}

/// Оборачивает любой `Resolver` кэшем на весь HTTP-запрос `/api/route-test`: одинаковый домен из
/// разных целей (или после дедупликации целей — из разных top-level правил внутри одной цели)
/// резолвится один раз, включая неудачные попытки (не повторяем падающий резолв на каждую цель).
/// Промах кэша при параллельных попытках на один и тот же домен (см. `MAX_CONCURRENCY` в mod.rs)
/// может привести к повторному запросу — это допустимо (тот же компромисс, что у `IdleCache`),
/// не пытаемся схлопывать через single-flight.
type ResolveResult = Result<(Vec<IpAddr>, DnsSource), String>;

pub struct CachingResolver<'a, R: Resolver> {
    inner: &'a R,
    cache: Mutex<HashMap<String, ResolveResult>>,
}

impl<'a, R: Resolver> CachingResolver<'a, R> {
    pub fn new(inner: &'a R) -> Self {
        Self {
            inner,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl<'a, R: Resolver> Resolver for CachingResolver<'a, R> {
    async fn resolve(&self, domain: &str) -> Result<(Vec<IpAddr>, DnsSource), String> {
        if let Some(cached) = self.cache.lock().unwrap().get(domain).cloned() {
            return cached;
        }
        let result = self.inner.resolve(domain).await;
        self.cache.lock().unwrap().insert(domain.to_string(), result.clone());
        result
    }
}

/// Резолвер на фикстуре, для юнит-тестов mihomo/xray движков.
#[cfg(test)]
pub struct StaticResolver(pub std::collections::HashMap<String, Vec<IpAddr>>);

#[cfg(test)]
impl Resolver for StaticResolver {
    async fn resolve(&self, domain: &str) -> Result<(Vec<IpAddr>, DnsSource), String> {
        self.0
            .get(domain)
            .cloned()
            .map(|ips| (ips, DnsSource::Doh))
            .ok_or_else(|| "нет записи".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingResolver {
        calls: AtomicUsize,
    }

    impl Resolver for CountingResolver {
        async fn resolve(&self, domain: &str) -> Result<(Vec<IpAddr>, DnsSource), String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if domain == "fail.example" {
                return Err("boom".into());
            }
            Ok((vec!["1.2.3.4".parse().unwrap()], DnsSource::Doh))
        }
    }

    #[tokio::test]
    async fn caching_resolver_dedupes_repeated_lookups_of_the_same_domain() {
        let inner = CountingResolver {
            calls: AtomicUsize::new(0),
        };
        let cached = CachingResolver::new(&inner);
        assert!(cached.resolve("x.com").await.is_ok());
        assert!(cached.resolve("x.com").await.is_ok());
        assert!(cached.resolve("x.com").await.is_ok());
        assert_eq!(
            inner.calls.load(Ordering::SeqCst),
            1,
            "повторные обращения не должны идти во внутренний резолвер"
        );
    }

    #[tokio::test]
    async fn caching_resolver_also_caches_failed_lookups() {
        // "не повторяем падающий резолв на каждую цель" — неудачные попытки кэшируются тоже.
        let inner = CountingResolver {
            calls: AtomicUsize::new(0),
        };
        let cached = CachingResolver::new(&inner);
        assert!(cached.resolve("fail.example").await.is_err());
        assert!(cached.resolve("fail.example").await.is_err());
        assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn caching_resolver_keeps_distinct_domains_separate() {
        // "www.x.com vs x.com are different, fine" — ключ кэша строгий, без нормализации.
        let inner = CountingResolver {
            calls: AtomicUsize::new(0),
        };
        let cached = CachingResolver::new(&inner);
        assert!(cached.resolve("www.x.com").await.is_ok());
        assert!(cached.resolve("x.com").await.is_ok());
        assert_eq!(inner.calls.load(Ordering::SeqCst), 2);
    }
}
