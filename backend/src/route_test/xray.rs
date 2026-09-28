//! Вычислитель правил xray: сборка `routing`/`outbounds`/`inbounds` из `*.json` в `XRAY_CONF_DIR`
//! (JSONC), матчер правил (AND по заданным полям, OR внутри списков, трёхзначная логика
//! Match/NoMatch/Unknown), `domainStrategy`.
//!
//! Семантика сверена с исходниками XTLS/Xray-core (не по памяти):
//! - JSON-поля правила и их алиасы (`domain`/`domains`, `sourceIP`/`source`, `attrs` и т.д.) —
//!   `infra/conf/router.go` (`parseFieldRule`).
//! - `Rule = AND` по присутствующим полям, внутри списка — `OR` — `app/router/router.go`
//!   (`BuildCondition`), `app/router/condition.go` (`ConditionChan.Apply`, `*Matcher.Apply`).
//! - Синтаксис `domain`/`ip` (`regexp:`, `domain:`, `full:`, `keyword:`, `dotless:`, `geosite:`,
//!   `geoip:`, `ext:`/`ext-domain:`/`ext-site:`/`ext-ip:`, `!` reverse) —
//!   `common/geodata/rule_parser.go` (`ParseDomainRule`/`ParseIPRules`), формат `.dat` и attrs —
//!   `common/geodata/geodat.proto`, `common/geodata/geodat_loader.go` (`NewAllAttrsMatcher`: ВСЕ
//!   атрибуты должны присутствовать, это "И").
//! - `domainStrategy`: `AsIs`/`IpIfNonMatch`/`IpOnDemand` и порядок резолва —
//!   `infra/conf/router.go` (`getDomainStrategy`), `app/router/router.go` (`pickRouteInternal`):
//!   `IpOnDemand` резолвит домен один раз перед первым проходом; `IpIfNonMatch` сначала проверяет
//!   правила без резолва и, если совпадения нет, резолвит и повторяет проход теми же правилами;
//!   `AsIs` никогда не резолвит — `ip`-условия для домена детерминированно `NoMatch` (в реальном
//!   xray `IPMatcher.AnyMatch` на пустом списке IP возвращает `false`, не ошибку).
//! - Дефолтный outbound = первый в итоговом `OutboundConfigs` — `app/proxyman/outbound/outbound.go`
//!   (`Manager.AddHandler`: `if m.defaultHandler == nil { m.defaultHandler = handler }`, вызывается
//!   в порядке `OutboundConfigs`).
//! - Слияние нескольких файлов конфига: `infra/conf/serial/builder.go` (`mergeConfigs`) грузит файлы
//!   по порядку и для каждого следующего вызывает `infra/conf/xray.go` (`Config.Override`) — это
//!   **не** плоская конкатенация, как в упрощённом описании в spec-доке:
//!   - `routing` (со всем, что внутри — `domainStrategy`, `balancers`, `rules`) целиком заменяется
//!     последним файлом, где ключ `routing` присутствует;
//!   - `inbounds`/`outbounds` мержатся по тегу: совпал тег — запись в списке заменяется на месте;
//!     новый тег у inbound — добавляется в конец;
//!   - новый тег у outbound — по умолчанию **вставляется в начало** списка (не в конец!), и только
//!     если имя файла (без учёta регистра) содержит `tail` — добавляется в конец. Это меняет, какой
//!     outbound окажется первым (= дефолтным) после мержа нескольких файлов — намеренное поведение
//!     xray для файлов вида `99_tail.json`.
//!
//!   Порядок файлов — сортировка по имени (`os.ReadDir`/`main/run.go:readConfDir` отдают файлы уже
//!   отсортированными; наш `read_dir` + `sort_by_key(file_name)` даёт тот же порядок для ASCII-имён).
//! - `sniffing`/`routeOnly` на выбранном (по `inboundTag` запроса) inbound'е: правила видят не то,
//!   что ввёл пользователь тестера, а то, во что превратился `ob.Target`/`ob.RouteTarget`
//!   (`common/session`) после (не)сработавшего sniffing-оверрайда в `app/dispatcher/default.go`
//!   (`Dispatch`/`DispatchLink`, `shouldOverride`), прочитанные в `features/routing/session/context.go`
//!   (`GetTargetDomain`: сперва `RouteTarget`, потом `Target`; `GetTargetIPs`: **только** `Target`,
//!   `RouteTarget` не смотрит) и в `features/routing/dns/context.go`
//!   (`ResolvableContext.GetTargetIPs`, только под `IpOnDemand`: сперва пытается резолвить именно
//!   `GetTargetDomain()`, и лишь при ошибке DNS откатывается на `ctx.Context.GetTargetIPs()`).
//!   Моделируем это только для "прозрачных" протоколов без домена в самом протоколе —
//!   `dokodemo-door`/`tunnel`/`tun` (`infra/conf/xray.go::inboundConfigLoader`): у них исходный
//!   `ob.Target` — IP, который клиент/ОС уже знали, домен целиком зависит от sniffing. Для
//!   остальных протоколов (vmess/vless/trojan/socks/http/…) домен обычно приходит из самого
//!   протокола, `ob.Target` = домен с самого начала — оставляем текущее (без sniffing) поведение.
//!   Для выбранного "прозрачного" inbound'а с целью-доменом:
//!   - `sniffing.enabled == false`, ИЛИ `destOverride` пуст (`shouldOverride`:
//!     `for _, p := range request.OverrideDestinationForProtocol` — пустой список не даёт `true`
//!     никогда), ИЛИ `metadataOnly == true` (`app/dispatcher/sniffer.go::NewSniffer`:
//!     `metadataSniffer` стоит только у fakedns-сниффера — HTTP/TLS/QUIC/BitTorrent туда не входят,
//!     при `metadataOnly` домен из реального трафика не сниффится в принципе), ИЛИ домен подпадает
//!     под `sniffing.domainsExcluded` (тот же матчер и тот же дефолт `Domain_Substr`, что и у
//!     `domain`-условий правил — `infra/conf/xray.go::SniffingConfig.Build` зовёт ту же
//!     `geodata.ParseDomainRules`) — override не срабатывает: `ob.Target` остаётся IP, `RouteTarget`
//!     невалиден, `GetTargetDomain()` = `""` ⇒ домен-условия детерминированно `NoMatch`, а
//!     `ip`-условия видят IP сразу, независимо от `domainStrategy` (`pickRouteInternal` пропускает
//!     второй проход `IpIfNonMatch` при пустом `GetTargetDomain()`).
//!   - override срабатывает и `routeOnly == false`: sniffed-домен становится самим `ob.Target` —
//!     это ровно текущее (не тронутое) поведение, `domainStrategy` работает как раньше.
//!   - override срабатывает и `routeOnly == true`: `RouteTarget` = sniffed-домен, `Target` остаётся
//!     исходным IP — домен виден (через `RouteTarget`), IP виден сразу же, независимо от
//!     `domainStrategy`. Под `IpOnDemand` реальный xray резолвил бы именно sniffed-домен
//!     (`ResolvableContext.GetTargetIPs` сперва смотрит на домен), а не готовый IP клиента — но
//!     тестеру взять "уже известный IP клиента" неоткуда, поэтому IP получаем одинаково во всех этих
//!     под-случаях: через резолвер тестера по введённому домену, один раз в начале прохода, без
//!     второго прохода `IpIfNonMatch`.
//!
//!   `ipsExcluded` не моделируем — проверяется по адресу до оверрайда, а у тестера его не существует,
//!   когда цель — домен.

use super::cidr::Cidr;
use super::dns::{DnsSource, Resolver};
use super::{BalancerInfo, MatchedRule, Network as ReqNetwork, Outcome, RouteResult, SkippedRule, Target, TestContext};
use crate::route_test::geodb;
use crate::types::{XRAY_ASSET_DIR, XRAY_CONF_DIR};
use regex_lite::Regex;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer};
use std::collections::HashSet;
use std::fmt;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ---------------------------------------------------------------------------------------------
// JSONC: комментарии `//`/`/* */` и висячие запятые вне строк.
// ---------------------------------------------------------------------------------------------

fn strip_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escape = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                chars.next();
                for nc in chars.by_ref() {
                    if nc == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for nc in chars.by_ref() {
                    if prev == '*' && nc == '/' {
                        break;
                    }
                    prev = nc;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn strip_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escape = false;
    let mut trailing_comma_at: Option<usize> = None;
    for c in input.chars() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                trailing_comma_at = None;
                out.push(c);
            }
            ',' => {
                trailing_comma_at = Some(out.len());
                out.push(c);
            }
            c if c.is_whitespace() => out.push(c),
            '}' | ']' => {
                if let Some(pos) = trailing_comma_at.take() {
                    out.truncate(pos);
                }
                out.push(c);
            }
            _ => {
                trailing_comma_at = None;
                out.push(c);
            }
        }
    }
    out
}

fn strip_jsonc(input: &str) -> String {
    strip_trailing_commas(&strip_comments(input))
}

// ---------------------------------------------------------------------------------------------
// Разбор JSON-конфига xray (только поля, нужные тестеру маршрутов).
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct StringList(Vec<String>);

impl<'de> Deserialize<'de> for StringList {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = StringList;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "строка или массив строк")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<StringList, E> {
                Ok(StringList(
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect(),
                ))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<StringList, A::Error> {
                let mut out = Vec::new();
                while let Some(s) = seq.next_element::<String>()? {
                    out.push(s);
                }
                Ok(StringList(out))
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Debug, Clone, Default)]
struct PortSpec {
    ranges: Vec<(u32, u32)>,
    raw: String,
}

impl PortSpec {
    fn contains(&self, port: u16) -> bool {
        self.ranges
            .iter()
            .any(|&(a, b)| (port as u32) >= a && (port as u32) <= b)
    }

    fn parse_str(s: &str) -> Result<Self, String> {
        let mut ranges = Vec::new();
        for part in s.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            if let Some((a, b)) = part.split_once('-') {
                let a: u32 = a.trim().parse().map_err(|_| format!("некорректный порт: {part}"))?;
                let b: u32 = b.trim().parse().map_err(|_| format!("некорректный порт: {part}"))?;
                ranges.push((a, b));
            } else {
                let p: u32 = part.parse().map_err(|_| format!("некорректный порт: {part}"))?;
                ranges.push((p, p));
            }
        }
        Ok(PortSpec {
            ranges,
            raw: s.to_string(),
        })
    }
}

impl<'de> Deserialize<'de> for PortSpec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = PortSpec;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "число или строка с портами")
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<PortSpec, E> {
                Ok(PortSpec {
                    ranges: vec![(v as u32, v as u32)],
                    raw: v.to_string(),
                })
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<PortSpec, E> {
                self.visit_u64(v as u64)
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<PortSpec, E> {
                PortSpec::parse_str(v).map_err(de::Error::custom)
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize, Default, Clone)]
struct RawOutbound {
    #[serde(default)]
    tag: String,
}

#[derive(Deserialize, Default, Clone)]
struct RawInbound {
    #[serde(default)]
    tag: String,
    #[serde(default)]
    protocol: String,
    #[serde(default)]
    sniffing: Option<RawSniffingConfig>,
}

/// `infra/conf/xray.go::SniffingConfig` — только поля, нужные тестеру (`ipsExcluded` не моделируем,
/// см. блок-комментарий модуля).
#[derive(Deserialize, Default, Clone)]
struct RawSniffingConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default, rename = "destOverride")]
    dest_override: StringList,
    #[serde(default, rename = "domainsExcluded")]
    domains_excluded: StringList,
    #[serde(default, rename = "metadataOnly")]
    metadata_only: bool,
    #[serde(default, rename = "routeOnly")]
    route_only: bool,
}

#[derive(Deserialize, Default, Clone)]
struct RawBalancer {
    #[serde(default)]
    tag: String,
    #[serde(default, rename = "selector")]
    selector: StringList,
    #[serde(default, rename = "fallbackTag")]
    fallback_tag: String,
}

#[derive(Deserialize, Default, Clone)]
struct RawRule {
    #[serde(default, rename = "ruleTag")]
    rule_tag: String,
    #[serde(default, rename = "outboundTag")]
    outbound_tag: String,
    #[serde(default, rename = "balancerTag")]
    balancer_tag: String,
    #[serde(default)]
    domain: Option<StringList>,
    #[serde(default)]
    domains: Option<StringList>,
    #[serde(default)]
    ip: Option<StringList>,
    #[serde(default)]
    port: Option<PortSpec>,
    #[serde(default)]
    network: Option<StringList>,
    #[serde(default, rename = "sourceIP")]
    source_ip: Option<StringList>,
    #[serde(default)]
    source: Option<StringList>,
    #[serde(default, rename = "sourcePort")]
    source_port: Option<PortSpec>,
    #[serde(default, rename = "inboundTag")]
    inbound_tag: Option<StringList>,
    #[serde(default)]
    user: Option<StringList>,
    #[serde(default)]
    protocol: Option<StringList>,
    #[serde(default)]
    attrs: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, rename = "localIP")]
    local_ip: Option<StringList>,
    #[serde(default, rename = "localPort")]
    local_port: Option<PortSpec>,
    #[serde(default)]
    process: Option<StringList>,
    #[serde(default, rename = "localOS")]
    local_os: Option<StringList>,
    #[serde(default, rename = "vlessRoute")]
    vless_route: Option<PortSpec>,
}

#[derive(Deserialize, Default, Clone)]
struct RawRouting {
    #[serde(default, rename = "domainStrategy")]
    domain_strategy: Option<String>,
    #[serde(default)]
    rules: Vec<RawRule>,
    #[serde(default)]
    balancers: Vec<RawBalancer>,
}

#[derive(Deserialize, Default)]
struct RawConfig {
    #[serde(default)]
    routing: Option<RawRouting>,
    #[serde(default)]
    outbounds: Vec<RawOutbound>,
    #[serde(default)]
    inbounds: Vec<RawInbound>,
}

/// `infra/conf/xray.go` (`Config.Override`): routing заменяется целиком, inbounds/outbounds
/// мержатся по тегу, новые outbound-теги вставляются в начало списка (кроме имени файла с `tail`).
fn override_config(base: &mut RawConfig, incoming: RawConfig, filename: &str) {
    if incoming.routing.is_some() {
        base.routing = incoming.routing;
    }
    for ib in incoming.inbounds {
        if let Some(existing) = base.inbounds.iter_mut().find(|e| e.tag == ib.tag) {
            *existing = ib;
        } else {
            base.inbounds.push(ib);
        }
    }
    let is_tail = filename.to_lowercase().contains("tail");
    let mut prepends = Vec::new();
    for ob in incoming.outbounds {
        if let Some(existing) = base.outbounds.iter_mut().find(|e| e.tag == ob.tag) {
            *existing = ob;
        } else if is_tail {
            base.outbounds.push(ob);
        } else {
            prepends.push(ob);
        }
    }
    if !is_tail && !prepends.is_empty() {
        prepends.append(&mut base.outbounds);
        base.outbounds = prepends;
    }
}

// ---------------------------------------------------------------------------------------------
// Скомпилированные условия правила.
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
enum DomainItem {
    Substr { value: String, raw: String },
    Regex { re: Regex, raw: String },
    Suffix { value: String, raw: String },
    Full { value: String, raw: String },
    Geosite { file: PathBuf, tag: String, raw: String },
}

#[derive(Clone)]
enum IpItem {
    Cidr {
        cidr: Cidr,
        reverse: bool,
        raw: String,
    },
    Geoip {
        file: PathBuf,
        tag: String,
        reverse: bool,
        raw: String,
    },
}

#[derive(Clone)]
enum RuleTarget {
    Outbound(String),
    Balancer(String),
}

struct CompiledRule {
    original_index: usize,
    target: RuleTarget,
    domain: Option<Vec<DomainItem>>,
    ip: Option<Vec<IpItem>>,
    port: Option<PortSpec>,
    network: Option<Vec<String>>,
    source_ip: Option<Vec<IpItem>>,
    inbound_tag: Option<Vec<String>>,
    unsupported: Vec<String>,
    summary: String,
}

/// `infra/conf/xray.go::inboundConfigLoader`: единственные протоколы без домена в самом протоколе —
/// клиент/ОС отдают только IP, домен целиком зависит от sniffing (см. блок-комментарий модуля).
const TRANSPARENT_PROTOCOLS: &[&str] = &["dokodemo-door", "tunnel", "tun"];

/// Что нужно от `inbound.sniffing` тестеру: остальные поля (`ipsExcluded`) не моделируем.
struct InboundInfo {
    is_transparent: bool,
    sniffing_enabled: bool,
    metadata_only: bool,
    /// Только "список непуст" — конкретный состав `destOverride` (`http`/`tls`/`quic`/`fakedns`,
    /// и связанный с `fakedns` особый случай `routeOnly`) намеренно не моделируется: тестер не
    /// знает, каким протоколом реально шёл бы синтетический трафик до цели.
    dest_override_present: bool,
    route_only: bool,
    domains_excluded: Vec<DomainItem>,
}

fn resolve_asset_path(asset_dir: &Path, file: &str) -> PathBuf {
    let name = Path::new(file)
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(file));
    asset_dir.join(name)
}

/// `common/geodata/rule_parser.go::cutReversePrefix`: снимает ведущие `!`, каждый переключает флаг.
fn cut_reverse_prefix(s: &str) -> (&str, bool) {
    let mut rest = s;
    let mut reverse = false;
    while let Some(stripped) = rest.strip_prefix('!') {
        rest = stripped;
        reverse = !reverse;
    }
    (rest, reverse)
}

/// `common/geodata/rule_parser.go::ParseIPRules`: `geoip:TAG` → `ext:geoip.dat:TAG`, `ext:`/`ext-ip:`
/// — файл из `XRAY_ASSET_DIR`, иначе — голый CIDR/IP (по умолчанию `/32` или `/128`).
fn parse_ip_item(raw: &str, asset_dir: &Path) -> Result<IpItem, String> {
    let (s, reverse) = cut_reverse_prefix(raw);
    let s = s
        .strip_prefix("geoip:")
        .map(|rest| format!("ext:geoip.dat:{rest}"))
        .unwrap_or_else(|| s.to_string());
    for prefix in ["ext:", "ext-ip:"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let (file, code_part) = rest
                .split_once(':')
                .ok_or_else(|| format!("некорректное правило ip: {raw}"))?;
            if file.is_empty() {
                return Err(format!("пустой файл в правиле ip: {raw}"));
            }
            let (code, code_reverse) = cut_reverse_prefix(code_part);
            if code.is_empty() {
                return Err(format!("пустой код в правиле ip: {raw}"));
            }
            return Ok(IpItem::Geoip {
                file: resolve_asset_path(asset_dir, file),
                tag: code.to_uppercase(),
                reverse: reverse != code_reverse,
                raw: raw.to_string(),
            });
        }
    }
    // Голый IP без `/bits` разрешён (xray `"ip": ["1.2.3.4"]`) — по умолчанию на всю длину адреса.
    let cidr = Cidr::parse_or_host(&s).ok_or_else(|| format!("некорректный ip в правиле {raw}"))?;
    Ok(IpItem::Cidr {
        cidr,
        reverse,
        raw: raw.to_string(),
    })
}

/// `common/geodata/rule_parser.go::ParseDomainRule`: `geosite:TAG[@attr]` → `ext:geosite.dat:TAG…`,
/// `ext:`/`ext-domain:`/`ext-site:` — файл из `XRAY_ASSET_DIR` (attrs передаются в `geodb` как
/// `TAG@attr1@attr2`, там ВСЕ атрибуты обязаны присутствовать — см. `geodb.rs`); `regexp:`/`domain:`/
/// `full:`/`keyword:`/`dotless:` — как в оригинале; без префикса — подстрока (`Substr`).
fn parse_domain_item(raw: &str, asset_dir: &Path) -> Result<DomainItem, String> {
    let s = raw
        .strip_prefix("geosite:")
        .map(|rest| format!("ext:geosite.dat:{rest}"))
        .unwrap_or_else(|| raw.to_string());
    for prefix in ["ext:", "ext-domain:", "ext-site:"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let (file, code_with_attrs) = rest
                .split_once(':')
                .ok_or_else(|| format!("некорректное правило domain: {raw}"))?;
            if file.is_empty() {
                return Err(format!("пустой файл в правиле domain: {raw}"));
            }
            if code_with_attrs.ends_with('@') || code_with_attrs.contains("@@") {
                return Err(format!("пустой атрибут в правиле domain: {raw}"));
            }
            let (code, attrs) = code_with_attrs.split_once('@').unwrap_or((code_with_attrs, ""));
            if code.is_empty() {
                return Err(format!("пустой код в правиле domain: {raw}"));
            }
            let tag = if attrs.is_empty() {
                code.to_uppercase()
            } else {
                format!("{}@{}", code.to_uppercase(), attrs.to_lowercase())
            };
            return Ok(DomainItem::Geosite {
                file: resolve_asset_path(asset_dir, file),
                tag,
                raw: raw.to_string(),
            });
        }
    }
    if let Some(v) = raw.strip_prefix("regexp:") {
        let re = Regex::new(v).map_err(|e| format!("некорректный regexp в {raw}: {e}"))?;
        return Ok(DomainItem::Regex {
            re,
            raw: raw.to_string(),
        });
    }
    if let Some(v) = raw.strip_prefix("domain:") {
        return Ok(DomainItem::Suffix {
            value: v.to_lowercase(),
            raw: raw.to_string(),
        });
    }
    if let Some(v) = raw.strip_prefix("full:") {
        return Ok(DomainItem::Full {
            value: v.to_lowercase(),
            raw: raw.to_string(),
        });
    }
    if let Some(v) = raw.strip_prefix("keyword:") {
        return Ok(DomainItem::Substr {
            value: v.to_lowercase(),
            raw: raw.to_string(),
        });
    }
    if let Some(v) = raw.strip_prefix("dotless:") {
        let pattern = if v.is_empty() {
            "^[^.]*$".to_string()
        } else if !v.contains('.') {
            format!("^[^.]*{v}[^.]*$")
        } else {
            return Err(format!("dotless: {v} содержит точку"));
        };
        let re = Regex::new(&pattern).map_err(|e| format!("некорректный dotless в {raw}: {e}"))?;
        return Ok(DomainItem::Regex {
            re,
            raw: raw.to_string(),
        });
    }
    Ok(DomainItem::Substr {
        value: raw.to_lowercase(),
        raw: raw.to_string(),
    })
}

/// Максимум элементов списка, показываемых в тексте правила до `… (+N)` — длинные geosite/geoip
/// списки иначе делают строку нечитаемой.
const SUMMARY_LIST_LIMIT: usize = 5;

/// `items` через `, `; сверх `SUMMARY_LIST_LIMIT` — обрезка с счётчиком остатка.
fn join_list(items: &[String]) -> String {
    if items.len() <= SUMMARY_LIST_LIMIT {
        items.join(", ")
    } else {
        format!(
            "{}, … (+{})",
            items[..SUMMARY_LIST_LIMIT].join(", "),
            items.len() - SUMMARY_LIST_LIMIT
        )
    }
}

/// Текст правила для UI (`rule.text`/`skipped[].text`): условия в конфиг-словаре xray, поля через
/// `; ` в фиксированном порядке, без outbound/balancerTag — цель показывается в UI отдельным
/// бейджем, дублировать её в тексте не нужно (см. также `skipped_rule_text_matches_same_format`
/// в тестах).
fn build_summary(raw: &RawRule, domain_raw: &[String], ip_raw: &[String]) -> String {
    let mut parts = Vec::new();
    if !domain_raw.is_empty() {
        parts.push(format!("domain: {}", join_list(domain_raw)));
    }
    if !ip_raw.is_empty() {
        parts.push(format!("ip: {}", join_list(ip_raw)));
    }
    if let Some(p) = &raw.port {
        parts.push(format!("port: {}", p.raw));
    }
    if let Some(n) = &raw.network
        && !n.0.is_empty()
    {
        parts.push(format!("network: {}", join_list(&n.0)));
    }
    let source = raw.source_ip.clone().or_else(|| raw.source.clone()).unwrap_or_default();
    if !source.0.is_empty() {
        parts.push(format!("source: {}", join_list(&source.0)));
    }
    if raw.source_port.is_some() {
        parts.push("sourcePort".into());
    }
    if let Some(t) = &raw.inbound_tag
        && !t.0.is_empty()
    {
        parts.push(format!("inboundTag: {}", join_list(&t.0)));
    }
    for (label, present) in [
        ("user", raw.user.as_ref().is_some_and(|l| !l.0.is_empty())),
        ("protocol", raw.protocol.as_ref().is_some_and(|l| !l.0.is_empty())),
        ("attrs", raw.attrs.as_ref().is_some_and(|m| !m.is_empty())),
        ("localIP", raw.local_ip.as_ref().is_some_and(|l| !l.0.is_empty())),
        ("localPort", raw.local_port.is_some()),
        ("process", raw.process.as_ref().is_some_and(|l| !l.0.is_empty())),
        ("localOS", raw.local_os.as_ref().is_some_and(|l| !l.0.is_empty())),
        ("vlessRoute", raw.vless_route.is_some()),
    ] {
        if present {
            parts.push(label.to_string());
        }
    }
    let joined = parts.join("; ");
    if raw.rule_tag.is_empty() {
        joined
    } else if joined.is_empty() {
        format!("ruleTag: {}", raw.rule_tag)
    } else {
        format!("ruleTag: {}; {joined}", raw.rule_tag)
    }
}

fn compile_rule(index: usize, raw: &RawRule, asset_dir: &Path) -> Result<Option<CompiledRule>, String> {
    let target = if !raw.outbound_tag.is_empty() {
        RuleTarget::Outbound(raw.outbound_tag.clone())
    } else if !raw.balancer_tag.is_empty() {
        RuleTarget::Balancer(raw.balancer_tag.clone())
    } else {
        return Err("ни outboundTag, ни balancerTag не заданы".into());
    };

    // `domains` — alias, полностью замещает `domain`, если присутствует (infra/conf/router.go).
    let domain_raw: Option<&StringList> = raw.domains.as_ref().or(raw.domain.as_ref());
    let domain = domain_raw
        .filter(|l| !l.0.is_empty())
        .map(|l| {
            l.0.iter()
                .map(|s| parse_domain_item(s, asset_dir))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;

    let ip_raw = raw.ip.as_ref().filter(|l| !l.0.is_empty());
    let ip = ip_raw
        .map(|l| {
            l.0.iter()
                .map(|s| parse_ip_item(s, asset_dir))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;

    let source_raw = raw
        .source_ip
        .as_ref()
        .or(raw.source.as_ref())
        .filter(|l| !l.0.is_empty());
    let source_ip = source_raw
        .map(|l| {
            l.0.iter()
                .map(|s| parse_ip_item(s, asset_dir))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;

    let network = raw
        .network
        .as_ref()
        .filter(|l| !l.0.is_empty())
        .map(|l| l.0.iter().map(|s| s.to_lowercase()).collect());
    let inbound_tag = raw
        .inbound_tag
        .as_ref()
        .filter(|l| !l.0.is_empty())
        .map(|l| l.0.clone());
    let port = raw.port.clone();
    let source_port_present = raw.source_port.is_some();

    let mut unsupported = Vec::new();
    if raw.user.as_ref().is_some_and(|l| !l.0.is_empty()) {
        unsupported.push("user: не поддерживается тестером".to_string());
    }
    if raw.protocol.as_ref().is_some_and(|l| !l.0.is_empty()) {
        unsupported.push("protocol: не поддерживается тестером".to_string());
    }
    if raw.attrs.as_ref().is_some_and(|m| !m.is_empty()) {
        unsupported.push("attrs: не поддерживается тестером".to_string());
    }
    if raw.local_ip.as_ref().is_some_and(|l| !l.0.is_empty()) {
        unsupported.push("localIP: не поддерживается тестером".to_string());
    }
    if raw.local_port.is_some() {
        unsupported.push("localPort: не поддерживается тестером".to_string());
    }
    if raw.process.as_ref().is_some_and(|l| !l.0.is_empty()) {
        unsupported.push("process: не поддерживается тестером".to_string());
    }
    if raw.local_os.as_ref().is_some_and(|l| !l.0.is_empty()) {
        unsupported.push("localOS: не поддерживается тестером".to_string());
    }
    if raw.vless_route.is_some() {
        unsupported.push("vlessRoute: не поддерживается тестером".to_string());
    }
    if source_port_present {
        unsupported.push("sourcePort: не поддерживается тестером".to_string());
    }

    let has_any = domain.is_some()
        || ip.is_some()
        || port.is_some()
        || network.is_some()
        || source_ip.is_some()
        || inbound_tag.is_some()
        || !unsupported.is_empty();
    if !has_any {
        return Ok(None);
    }

    let domain_raw_strings = domain_raw.map(|l| l.0.clone()).unwrap_or_default();
    let ip_raw_strings = ip_raw.map(|l| l.0.clone()).unwrap_or_default();
    let summary = build_summary(raw, &domain_raw_strings, &ip_raw_strings);

    Ok(Some(CompiledRule {
        original_index: index,
        target,
        domain,
        ip,
        port,
        network,
        source_ip,
        inbound_tag,
        unsupported,
        summary,
    }))
}

// ---------------------------------------------------------------------------------------------
// Трёхзначная логика вычисления условий.
// ---------------------------------------------------------------------------------------------

enum FieldOutcome {
    Match(Option<String>),
    NoMatch,
    Unknown(String),
}

fn eval_domain(items: &[DomainItem], target: &Target, warn: &mut (dyn FnMut(String) + Send)) -> FieldOutcome {
    let Target::Domain(dom_low) = target else {
        return FieldOutcome::NoMatch;
    };
    let mut unknown = None;
    for item in items {
        match item {
            DomainItem::Substr { value, raw } => {
                if dom_low.contains(value.as_str()) {
                    return FieldOutcome::Match(Some(raw.clone()));
                }
            }
            DomainItem::Regex { re, raw } => {
                if re.is_match(dom_low) {
                    return FieldOutcome::Match(Some(raw.clone()));
                }
            }
            DomainItem::Suffix { value, raw } => {
                let hit = dom_low == value
                    || (dom_low.len() > value.len()
                        && dom_low.ends_with(value.as_str())
                        && dom_low.as_bytes()[dom_low.len() - value.len() - 1] == b'.');
                if hit {
                    return FieldOutcome::Match(Some(raw.clone()));
                }
            }
            DomainItem::Full { value, raw } => {
                if dom_low == value {
                    return FieldOutcome::Match(Some(raw.clone()));
                }
            }
            DomainItem::Geosite { file, tag, raw } => match geodb::site_contains(file, tag, dom_low) {
                Ok(true) => return FieldOutcome::Match(Some(raw.clone())),
                Ok(false) => {}
                Err(e) => {
                    let msg = format!("{raw}: {e}");
                    warn(msg.clone());
                    unknown.get_or_insert(format!("не удалось проверить {raw}: {e}"));
                }
            },
        }
    }
    match unknown {
        Some(r) => FieldOutcome::Unknown(r),
        None => FieldOutcome::NoMatch,
    }
}

/// Смотрит, лежит ли `ip` в объединении geoip-элементов бакета (короткое замыкание на первом
/// попадании). `Ok(Some(raw))` — попал, `raw` элемента, на котором сработало; `Ok(None)` —
/// определённо не попал ни в один; `Err` — файл/тег хотя бы одного элемента не удалось проверить
/// И среди проверенных не нашлось попадания (т.е. неясно, мог бы элемент дать `Some`).
fn geoip_bucket_lookup<'a>(
    bucket: &[(&'a Path, &'a str, &'a str)], ip: IpAddr, warn: &mut (dyn FnMut(String) + Send),
) -> Result<Option<&'a str>, String> {
    let mut error = None;
    for (file, tag, raw) in bucket {
        match geodb::ip_in_dat(file, tag, ip) {
            Ok(true) => return Ok(Some(raw)),
            Ok(false) => {}
            Err(e) => {
                warn(format!("{raw}: {e}"));
                error.get_or_insert(format!("не удалось проверить {raw}: {e}"));
            }
        }
    }
    match error {
        Some(e) => Err(e),
        None => Ok(None),
    }
}

/// `common/geodata/ip_matcher.go::buildOptimizedIPMatcher` (Xray-core): элементы одного списка `ip`
/// разбираются на 4 бакета — позитивные/негативные обычные CIDR и позитивные/негативные geoip;
/// внутри каждого бакета CIDR/geoip-множества ОБЪЕДИНЯЮТСЯ, и только к этому объединению целиком
/// применяется отрицание (а не к каждому элементу по отдельности — иначе `[geoip:!cn,geoip:!ru]`
/// матчил бы почти любой IP, ведь он не может быть одновременно в CN и в RU). Итог — OR по бакетам,
/// как в `HeuristicMultiIPMatcher.AnyMatch`; пустой бакет ничего не даёт (не считается ни `true`,
/// ни `false` — просто не участвует в OR).
fn eval_ip(items: &[IpItem], ips: &[IpAddr], warn: &mut (dyn FnMut(String) + Send)) -> FieldOutcome {
    if ips.is_empty() {
        return FieldOutcome::NoMatch;
    }

    let mut pos_custom = Vec::new();
    let mut neg_custom = Vec::new();
    let mut pos_geoip = Vec::new();
    let mut neg_geoip = Vec::new();
    for item in items {
        match item {
            IpItem::Cidr { cidr, reverse, raw } => {
                (if *reverse { &mut neg_custom } else { &mut pos_custom }).push((*cidr, raw.as_str()));
            }
            IpItem::Geoip {
                file,
                tag,
                reverse,
                raw,
            } => {
                (if *reverse { &mut neg_geoip } else { &mut pos_geoip }).push((
                    file.as_path(),
                    tag.as_str(),
                    raw.as_str(),
                ));
            }
        }
    }

    let mut unknown = None;

    // posCustom: IP в объединении позитивных CIDR — OR по элементам и по ips.
    if !pos_custom.is_empty() {
        for ip in ips {
            if let Some((_, raw)) = pos_custom.iter().find(|(cidr, _)| cidr.contains(*ip)) {
                return FieldOutcome::Match(Some((*raw).to_string()));
            }
        }
    }

    // negCustom: матчит, если ХОТЯ БЫ ОДИН из резолвленных ips лежит вне объединения негативных
    // CIDR (сам xray сравнивает так же — `AnyMatch` гоняет один и тот же матчер по всем ips).
    if !neg_custom.is_empty() {
        let in_union = |ip: IpAddr| neg_custom.iter().any(|(cidr, _)| cidr.contains(ip));
        if ips.iter().any(|ip| !in_union(*ip)) {
            let raw = neg_custom
                .iter()
                .map(|(_, r)| format!("!{r}"))
                .collect::<Vec<_>>()
                .join(", ");
            return FieldOutcome::Match(Some(raw));
        }
    }

    // posGeoip: то же самое, что posCustom, но через geodb (может дать Unknown при отсутствии файла).
    if !pos_geoip.is_empty() {
        for ip in ips {
            match geoip_bucket_lookup(&pos_geoip, *ip, warn) {
                Ok(Some(raw)) => return FieldOutcome::Match(Some(raw.to_string())),
                Ok(None) => {}
                Err(e) => {
                    unknown.get_or_insert(e);
                }
            }
        }
    }

    // negGeoip: матчит, если для какого-то ip объединение точно НЕ содержит его (Ok(None)).
    // Ok(Some(_)) для данного ip — этот ip точно в объединении, бакет для него не подходит, но
    // другие ips ещё могут дать матч. Err — для этого ip неясно, пробуем остальные ips.
    if !neg_geoip.is_empty() {
        for ip in ips {
            match geoip_bucket_lookup(&neg_geoip, *ip, warn) {
                Ok(None) => {
                    let raw = neg_geoip
                        .iter()
                        .map(|(_, _, r)| format!("!{r}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    return FieldOutcome::Match(Some(raw));
                }
                Ok(Some(_)) => {}
                Err(e) => {
                    unknown.get_or_insert(e);
                }
            }
        }
    }

    match unknown {
        Some(r) => FieldOutcome::Unknown(r),
        None => FieldOutcome::NoMatch,
    }
}

fn eval_port(port: &PortSpec, target_port: u16) -> FieldOutcome {
    if port.contains(target_port) {
        FieldOutcome::Match(None)
    } else {
        FieldOutcome::NoMatch
    }
}

fn eval_network(nets: &[String], network: ReqNetwork) -> FieldOutcome {
    let want = network.as_str();
    if nets.iter().any(|n| n.eq_ignore_ascii_case(want)) {
        FieldOutcome::Match(None)
    } else {
        FieldOutcome::NoMatch
    }
}

fn eval_inbound_tag(tags: &[String], ctx_tag: &Option<String>) -> FieldOutcome {
    match ctx_tag {
        None => FieldOutcome::Unknown("не задан inbound".into()),
        Some(t) => {
            if tags.iter().any(|x| x == t) {
                FieldOutcome::Match(None)
            } else {
                FieldOutcome::NoMatch
            }
        }
    }
}

fn eval_source_ip(items: &[IpItem], source_ip: &Option<IpAddr>, warn: &mut (dyn FnMut(String) + Send)) -> FieldOutcome {
    match source_ip {
        None => FieldOutcome::Unknown("нужен IP источника".into()),
        Some(ip) => eval_ip(items, std::slice::from_ref(ip), warn),
    }
}

/// Ленивый резолв домена в IP на один проход `evaluate()`: DNS-запрос уходит не раньше первого
/// обращения к `ips()`, то есть когда какое-то правило реально дошло до проверки `ip`
/// (`features/routing/dns/context.go` в Xray-core: `GetTargetIPs()` резолвит по требованию —
/// если более раннее правило уже совпало без `ip`-условия, DNS вообще не трогается). Результат
/// кэшируется на весь проход: второе и последующие правила с `ip` переиспользуют то же значение,
/// а не резолвят домен заново. `should_resolve` — по сути "есть ли у этого прохода DNS-клиент": для
/// `AsIs` и для первого прохода `IpIfNonMatch` его нет вообще, поэтому `ips()` для них сразу отдаёт
/// пустой список, ни разу не дёрнув резолвер.
struct LazyIps<'a, R: Resolver> {
    target: &'a Target,
    resolver: &'a R,
    should_resolve: bool,
    warn: &'a (dyn Fn(String) + Send + Sync),
    cache: tokio::sync::OnceCell<(Vec<IpAddr>, Option<DnsSource>)>,
}

impl<'a, R: Resolver> LazyIps<'a, R> {
    fn new(
        target: &'a Target, resolver: &'a R, should_resolve: bool, warn: &'a (dyn Fn(String) + Send + Sync),
    ) -> Self {
        Self {
            target,
            resolver,
            should_resolve,
            warn,
            cache: tokio::sync::OnceCell::new(),
        }
    }

    async fn ips(&self) -> &[IpAddr] {
        let (ips, _) = self
            .cache
            .get_or_init(|| async {
                match self.target {
                    Target::Ip(ip) => (vec![*ip], None),
                    Target::Domain(d) if self.should_resolve => match self.resolver.resolve(d).await {
                        Ok((ips, src)) => {
                            if matches!(src, DnsSource::Doh) {
                                (self.warn)("резолв через DoH, у xray может отличаться".into());
                            }
                            (ips, Some(src))
                        }
                        Err(e) => {
                            (self.warn)(format!("не удалось разрешить {d}: {e}"));
                            (Vec::new(), None)
                        }
                    },
                    Target::Domain(_) => (Vec::new(), None),
                }
            })
            .await;
        ips.as_slice()
    }

    /// Что уже резолвлено (без запуска резолва) — для `resolved_ips`/`dns_source` в ответе. `None`
    /// и для IP-цели (там нечего "резолвить", `dns_source` не заполняется), и если резолв просто ещё
    /// не понадобился ни одному правилу.
    fn resolved(&self) -> Option<(&[IpAddr], DnsSource)> {
        self.cache.get().and_then(|(ips, src)| src.map(|s| (ips.as_slice(), s)))
    }
}

/// Заполняет `resolved_ips`/`dns_source` в ответе, если резолв в этом проходе реально произошёл.
fn apply_resolution(result: &mut RouteResult, resolved: Option<(&[IpAddr], DnsSource)>) {
    if let Some((ips, src)) = resolved {
        result.resolved_ips = ips.to_vec();
        result.dns_source = Some(src);
    }
}

/// Синхронные проверки (`domain`/`ip`/`sourceIP`) могут дойти до `geodb`, то есть до блокирующего
/// чтения файла — прогоняем их через `tokio::task::block_in_place`, чтобы такое чтение не держало
/// рабочий поток tokio-рантайма замороженным (сам `geodb.rs` остаётся синхронным и без tokio-знания,
/// т.к. его сигнатуры общие с mihomo — обёртка тут, на вызывающей стороне).
async fn evaluate_rule<R: Resolver>(
    rule: &CompiledRule, ctx: &TestContext, lazy_ips: &LazyIps<'_, R>, domain_visible: bool,
    warn: &mut (dyn FnMut(String) + Send),
) -> FieldOutcome {
    let mut detail = None;
    let mut unknown: Option<String> = None;
    macro_rules! step {
        ($outcome:expr) => {
            match $outcome {
                FieldOutcome::NoMatch => return FieldOutcome::NoMatch,
                FieldOutcome::Unknown(r) => {
                    unknown.get_or_insert(r);
                }
                FieldOutcome::Match(d) => {
                    if detail.is_none() {
                        detail = d;
                    }
                }
            }
        };
    }
    if let Some(items) = &rule.domain {
        // `GetTargetDomain()` вернула бы "" — sniffing не сработал (см. `Engine::sniff_view`
        // и блок-комментарий модуля), домен-условие детерминированно не совпадает.
        if !domain_visible {
            return FieldOutcome::NoMatch;
        }
        step!(tokio::task::block_in_place(|| eval_domain(items, &ctx.target, warn)));
    }
    if let Some(items) = &rule.ip {
        let ips = lazy_ips.ips().await;
        step!(tokio::task::block_in_place(|| eval_ip(items, ips, warn)));
    }
    if let Some(p) = &rule.port {
        step!(eval_port(p, ctx.port));
    }
    if let Some(nets) = &rule.network {
        step!(eval_network(nets, ctx.network));
    }
    if let Some(items) = &rule.source_ip {
        step!(tokio::task::block_in_place(|| eval_source_ip(
            items,
            &ctx.source_ip,
            warn
        )));
    }
    if let Some(tags) = &rule.inbound_tag {
        step!(eval_inbound_tag(tags, &ctx.inbound_tag));
    }
    for reason in &rule.unsupported {
        step!(FieldOutcome::Unknown(reason.clone()));
    }
    match unknown {
        Some(r) => FieldOutcome::Unknown(r),
        None => FieldOutcome::Match(detail),
    }
}

// ---------------------------------------------------------------------------------------------
// Engine.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DomainStrategy {
    AsIs,
    IpIfNonMatch,
    IpOnDemand,
}

impl DomainStrategy {
    /// `infra/conf/router.go::getDomainStrategy`.
    fn parse(s: Option<&str>) -> Self {
        match s.unwrap_or("").to_lowercase().as_str() {
            "ipifnonmatch" => DomainStrategy::IpIfNonMatch,
            "ipondemand" => DomainStrategy::IpOnDemand,
            _ => DomainStrategy::AsIs,
        }
    }
}

/// Загруженная и разобранная конфигурация xray (routing/outbounds/inbounds после мержа файлов).
pub struct Engine {
    outbounds_first: Option<String>,
    inbound_tags_list: Vec<String>,
    domain_strategy: DomainStrategy,
    /// Тег балансировщика → теги outbound'ов, реально подпадающие под его `selector` (селекторы —
    /// ПРЕФИКСЫ тегов outbound'ов, не сами теги целиком: `app/proxyman/outbound/outbound.go`,
    /// `Manager.Select` — `strings.HasPrefix(tag, selector)` по всем зарегистрированным хендлерам,
    /// результат `sort.Strings`'ится — то есть итог детерминирован по алфавиту тегов, а не по
    /// порядку `outbounds` в конфиге и не по порядку селекторов). Считается один раз при загрузке
    /// конфига (теги outbound'ов и селекторы уже все известны), не на каждый `evaluate()`.
    balancer_members: std::collections::HashMap<String, Vec<String>>,
    rules: Vec<CompiledRule>,
    /// Тег inbound'а → то, что нужно знать о его `sniffing` для эмуляции `routeOnly` (см.
    /// блок-комментарий модуля). Только для тегов, реально присутствующих в мерже.
    inbound_info: std::collections::HashMap<String, InboundInfo>,
    load_warnings: Vec<String>,
    runtime_warnings: Mutex<Vec<String>>,
}

impl Engine {
    /// Собирает конфиг из JSONC-строк (имя файла, содержимое) — используется и тестами, и `load()`.
    /// Файлы должны быть предварительно отсортированы по имени вызывающим кодом.
    pub(crate) fn from_configs(files: Vec<(String, String)>, asset_dir: &Path) -> Engine {
        let mut merged: Option<RawConfig> = None;
        let mut warnings = Vec::new();
        for (name, content) in &files {
            let stripped = strip_jsonc(content);
            match serde_json::from_str::<RawConfig>(&stripped) {
                Ok(cfg) => match &mut merged {
                    None => merged = Some(cfg),
                    Some(base) => override_config(base, cfg, name),
                },
                Err(e) => warnings.push(format!("{name}: некорректный JSON ({e})")),
            }
        }
        let merged = merged.unwrap_or_default();
        if merged.routing.is_none() {
            warnings.push("routing отсутствует ни в одном конфиге".to_string());
        }

        let outbounds_first = merged.outbounds.first().map(|o| o.tag.clone());

        let mut outbound_tags = Vec::new();
        let mut seen_ob = HashSet::new();
        for ob in &merged.outbounds {
            if !ob.tag.is_empty() && seen_ob.insert(ob.tag.clone()) {
                outbound_tags.push(ob.tag.clone());
            }
        }

        let mut inbound_tags_list = Vec::new();
        let mut seen = HashSet::new();
        for ib in &merged.inbounds {
            if !ib.tag.is_empty() && seen.insert(ib.tag.clone()) {
                inbound_tags_list.push(ib.tag.clone());
            }
        }

        // `override_config` уже мержит `inbounds` по тегу (один тег — одна запись после всех
        // файлов), поэтому здесь достаточно один раз собрать `sniffing` для каждого тега.
        let mut inbound_info = std::collections::HashMap::new();
        for ib in &merged.inbounds {
            if ib.tag.is_empty() {
                continue;
            }
            let is_transparent = TRANSPARENT_PROTOCOLS.contains(&ib.protocol.to_lowercase().as_str());
            let sniff = ib.sniffing.clone().unwrap_or_default();
            let domains_excluded = match sniff
                .domains_excluded
                .0
                .iter()
                .map(|s| parse_domain_item(s, asset_dir))
                .collect::<Result<Vec<_>, _>>()
            {
                Ok(items) => items,
                Err(e) => {
                    warnings.push(format!("inbound {}: sniffing.domainsExcluded: {e}", ib.tag));
                    Vec::new()
                }
            };
            inbound_info.insert(
                ib.tag.clone(),
                InboundInfo {
                    is_transparent,
                    sniffing_enabled: sniff.enabled,
                    metadata_only: sniff.metadata_only,
                    dest_override_present: !sniff.dest_override.0.is_empty(),
                    route_only: sniff.route_only,
                    domains_excluded,
                },
            );
        }

        let routing = merged.routing.unwrap_or_default();
        let domain_strategy = DomainStrategy::parse(routing.domain_strategy.as_deref());

        // `Manager.Select` (см. комментарий на поле `Engine::balancer_members`): каждый селектор —
        // префикс, матчащий 0+ тегов outbound'ов; итог по балансировщику — объединение по всем его
        // селекторам, без дублей, отсортированное (`BTreeSet` даёт то же упорядочивание, что и
        // `sort.Strings` в оригинале — побайтовое сравнение строк).
        let mut balancer_members: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for b in &routing.balancers {
            let mut members: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for sel in &b.selector.0 {
                let hits: Vec<&String> = outbound_tags.iter().filter(|t| t.starts_with(sel.as_str())).collect();
                if hits.is_empty() {
                    warnings.push(format!(
                        "балансировщик {}: селектор {sel} не совпал ни с одним outbound",
                        b.tag
                    ));
                } else {
                    members.extend(hits.into_iter().cloned());
                }
            }
            if members.is_empty() && !b.fallback_tag.is_empty() {
                // `Balancer.PickOutbound` (app/router/balancing.go): при пустом множестве кандидатов
                // стратегия возвращает "", и xray уходит на `fallbackTag` — сам xray-core тег не
                // добавляет в список кандидатов (мы это не эмулируем, только предупреждаем).
                warnings.push(format!(
                    "балансировщик {}: ни один селектор не совпал ни с одним outbound, xray использует fallbackTag {}",
                    b.tag, b.fallback_tag
                ));
            }
            balancer_members.insert(b.tag.clone(), members.into_iter().collect());
        }

        let mut rules = Vec::new();
        for (i, raw) in routing.rules.iter().enumerate() {
            match compile_rule(i, raw, asset_dir) {
                Ok(Some(r)) => rules.push(r),
                Ok(None) => warnings.push(format!(
                    "правило #{i}: нет условий, xray отклонил бы конфиг — пропущено"
                )),
                Err(e) => warnings.push(format!("правило #{i}: {e}")),
            }
        }

        Engine {
            outbounds_first,
            inbound_tags_list,
            domain_strategy,
            balancer_members,
            rules,
            inbound_info,
            load_warnings: warnings,
            runtime_warnings: Mutex::new(Vec::new()),
        }
    }

    fn push_runtime_warning(&self, msg: String) {
        let mut w = self.runtime_warnings.lock().unwrap();
        if !w.contains(&msg) {
            w.push(msg);
        }
    }

    async fn find_match<R: Resolver>(
        &self, ctx: &TestContext, lazy_ips: &LazyIps<'_, R>, domain_visible: bool, skipped: &mut Vec<SkippedRule>,
    ) -> Option<(&CompiledRule, Option<String>)> {
        for rule in &self.rules {
            let warn = |msg: String| self.push_runtime_warning(msg);
            let mut warn_boxed = warn;
            match evaluate_rule(rule, ctx, lazy_ips, domain_visible, &mut warn_boxed).await {
                FieldOutcome::Match(detail) => return Some((rule, detail)),
                FieldOutcome::Unknown(reason) => {
                    skipped.push(SkippedRule {
                        index: rule.original_index,
                        text: rule.summary.clone(),
                        reason,
                    });
                }
                FieldOutcome::NoMatch => {}
            }
        }
        None
    }

    /// `(domain_visible, force_ip_known)` для выбранного по `ctx.inbound_tag` inbound'а — см.
    /// блок-комментарий модуля. Вне "прозрачной" тройки протоколов, без выбранного inbound'а, или
    /// если цель — не домен, возвращает `(true, false)`: текущее (без sniffing) поведение,
    /// `domainStrategy` работает как раньше.
    fn sniff_view(&self, ctx: &TestContext) -> (bool, bool) {
        const UNCHANGED: (bool, bool) = (true, false);
        if !matches!(ctx.target, Target::Domain(_)) {
            return UNCHANGED;
        }
        let Some(tag) = &ctx.inbound_tag else {
            return UNCHANGED;
        };
        let Some(info) = self.inbound_info.get(tag) else {
            return UNCHANGED;
        };
        if !info.is_transparent {
            return UNCHANGED;
        }
        let mut warn = |msg: String| self.push_runtime_warning(msg);
        let excluded = matches!(
            eval_domain(&info.domains_excluded, &ctx.target, &mut warn),
            FieldOutcome::Match(_)
        );
        let effective_sniff = info.sniffing_enabled && !info.metadata_only && info.dest_override_present && !excluded;
        if !effective_sniff {
            // Override не сработал: `ob.Target` остаётся IP, `RouteTarget` невалиден.
            (false, true)
        } else if info.route_only {
            // `RouteTarget` = sniffed-домен (виден), `Target` остаётся исходным IP (виден сразу).
            (true, true)
        } else {
            // sniffed-домен становится самим `ob.Target` — текущее поведение, не тронуто.
            (true, false)
        }
    }

    /// Прогоняет цель через `routing.rules` и возвращает итог сравнения.
    pub async fn evaluate<R: Resolver>(&self, ctx: &TestContext, resolver: &R) -> RouteResult {
        let mut result = RouteResult {
            target: ctx.target.to_string(),
            kind: ctx.target.kind().to_string(),
            ..Default::default()
        };

        let is_domain = matches!(ctx.target, Target::Domain(_));
        let (domain_visible, force_ip_known) = self.sniff_view(ctx);
        let warn_fn = |msg: String| self.push_runtime_warning(msg);

        // `IpOnDemand` подключает DNS-клиент к проходу целиком, но сам запрос всё равно ленивый
        // (см. `LazyIps`) — первое правило, которое реально проверяет `ip`, его и вызовет.
        // `AsIs` и первый проход `IpIfNonMatch` DNS-клиента не видят вообще — если только `sniff_view`
        // не форсирует IP видимым с самого начала (`routeOnly`/отсутствие домена после sniffing).
        let pass1_should_resolve = is_domain && (force_ip_known || self.domain_strategy == DomainStrategy::IpOnDemand);
        let lazy1 = LazyIps::new(&ctx.target, resolver, pass1_should_resolve, &warn_fn);

        let mut skipped = Vec::new();
        if let Some((rule, detail)) = self.find_match(ctx, &lazy1, domain_visible, &mut skipped).await {
            apply_resolution(&mut result, lazy1.resolved());
            return self.finish(result, rule, detail, skipped);
        }
        apply_resolution(&mut result, lazy1.resolved());

        // Второй проход `IpIfNonMatch` реален только когда домен вообще виден (`pickRouteInternal`
        // пропускает его при пустом `GetTargetDomain()`) и IP не был известен уже с первого прохода.
        if is_domain && domain_visible && !force_ip_known && self.domain_strategy == DomainStrategy::IpIfNonMatch {
            skipped.clear();
            let lazy2 = LazyIps::new(&ctx.target, resolver, true, &warn_fn);
            if let Some((rule, detail)) = self.find_match(ctx, &lazy2, domain_visible, &mut skipped).await {
                apply_resolution(&mut result, lazy2.resolved());
                return self.finish(result, rule, detail, skipped);
            }
            apply_resolution(&mut result, lazy2.resolved());
        }

        result.outcome = Outcome::Default;
        result.outbound = self.outbounds_first.clone();
        result.skipped = skipped;
        result
    }

    fn finish(
        &self, mut result: RouteResult, rule: &CompiledRule, detail: Option<String>, skipped: Vec<SkippedRule>,
    ) -> RouteResult {
        result.outcome = Outcome::Matched;
        match &rule.target {
            RuleTarget::Outbound(tag) => {
                result.outbound = Some(tag.clone());
            }
            RuleTarget::Balancer(tag) => {
                let selector = self.balancer_members.get(tag).cloned().unwrap_or_default();
                result.balancer = Some(BalancerInfo {
                    tag: tag.clone(),
                    selector,
                });
                result.outbound = Some(tag.clone());
            }
        }
        result.rule = Some(MatchedRule {
            index: rule.original_index,
            text: rule.summary.clone(),
            detail,
        });
        result.skipped = skipped;
        result
    }

    /// Предупреждения, накопленные при загрузке/вычислении.
    pub fn warnings(&self) -> Vec<String> {
        let mut out = self.load_warnings.clone();
        out.extend(self.runtime_warnings.lock().unwrap().iter().cloned());
        out
    }
}

/// Форматы, которые `main/run.go::getRegepxByFormat` (Xray-core) тоже принимает для `-confdir` —
/// мы их не разбираем (только JSON(C)), но должны хотя бы предупредить, а не тихо проигнорировать.
const RECOGNIZED_NON_JSON_EXTENSIONS: &[&str] = &["jsonc", "toml", "yaml", "yml"];

/// Имя + содержимое каждого `*.json` из каталога, плюс предупреждения о нераспознанных форматах.
type ConfigFiles = (Vec<(String, String)>, Vec<String>);

/// Асинхронно (`tokio::fs`, не `std::fs`) — вызывается из `load()`/`inbound_tags()`, которые сами
/// зовутся из axum-хендлеров; блокирующий `std::fs` держал бы рабочий поток рантайма замороженным
/// на время листинга директории и чтения каждого файла (тот же принцип, что и `block_in_place`
/// вокруг синхронных вызовов `geodb` в `evaluate_rule` — там это IO нельзя сделать async, здесь можно).
async fn collect_config_files(dir: &Path) -> Result<ConfigFiles, String> {
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("не удалось прочитать {}: {e}", dir.display()))?;
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        if entry.file_type().await.is_ok_and(|t| t.is_file()) {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|e| e.file_name());

    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ext = entry.path().extension().and_then(|e| e.to_str()).map(str::to_lowercase);
        match ext.as_deref() {
            Some("json") => match tokio::fs::read_to_string(entry.path()).await {
                Ok(content) => files.push((name, content)),
                Err(e) => warnings.push(format!("{name}: не удалось прочитать ({e})")),
            },
            Some(ext) if RECOGNIZED_NON_JSON_EXTENSIONS.contains(&ext) => {
                warnings.push(format!(
                    "{name}: формат .{ext} тестером маршрутов не разбирается (только .json), файл пропущен"
                ));
            }
            _ => {}
        }
    }
    Ok((files, warnings))
}

/// Читает и объединяет все `*.json` из `XRAY_CONF_DIR`.
pub async fn load() -> Result<Engine, String> {
    let (files, io_warnings) = collect_config_files(Path::new(XRAY_CONF_DIR)).await?;
    let mut engine = Engine::from_configs(files, Path::new(XRAY_ASSET_DIR));
    if !io_warnings.is_empty() {
        let mut w = io_warnings;
        w.extend(std::mem::take(&mut engine.load_warnings));
        engine.load_warnings = w;
    }
    Ok(engine)
}

/// Список тегов inbound'ов для выпадающего списка на фронте.
pub async fn inbound_tags() -> Result<Vec<String>, String> {
    let (files, _) = collect_config_files(Path::new(XRAY_CONF_DIR)).await?;
    let engine = Engine::from_configs(files, Path::new(XRAY_ASSET_DIR));
    Ok(engine.inbound_tags_list)
}

/// Компайл-тайм проверка: `Engine::evaluate` должен возвращать `Send`-future (axum-хендлер
/// `post_route_test` в `mod.rs` гоняет его на пуле воркеров tokio) — `mod.rs::_assert_route_test_bounds`
/// проверяет `Send + Sync` только у самих типов `Engine`/`LiveResolver`, а не у future, которую
/// возвращает конкретный вызов `evaluate`; ловит регрессии вроде `&mut dyn FnMut(String)` без `+ Send`
/// (без него `tokio::sync::OnceCell::get_or_init` внутри `LazyIps` делает future не-Send, и весь
/// `cargo build` падает только на уровне `main.rs`, что менее понятно, чем сообщение отсюда).
#[allow(dead_code)]
fn _assert_evaluate_future_is_send<'a, R: Resolver + Sync>(e: &'a Engine, ctx: &'a TestContext, r: &'a R) {
    fn assert_send<T: Send>(_: T) {}
    assert_send(e.evaluate(ctx, r));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route_test::dns::StaticResolver;
    use std::collections::HashMap as StdHashMap;

    fn engine(files: &[(&str, &str)], asset_dir: &Path) -> Engine {
        Engine::from_configs(
            files.iter().map(|(n, c)| (n.to_string(), c.to_string())).collect(),
            asset_dir,
        )
    }

    fn ctx(target: Target) -> TestContext {
        TestContext {
            target,
            port: 443,
            network: ReqNetwork::Tcp,
            source_ip: None,
            inbound_tag: None,
        }
    }

    fn ctx_inbound(target: Target, tag: &str) -> TestContext {
        TestContext {
            inbound_tag: Some(tag.to_string()),
            ..ctx(target)
        }
    }

    fn no_resolver() -> StaticResolver {
        StaticResolver(StdHashMap::new())
    }

    /// Резолвер, считающий обращения — нужен, чтобы убедиться, что DNS не резолвится, когда до
    /// `ip`-условия дело вообще не дошло (см. `features/routing/dns/context.go`: `GetTargetIPs`
    /// резолвит лениво, при первом реальном обращении, а не сразу для всего прохода).
    struct CountingResolver {
        inner: StaticResolver,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl CountingResolver {
        fn new(map: StdHashMap<String, Vec<IpAddr>>) -> Self {
            Self {
                inner: StaticResolver(map),
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn call_count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Resolver for CountingResolver {
        async fn resolve(&self, domain: &str) -> Result<(Vec<IpAddr>, DnsSource), String> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.resolve(domain).await
        }
    }

    // --- JSONC ---

    #[test]
    fn jsonc_strips_line_and_block_comments() {
        let src = "{\n  // comment\n  \"a\": 1, /* block\n comment */ \"b\": 2\n}";
        let stripped = strip_jsonc(src);
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], 2);
    }

    #[test]
    fn jsonc_keeps_comment_markers_inside_strings() {
        let src = r#"{"url": "http://x.com", "note": "a /* not a comment */ b"}"#;
        let stripped = strip_jsonc(src);
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(v["url"], "http://x.com");
        assert_eq!(v["note"], "a /* not a comment */ b");
    }

    #[test]
    fn jsonc_handles_escaped_quotes() {
        let src = r#"{"a": "say \"hi\" // not a comment"}"#;
        let stripped = strip_jsonc(src);
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(v["a"], "say \"hi\" // not a comment");
    }

    #[test]
    fn jsonc_strips_trailing_commas() {
        let src = r#"{"a": [1, 2, 3,], "b": 1,}"#;
        let stripped = strip_jsonc(src);
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(v["a"], serde_json::json!([1, 2, 3]));
        assert_eq!(v["b"], 1);
    }

    // --- домены/prefixы ---

    #[test]
    fn domain_prefixes_match_as_in_xray_core() {
        let asset_dir = std::env::temp_dir();
        assert!(matches!(
            eval_domain(
                &[parse_domain_item("regexp:^a[0-9]+$", &asset_dir).unwrap()],
                &Target::Domain("a42".into()),
                &mut |_| {}
            ),
            FieldOutcome::Match(_)
        ));
        assert!(matches!(
            eval_domain(
                &[parse_domain_item("domain:example.com", &asset_dir).unwrap()],
                &Target::Domain("sub.example.com".into()),
                &mut |_| {}
            ),
            FieldOutcome::Match(_)
        ));
        assert!(matches!(
            eval_domain(
                &[parse_domain_item("full:example.com", &asset_dir).unwrap()],
                &Target::Domain("sub.example.com".into()),
                &mut |_| {}
            ),
            FieldOutcome::NoMatch
        ));
        assert!(matches!(
            eval_domain(
                &[parse_domain_item("keyword:tube", &asset_dir).unwrap()],
                &Target::Domain("youtube.com".into()),
                &mut |_| {}
            ),
            FieldOutcome::Match(_)
        ));
        assert!(matches!(
            eval_domain(
                &[parse_domain_item("plainsubstr", &asset_dir).unwrap()],
                &Target::Domain("has-plainsubstr-in-it".into()),
                &mut |_| {}
            ),
            FieldOutcome::Match(_)
        ));
    }

    fn write_geosite(path: &Path, code: &str, domains: &[(i32, &str)]) {
        // маленький protobuf-энкодер только для тестов
        fn varint(mut v: u64, out: &mut Vec<u8>) {
            loop {
                let b = (v & 0x7f) as u8;
                v >>= 7;
                if v == 0 {
                    out.push(b);
                    break;
                }
                out.push(b | 0x80);
            }
        }
        fn tag(field: u32, wire: u8, out: &mut Vec<u8>) {
            varint(((field as u64) << 3) | wire as u64, out);
        }
        fn len_delim(field: u32, payload: &[u8], out: &mut Vec<u8>) {
            tag(field, 2, out);
            varint(payload.len() as u64, out);
            out.extend_from_slice(payload);
        }
        let mut entry = Vec::new();
        len_delim(1, code.as_bytes(), &mut entry);
        for (kind, value) in domains {
            let mut d = Vec::new();
            tag(1, 0, &mut d);
            varint(*kind as u64, &mut d);
            len_delim(2, value.as_bytes(), &mut d);
            len_delim(2, &d, &mut entry);
        }
        let mut list = Vec::new();
        len_delim(1, &entry, &mut list);
        std::fs::write(path, list).unwrap();
    }

    #[test]
    fn geosite_tag_and_ext_syntax_use_geodb() {
        let dir = std::env::temp_dir().join(format!("xkeen-xray-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_geosite(&dir.join("geosite.dat"), "GOOGLE", &[(2, "google.com")]);
        write_geosite(&dir.join("custom.dat"), "ADS", &[(0, "ads")]);

        let item = parse_domain_item("geosite:google", &dir).unwrap();
        assert!(matches!(
            eval_domain(&[item], &Target::Domain("sub.google.com".into()), &mut |_| {}),
            FieldOutcome::Match(_)
        ));

        let item = parse_domain_item("ext:custom.dat:ads", &dir).unwrap();
        assert!(matches!(
            eval_domain(&[item], &Target::Domain("has-ads-here".into()), &mut |_| {}),
            FieldOutcome::Match(_)
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Одна страна фикстуры: код + список (4-байтовый IPv4-префикс, длина префикса).
    type GeoIpEntry<'a> = (&'a str, &'a [([u8; 4], u32)]);

    /// `.dat`-геоip-фикстура с несколькими странами.
    fn write_geoip(path: &Path, entries: &[GeoIpEntry]) {
        fn varint(mut v: u64, out: &mut Vec<u8>) {
            loop {
                let b = (v & 0x7f) as u8;
                v >>= 7;
                if v == 0 {
                    out.push(b);
                    break;
                }
                out.push(b | 0x80);
            }
        }
        fn tag(field: u32, wire: u8, out: &mut Vec<u8>) {
            varint(((field as u64) << 3) | wire as u64, out);
        }
        fn len_delim(field: u32, payload: &[u8], out: &mut Vec<u8>) {
            tag(field, 2, out);
            varint(payload.len() as u64, out);
            out.extend_from_slice(payload);
        }
        let mut list = Vec::new();
        for (code, cidrs) in entries {
            let mut entry = Vec::new();
            len_delim(1, code.as_bytes(), &mut entry);
            for (ip, prefix) in *cidrs {
                let mut cidr = Vec::new();
                len_delim(1, ip, &mut cidr);
                tag(2, 0, &mut cidr);
                varint(*prefix as u64, &mut cidr);
                len_delim(2, &cidr, &mut entry);
            }
            len_delim(1, &entry, &mut list);
        }
        std::fs::write(path, list).unwrap();
    }

    #[test]
    fn geoip_reverse_prefix_toggles_result() {
        let dir = std::env::temp_dir().join(format!("xkeen-xray-geoip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_geoip(&dir.join("geoip.dat"), &[("CN", &[([1, 2, 3, 0], 24)])]);

        let item = parse_ip_item("geoip:cn", &dir).unwrap();
        assert!(matches!(
            eval_ip(&[item], &["1.2.3.4".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));

        let item = parse_ip_item("geoip:!cn", &dir).unwrap();
        assert!(matches!(
            eval_ip(&[item], &["1.2.3.4".parse().unwrap()], &mut |_| {}),
            FieldOutcome::NoMatch
        ));
        let item = parse_ip_item("geoip:!cn", &dir).unwrap();
        assert!(matches!(
            eval_ip(&[item], &["8.8.8.8".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `common/geodata/ip_matcher.go::buildOptimizedIPMatcher` (Xray-core): все `!`-элементы одного
    /// списка `ip` объединяются в ОДИН набор, и отрицание применяется к объединению целиком, а не
    /// к каждому элементу по отдельности. Наивный "OR по итогам каждого элемента" (был баг) даёт
    /// почти всегда `Match`, потому что IP не может одновременно лежать в CN и RU — по одному
    /// элементу отрицание почти всегда true.
    #[test]
    fn eval_ip_negative_geoip_items_are_unioned_before_negating() {
        let dir = std::env::temp_dir().join(format!("xkeen-xray-geoip-union-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_geoip(
            &dir.join("geoip.dat"),
            &[("CN", &[([1, 0, 0, 0], 8)]), ("RU", &[([2, 0, 0, 0], 8)])],
        );

        let items = vec![
            parse_ip_item("geoip:!cn", &dir).unwrap(),
            parse_ip_item("geoip:!ru", &dir).unwrap(),
        ];

        assert!(
            matches!(
                eval_ip(&items, &["1.1.1.1".parse().unwrap()], &mut |_| {}),
                FieldOutcome::NoMatch
            ),
            "IP из CN лежит в union(CN,RU) — [!cn,!ru] не должен матчить"
        );
        assert!(
            matches!(
                eval_ip(&items, &["2.2.2.2".parse().unwrap()], &mut |_| {}),
                FieldOutcome::NoMatch
            ),
            "IP из RU лежит в union(CN,RU) — [!cn,!ru] не должен матчить"
        );
        assert!(matches!(
            eval_ip(&items, &["8.8.8.8".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eval_ip_mixed_negative_geoip_and_positive_cidr_are_separate_buckets() {
        let dir = std::env::temp_dir().join(format!("xkeen-xray-geoip-mixed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_geoip(&dir.join("geoip.dat"), &[("CN", &[([1, 0, 0, 0], 8)])]);

        let items = vec![
            parse_ip_item("geoip:!cn", &dir).unwrap(),
            parse_ip_item("5.5.5.0/24", &dir).unwrap(),
        ];

        // Позитивный CIDR — отдельный бакет, матчит независимо от geoip-бакета.
        assert!(matches!(
            eval_ip(&items, &["5.5.5.5".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));
        // CN и не в 5.5.5.0/24: negGeoip-бакет false (IP в union{CN}), posCustom-бакет тоже false.
        assert!(matches!(
            eval_ip(&items, &["1.2.3.4".parse().unwrap()], &mut |_| {}),
            FieldOutcome::NoMatch
        ));
        // Не CN, не в cidr — матчит через negGeoip-бакет (!cn).
        assert!(matches!(
            eval_ip(&items, &["9.9.9.9".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn eval_ip_negative_plain_cidrs_are_unioned_before_negating() {
        let asset_dir = std::env::temp_dir();
        let items = vec![
            parse_ip_item("!10.0.0.0/8", &asset_dir).unwrap(),
            parse_ip_item("!192.168.0.0/16", &asset_dir).unwrap(),
        ];

        assert!(matches!(
            eval_ip(&items, &["10.1.2.3".parse().unwrap()], &mut |_| {}),
            FieldOutcome::NoMatch
        ));
        assert!(matches!(
            eval_ip(&items, &["192.168.1.1".parse().unwrap()], &mut |_| {}),
            FieldOutcome::NoMatch
        ));
        assert!(matches!(
            eval_ip(&items, &["8.8.8.8".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));
    }

    #[test]
    fn bare_ip_without_bits_defaults_to_full_length_prefix() {
        // xray: `"ip": ["1.2.3.4"]` — голый IP без `/bits` разрешён, в отличие от mihomo (см.
        // `route_test::cidr::Cidr::parse_or_host`).
        let asset_dir = std::env::temp_dir();
        let item = parse_ip_item("1.2.3.4", &asset_dir).unwrap();
        assert!(matches!(
            eval_ip(std::slice::from_ref(&item), &["1.2.3.4".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));
        assert!(matches!(
            eval_ip(&[item], &["1.2.3.5".parse().unwrap()], &mut |_| {}),
            FieldOutcome::NoMatch
        ));
    }

    #[test]
    fn cidr_v4_and_v6_and_port_lists_and_network() {
        let asset_dir = std::env::temp_dir();
        let item = parse_ip_item("10.0.0.0/8", &asset_dir).unwrap();
        assert!(matches!(
            eval_ip(&[item], &["10.1.2.3".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));
        let item = parse_ip_item("2001:db8::/32", &asset_dir).unwrap();
        assert!(matches!(
            eval_ip(&[item], &["2001:db8::1".parse().unwrap()], &mut |_| {}),
            FieldOutcome::Match(_)
        ));

        let ports = PortSpec::parse_str("80,443,1000-2000").unwrap();
        assert!(ports.contains(443));
        assert!(ports.contains(1500));
        assert!(!ports.contains(2001));

        assert!(matches!(
            eval_network(&["tcp".into()], ReqNetwork::Tcp),
            FieldOutcome::Match(_)
        ));
        assert!(matches!(
            eval_network(&["tcp".into()], ReqNetwork::Udp),
            FieldOutcome::NoMatch
        ));
    }

    #[test]
    fn inbound_tag_and_source_ip_context_rules() {
        assert!(matches!(
            eval_inbound_tag(&["in1".into()], &None),
            FieldOutcome::Unknown(_)
        ));
        assert!(matches!(
            eval_inbound_tag(&["in1".into()], &Some("in1".into())),
            FieldOutcome::Match(_)
        ));
        assert!(matches!(
            eval_inbound_tag(&["in1".into()], &Some("in2".into())),
            FieldOutcome::NoMatch
        ));

        let asset_dir = std::env::temp_dir();
        let item = parse_ip_item("192.168.1.0/24", &asset_dir).unwrap();
        assert!(matches!(
            eval_source_ip(std::slice::from_ref(&item), &None, &mut |_| {}),
            FieldOutcome::Unknown(_)
        ));
        assert!(matches!(
            eval_source_ip(&[item], &Some("192.168.1.5".parse().unwrap()), &mut |_| {}),
            FieldOutcome::Match(_)
        ));
    }

    // --- движок целиком ---

    #[tokio::test(flavor = "multi_thread")]
    async fn no_match_falls_back_to_default_outbound() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}, {"tag": "proxy"}],
            "routing": {"rules": [{"domain": ["example.com"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("other.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Default);
        assert_eq!(r.outbound.as_deref(), Some("direct"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn matched_rule_reports_index_and_detail() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}, {"tag": "proxy"}],
            "routing": {"rules": [
                {"port": "80", "outboundTag": "direct"},
                {"domain": ["keyword:tube"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("youtube.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
        assert_eq!(r.rule.as_ref().unwrap().index, 1);
        assert_eq!(r.rule.as_ref().unwrap().detail.as_deref(), Some("keyword:tube"));
    }

    /// UI рендерит `#index rule.text — rule.detail`, а цель (outbound/balancer) — отдельным
    /// бейджем: `text` не должен дублировать её через `→`, поля идут через `; `, списки — `, `.
    #[tokio::test(flavor = "multi_thread")]
    async fn rule_text_has_no_target_arrow_and_uses_semicolons() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}, {"tag": "proxy"}],
            "routing": {"rules": [
                {"domain": ["geosite:blocked", "github"], "port": "443", "network": ["tcp"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("github.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(
            r.rule.as_ref().unwrap().text,
            "domain: geosite:blocked, github; port: 443; network: tcp"
        );
    }

    /// Балансировщик — тоже цель: текст правила не должен упоминать `→ балансировщик …`.
    #[tokio::test(flavor = "multi_thread")]
    async fn rule_text_has_no_balancer_arrow() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "proxy"}],
            "routing": {
                "balancers": [{"tag": "bal1", "selector": ["proxy"]}],
                "rules": [{"domain": ["example.com"], "balancerTag": "bal1"}]
            }
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("example.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.rule.as_ref().unwrap().text, "domain: example.com");
    }

    /// `ruleTag` — префикс `ruleTag: <tag>; ` без скобок (было `[<tag>] `).
    #[tokio::test(flavor = "multi_thread")]
    async fn rule_text_rule_tag_prefix_has_no_brackets() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "proxy"}],
            "routing": {"rules": [
                {"ruleTag": "Blocked", "domain": ["geosite:blocked", "github"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("github.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(
            r.rule.as_ref().unwrap().text,
            "ruleTag: Blocked; domain: geosite:blocked, github"
        );
    }

    /// Длинные списки условий обрезаются до первых `SUMMARY_LIST_LIMIT` (5) элементов + `… (+N)`,
    /// иначе строка в UI становится нечитаемой при большом geosite/geoip списке.
    #[tokio::test(flavor = "multi_thread")]
    async fn rule_text_truncates_long_domain_lists() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "proxy"}],
            "routing": {"rules": [
                {"domain": ["a1", "a2", "a3", "a4", "a5", "a6", "a7"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("a1.example.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.rule.as_ref().unwrap().text, "domain: a1, a2, a3, a4, a5, … (+2)");
    }

    /// `skipped[].text` строится тем же `build_summary`, что и совпавшее правило — тот же формат,
    /// без цели, без скобок вокруг `ruleTag`.
    #[tokio::test(flavor = "multi_thread")]
    async fn skipped_rule_text_matches_same_format() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"rules": [
                {"ruleTag": "Skip", "domain": ["example.com"], "user": ["a@b.com"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("example.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Default);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].text, "ruleTag: Skip; domain: example.com; user");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unsupported_field_present_goes_to_skipped_not_matched() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"rules": [{"domain": ["example.com"], "user": ["a@b.com"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("example.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Default);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].index, 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn missing_geosite_file_surfaces_as_skipped_and_warning() {
        let asset_dir = std::env::temp_dir().join(format!("xkeen-xray-missing-geo-{}", std::process::id()));
        std::fs::create_dir_all(&asset_dir).unwrap(); // директория есть, geosite.dat внутри — нет
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"rules": [{"domain": ["geosite:google"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("youtube.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Default);
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].index, 0);
        assert!(
            e.warnings()
                .iter()
                .any(|w| w.contains("geosite.dat") || w.contains("google")),
            "должно быть предупреждение о недоступном geosite.dat: {:?}",
            e.warnings()
        );

        let _ = std::fs::remove_dir_all(&asset_dir);
    }

    /// Некорректный синтаксис правила (`ext:` без файла/тега, `geosite:@attr` без кода) — ошибка
    /// компиляции конкретного правила, а не всего конфига: попадает в `warnings()`, само правило
    /// исключается из списка, остальные правила продолжают работать как ни в чём не бывало.
    #[tokio::test(flavor = "multi_thread")]
    async fn invalid_rule_syntax_is_a_load_warning_other_rules_still_work() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}, {"tag": "proxy"}],
            "routing": {"rules": [
                {"ip": ["ext:"], "outboundTag": "broken"},
                {"domain": ["geosite:@attr"], "outboundTag": "broken2"},
                {"domain": ["example.com"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        assert_eq!(e.rules.len(), 1, "оба некорректных правила должны быть исключены");
        let warnings = e.warnings();
        assert!(warnings.iter().any(|w| w.contains("#0")), "{warnings:?}");
        assert!(warnings.iter().any(|w| w.contains("#1")), "{warnings:?}");

        let r = e
            .evaluate(&ctx(Target::Domain("example.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn domain_strategy_asis_never_resolves_ip_rules() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "AsIs", "rules": [{"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx(Target::Domain("example.com".into())),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(r.outcome, Outcome::Default);
        assert!(r.resolved_ips.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn domain_strategy_ip_on_demand_resolves_lazily_when_ip_condition_reached() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "IPOnDemand", "rules": [{"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx(Target::Domain("example.com".into())),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
        assert_eq!(r.resolved_ips, vec!["1.2.3.4".parse::<IpAddr>().unwrap()]);
    }

    /// `features/routing/dns/context.go` (Xray-core): `GetTargetIPs()` резолвит домен лениво, при
    /// первом реальном обращении к IP правила — если раньше в списке правил уже нашлось совпадение
    /// без `ip`-условия, DNS вообще не должен вызываться, даже под `IPOnDemand`.
    #[tokio::test(flavor = "multi_thread")]
    async fn ip_condition_is_not_resolved_when_earlier_rule_matches_first() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "IPOnDemand", "rules": [
                {"domain": ["example.com"], "outboundTag": "proxy"},
                {"ip": ["1.2.3.4/32"], "outboundTag": "other"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let resolver = CountingResolver::new(StdHashMap::from([(
            "example.com".to_string(),
            vec!["1.2.3.4".parse().unwrap()],
        )]));
        let r = e.evaluate(&ctx(Target::Domain("example.com".into())), &resolver).await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
        assert!(
            r.resolved_ips.is_empty(),
            "домен matched раньше правила с ip — резолва IP быть не должно"
        );
        assert_eq!(resolver.call_count(), 0, "резолвер не должен был вызываться");
    }

    /// Резолв должен кэшироваться на весь проход: если сразу несколько правил проверяют `ip`,
    /// DNS дёргается только один раз, а не при каждом обращении к `LazyIps::ips()`.
    #[tokio::test(flavor = "multi_thread")]
    async fn ip_resolution_is_cached_within_a_pass_not_repeated_per_rule() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "IPOnDemand", "rules": [
                {"ip": ["9.9.9.9/32"], "outboundTag": "wrong"},
                {"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let resolver = CountingResolver::new(StdHashMap::from([(
            "example.com".to_string(),
            vec!["1.2.3.4".parse().unwrap()],
        )]));
        let r = e.evaluate(&ctx(Target::Domain("example.com".into())), &resolver).await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
        assert_eq!(resolver.call_count(), 1, "резолв должен закэшироваться на весь проход");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn domain_strategy_ip_if_non_match_does_second_pass_only_when_needed() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "IPIfNonMatch", "rules": [
                {"domain": ["nomatch.example"], "outboundTag": "wrong"},
                {"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx(Target::Domain("example.com".into())),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
        assert!(!r.resolved_ips.is_empty());

        // А если правило совпадает уже на первом проходе — второй резолв не нужен.
        let cfg2 = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "IPIfNonMatch", "rules": [{"domain": ["example.com"], "outboundTag": "proxy"}]}
        }"#;
        let e2 = engine(&[("00.json", cfg2)], &asset_dir);
        let r2 = e2
            .evaluate(&ctx(Target::Domain("example.com".into())), &no_resolver())
            .await;
        assert_eq!(r2.outcome, Outcome::Matched);
        assert!(r2.resolved_ips.is_empty());
    }

    // --- sniffing/routeOnly выбранного inbound'а ---

    /// `routeOnly: true` на "прозрачном" inbound'е (см. `TRANSPARENT_PROTOCOLS`): IP виден сразу
    /// (пул совпал бы с `ob.Target`), независимо от `domainStrategy: AsIs`, который в обычном режиме
    /// вообще запрещает резолв.
    #[tokio::test(flavor = "multi_thread")]
    async fn route_only_true_matches_ip_rule_under_asis() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "routeOnly": true}}],
            "outbounds": [{"tag": "direct"}, {"tag": "proxy"}],
            "routing": {"domainStrategy": "AsIs", "rules": [{"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
    }

    /// `routeOnly: true` форсирует однопроходное поведение уровня `IpOnDemand` независимо от
    /// сконфигурированного `domainStrategy` ("на domainStrategy похуй") — `ip`-правило РАНЬШЕ
    /// domain-правила в списке должно совпасть уже на первом (и единственном) проходе, а не
    /// провалиться в обычный для `IpIfNonMatch` второй проход.
    #[tokio::test(flavor = "multi_thread")]
    async fn route_only_true_matches_earlier_ip_rule_on_first_pass_under_ip_if_non_match() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "routeOnly": true}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "IPIfNonMatch", "rules": [
                {"ip": ["1.2.3.4/32"], "outboundTag": "proxy"},
                {"domain": ["example.com"], "outboundTag": "wrong"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
    }

    /// `routeOnly: false` (по умолчанию) — sniffed-домен становится самим `ob.Target`, поведение
    /// не отличается от отсутствия sniffing вовсе: `domainStrategy: AsIs` по-прежнему никогда не
    /// резолвит для `ip`-условий.
    #[tokio::test(flavor = "multi_thread")]
    async fn route_only_false_leaves_domain_strategy_governing_ip_rules() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "routeOnly": false}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "AsIs", "rules": [{"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(
            r.outcome,
            Outcome::Default,
            "AsIs никогда не резолвит — ip-правило не должно совпасть"
        );
    }

    /// Выбранный "прозрачный" inbound без эффективного sniffing (тут: `enabled: false`) — override
    /// никогда не срабатывает, `ob.Target` остаётся IP: домен-условие детерминированно `NoMatch`
    /// (даже не "unknown"/skipped), а `ip`-условие видит IP сразу же — независимо от `AsIs`.
    #[tokio::test(flavor = "multi_thread")]
    async fn transparent_inbound_without_sniffing_hides_domain_reveals_ip_immediately() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door", "sniffing": {"enabled": false}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "AsIs", "rules": [
                {"domain": ["example.com"], "outboundTag": "wrong"},
                {"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}
            ]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
        assert!(
            r.skipped.is_empty(),
            "домен-условие — детерминированный NoMatch, не Unknown/skipped"
        );
    }

    /// Тот же "нет эффективного sniffing", но через `destOverride: []` (пустой список — реальный
    /// `shouldOverride` никогда не сработает на пустом переборе `OverrideDestinationForProtocol`).
    #[tokio::test(flavor = "multi_thread")]
    async fn transparent_inbound_with_empty_dest_override_hides_domain() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": [], "routeOnly": true}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"rules": [{"domain": ["example.com"], "outboundTag": "wrong"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &no_resolver(),
            )
            .await;
        assert_eq!(
            r.outcome,
            Outcome::Default,
            "пустой destOverride — sniffing не может сработать"
        );
    }

    /// `metadataOnly: true` — `app/dispatcher/sniffer.go::NewSniffer` не помечает HTTP/TLS/QUIC/
    /// BitTorrent сниферы как `metadataSniffer`, только fakedns; реальный домен из трафика не
    /// сниффится, override не срабатывает — как при `enabled: false`.
    #[tokio::test(flavor = "multi_thread")]
    async fn transparent_inbound_with_metadata_only_hides_domain() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "metadataOnly": true, "routeOnly": true}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"rules": [{"domain": ["example.com"], "outboundTag": "wrong"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &no_resolver(),
            )
            .await;
        assert_eq!(
            r.outcome,
            Outcome::Default,
            "metadataOnly — домен из трафика не сниффится"
        );
    }

    /// Цель попадает в `sniffing.domainsExcluded` — sniffing для неё не срабатывает, как при
    /// `enabled: false`, даже если в остальном sniffing включён с `routeOnly: true`.
    #[tokio::test(flavor = "multi_thread")]
    async fn domains_excluded_hit_behaves_like_no_sniffing() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "routeOnly": true,
                    "domainsExcluded": ["example.com"]}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"rules": [{"domain": ["example.com"], "outboundTag": "wrong"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &no_resolver(),
            )
            .await;
        assert_eq!(
            r.outcome,
            Outcome::Default,
            "домен исключён из sniffing — override не срабатывает"
        );
    }

    /// "Прозрачная" тройка протоколов — только `dokodemo-door`/`tunnel`/`tun`; на остальных
    /// (домен приходит из самого протокола) `routeOnly` тестером не эмулируется — поведение как без
    /// выбранного inbound'а вовсе.
    #[tokio::test(flavor = "multi_thread")]
    async fn non_transparent_inbound_keeps_domain_strategy_governed_behavior() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "vless",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "routeOnly": true}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "AsIs", "rules": [{"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Domain("example.com".into()), "in1"),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(
            r.outcome,
            Outcome::Default,
            "не прозрачный протокол — AsIs по-прежнему не резолвит"
        );
    }

    /// Без выбранного inbound'а (`inbound_tag: None`) — поведение полностью прежнее, даже если в
    /// конфиге есть "прозрачный" inbound с `routeOnly: true`.
    #[tokio::test(flavor = "multi_thread")]
    async fn no_inbound_selected_keeps_default_behavior() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "routeOnly": true}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"domainStrategy": "AsIs", "rules": [{"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let mut resolver_map = StdHashMap::new();
        resolver_map.insert("example.com".to_string(), vec!["1.2.3.4".parse().unwrap()]);
        let r = e
            .evaluate(
                &ctx(Target::Domain("example.com".into())),
                &StaticResolver(resolver_map),
            )
            .await;
        assert_eq!(
            r.outcome,
            Outcome::Default,
            "нет inbound_tag — AsIs по-прежнему не резолвит"
        );
    }

    /// `Target::Ip` — sniffing/routeOnly никогда не влияют: сниффить нечего, домен-условий это не
    /// касается, ip-условие видит literal-IP цель как обычно.
    #[tokio::test(flavor = "multi_thread")]
    async fn ip_target_is_unaffected_by_sniffing_config() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "inbounds": [{"tag": "in1", "protocol": "dokodemo-door",
                "sniffing": {"enabled": true, "destOverride": ["tls"], "routeOnly": true}}],
            "outbounds": [{"tag": "direct"}],
            "routing": {"rules": [{"ip": ["1.2.3.4/32"], "outboundTag": "proxy"}]}
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(
                &ctx_inbound(Target::Ip("1.2.3.4".parse().unwrap()), "in1"),
                &no_resolver(),
            )
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        assert_eq!(r.outbound.as_deref(), Some("proxy"));
    }

    /// `app/proxyman/outbound/outbound.go::Manager.Select`: селекторы балансировщика — ПРЕФИКСЫ
    /// тегов outbound'ов (`strings.HasPrefix`), а не сами теги; `BalancerInfo.selector` должен
    /// содержать реально подпавшие теги, а не эхо селекторов из конфига.
    #[tokio::test(flavor = "multi_thread")]
    async fn balancer_target_reports_expanded_outbound_members() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "proxy"}, {"tag": "direct"}, {"tag": "block"}, {"tag": "proxy2"}],
            "routing": {
                "balancers": [{"tag": "bal1", "selector": ["proxy", "direct"]}],
                "rules": [{"domain": ["example.com"], "balancerTag": "bal1"}]
            }
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("example.com".into())), &no_resolver())
            .await;
        assert_eq!(r.outcome, Outcome::Matched);
        let balancer = r.balancer.unwrap();
        assert_eq!(balancer.tag, "bal1");
        // "proxy" матчит и "proxy", и "proxy2" (префикс); порядок — как у реального
        // `sort.Strings` в xray-core (побайтовый алфавитный), не порядок `outbounds` в конфиге.
        assert_eq!(
            balancer.selector,
            vec!["direct".to_string(), "proxy".to_string(), "proxy2".to_string()]
        );
    }

    /// Селектор, не совпавший ни с одним outbound'ом, не должен попадать в `selector` (пустой
    /// список тегов, ничего похожего на реальный outbound), но должен дать предупреждение.
    #[tokio::test(flavor = "multi_thread")]
    async fn balancer_selector_matching_nothing_is_omitted_with_warning() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {
                "balancers": [{"tag": "bal1", "selector": ["proxy-"]}],
                "rules": [{"domain": ["example.com"], "balancerTag": "bal1"}]
            }
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        let r = e
            .evaluate(&ctx(Target::Domain("example.com".into())), &no_resolver())
            .await;
        let balancer = r.balancer.unwrap();
        assert!(balancer.selector.is_empty());
        assert!(
            e.warnings()
                .iter()
                .any(|w| w.contains("bal1") && w.contains("proxy-") && w.contains("не совпал")),
            "warnings: {:?}",
            e.warnings()
        );
    }

    /// `Balancer.PickOutbound` (app/router/balancing.go) уходит на `fallbackTag`, когда ни один
    /// селектор ничего не выбрал — предупреждение должно называть именно этот тег.
    #[tokio::test(flavor = "multi_thread")]
    async fn balancer_empty_selection_warns_about_fallback_tag() {
        let asset_dir = std::env::temp_dir();
        let cfg = r#"{
            "outbounds": [{"tag": "direct"}],
            "routing": {
                "balancers": [{"tag": "bal1", "selector": ["proxy-"], "fallbackTag": "direct"}],
                "rules": [{"domain": ["example.com"], "balancerTag": "bal1"}]
            }
        }"#;
        let e = engine(&[("00.json", cfg)], &asset_dir);
        assert!(
            e.warnings()
                .iter()
                .any(|w| w.contains("bal1") && w.contains("fallbackTag") && w.contains("direct")),
            "warnings: {:?}",
            e.warnings()
        );
    }

    #[test]
    fn multi_file_merge_routing_replaced_wholesale_by_last_file() {
        let asset_dir = std::env::temp_dir();
        let f1 = r#"{"routing": {"rules": [{"domain": ["a.com"], "outboundTag": "first"}]}}"#;
        let f2 = r#"{"routing": {"rules": [{"domain": ["b.com"], "outboundTag": "second"}]}}"#;
        let e = engine(&[("00.json", f1), ("01.json", f2)], &asset_dir);
        assert_eq!(e.rules.len(), 1);
        assert!(matches!(&e.rules[0].target, RuleTarget::Outbound(t) if t == "second"));
    }

    #[test]
    fn multi_file_merge_outbounds_prepend_by_default() {
        let asset_dir = std::env::temp_dir();
        let f1 = r#"{"outbounds": [{"tag": "a"}, {"tag": "b"}]}"#;
        let f2 = r#"{"outbounds": [{"tag": "c"}]}"#;
        let e = engine(&[("00.json", f1), ("01.json", f2)], &asset_dir);
        // "c" — новый тег, файл без "tail" в имени → вставляется в начало, дефолт меняется.
        assert_eq!(e.outbounds_first.as_deref(), Some("c"));
    }

    #[test]
    fn multi_file_merge_outbounds_tail_file_appends() {
        let asset_dir = std::env::temp_dir();
        let f1 = r#"{"outbounds": [{"tag": "a"}, {"tag": "b"}]}"#;
        let f2 = r#"{"outbounds": [{"tag": "c"}]}"#;
        let e = engine(&[("00.json", f1), ("99_tail.json", f2)], &asset_dir);
        assert_eq!(e.outbounds_first.as_deref(), Some("a"));
    }

    #[test]
    fn multi_file_merge_outbound_same_tag_updates_in_place() {
        let asset_dir = std::env::temp_dir();
        let f1 = r#"{"outbounds": [{"tag": "a"}, {"tag": "b"}]}"#;
        let f2 = r#"{"outbounds": [{"tag": "a"}]}"#;
        let e = engine(&[("00.json", f1), ("01.json", f2)], &asset_dir);
        assert_eq!(e.outbounds_first.as_deref(), Some("a"));
    }

    #[test]
    fn multi_file_merge_inbounds_merge_by_tag() {
        let asset_dir = std::env::temp_dir();
        let f1 = r#"{"inbounds": [{"tag": "in1"}]}"#;
        let f2 = r#"{"inbounds": [{"tag": "in1"}, {"tag": "in2"}]}"#;
        let e = engine(&[("00.json", f1), ("01.json", f2)], &asset_dir);
        assert_eq!(e.inbound_tags_list, vec!["in1".to_string(), "in2".to_string()]);
    }

    /// `main/run.go::getRegepxByFormat` (Xray-core) признаёт для confdir и `.jsonc`/`.toml`/`.yaml`/
    /// `.yml`, а не только `.json` — мы разбираем только JSON(C), поэтому такие файлы должны хотя бы
    /// попадать в предупреждение, а не молча игнорироваться (реальный xray их бы учёл в мерже).
    #[tokio::test]
    async fn collect_config_files_warns_about_recognized_non_json_configs_but_skips_others() {
        let dir = std::env::temp_dir().join(format!("xkeen-xray-nonjson-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("00.json"), r#"{"outbounds":[{"tag":"a"}]}"#).unwrap();
        std::fs::write(dir.join("01.yaml"), "outbounds: []").unwrap();
        std::fs::write(dir.join("readme.txt"), "не конфиг xray").unwrap();

        let (files, warnings) = collect_config_files(&dir).await.unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "00.json");
        assert!(
            warnings.iter().any(|w| w.contains("01.yaml")),
            "должно быть предупреждение про .yaml: {warnings:?}"
        );
        assert!(
            !warnings.iter().any(|w| w.contains("readme.txt")),
            ".txt — не формат конфига xray, предупреждать не о чем: {warnings:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
