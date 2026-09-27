//! Вычислитель правил mihomo: парсер строк правил (`TYPE,PAYLOAD,TARGET[,params]`, вложенные
//! `AND/OR/NOT`), трёхзначная логика Match/NoMatch/Unknown и загрузка `rule-providers` через
//! `providers.rs`. Семантика сверена с исходниками MetaCubeX/mihomo ветки Alpha:
//! `rules/parser.go`, `rules/common/*.go`, `rules/logic/logic.go`, `rules/provider/*.go`,
//! `tunnel/tunnel.go` (резолв IP, дефолтный outbound), `constant/path.go` (имена geo-файлов).

use super::cidr::Cidr;
use super::dns::{DnsSource, Resolver};
use super::providers::{self, ParsedProvider, Providers};
use super::{MatchedRule, Network, Outcome, RouteResult, SkippedRule, TestContext};
use regex_lite::{Regex, RegexBuilder};
use std::future::Future;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use yaml_rust2::Yaml;

/// Результат сравнения одного правила: сработало / не сработало / нельзя определить (нет данных —
/// IP источника, geo-файл и т.п.). Дизайн трёхзначной логики — `tasks/route-tester-spec.md`.
/// `PROCESS-*`/`UID` НЕ входят в «нельзя определить» — см. `RuleKind::NoMatch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    Match,
    NoMatch,
    Unknown(String),
}

fn bool_verdict(b: bool) -> Verdict {
    if b { Verdict::Match } else { Verdict::NoMatch }
}

pub(crate) struct PortRanges(Vec<(u16, u16)>);

impl PortRanges {
    /// Формат как у `utils.NewUnsignedRanges` в mihomo: `,`==`/`-разделитель, `N` или `N-M`,
    /// пусто/`*` — совпадает с любым портом.
    fn parse(payload: &str) -> Result<Self, String> {
        let p = payload.trim();
        if p.is_empty() || p == "*" {
            return Ok(Self(Vec::new()));
        }
        let normalized = p.replace(',', "/");
        let mut ranges = Vec::new();
        for seg in normalized.split('/') {
            if seg.is_empty() {
                continue;
            }
            if let Some((a, b)) = seg.split_once('-') {
                let start: u16 = a.trim().parse().map_err(|_| "неверный порт".to_string())?;
                let end: u16 = b.trim().parse().map_err(|_| "неверный порт".to_string())?;
                ranges.push((start.min(end), start.max(end)));
            } else {
                let v: u16 = seg.trim().parse().map_err(|_| "неверный порт".to_string())?;
                ranges.push((v, v));
            }
        }
        if ranges.is_empty() {
            return Err("пустой список портов".into());
        }
        Ok(Self(ranges))
    }

    fn check(&self, port: u16) -> bool {
        self.0.is_empty() || self.0.iter().any(|&(s, e)| port >= s && port <= e)
    }
}

/// Предикат правила без цели/адаптера (тот же узел используется и как классическая запись
/// провайдера, и как узел внутри AND/OR/NOT, и как «тело» правила верхнего уровня).
pub(crate) enum RuleKind {
    Domain(String),
    DomainSuffix(String),
    DomainKeyword(String),
    DomainRegex(Regex),
    DomainWildcard(String),
    Geosite(String),
    IpCidr {
        cidr: Cidr,
        is_src: bool,
        no_resolve: bool,
    },
    IpSuffix {
        cidr: Cidr,
        is_src: bool,
        no_resolve: bool,
    },
    IpAsn {
        asn: u32,
        is_src: bool,
        no_resolve: bool,
    },
    Geoip {
        country: String,
        is_src: bool,
        no_resolve: bool,
    },
    DstPort(PortRanges),
    Network(Network),
    RuleSet {
        name: String,
        is_src: bool,
        no_resolve: bool,
    },
    And(Vec<RuleKind>),
    Or(Vec<RuleKind>),
    Not(Box<RuleKind>),
    Match,
    /// Безусловный `NoMatch` (не `Unknown`) — для `PROCESS-NAME`/`-PATH` и `UID`: тестер симулирует
    /// соединение LAN-клиента, перехваченное tproxy/redir-инбаундом, а не открытое локальным
    /// процессом роутера, поэтому `metadata.Process`/`ProcessPath`/`Uid` в mihomo гарантированно
    /// пустые/нулевые вне зависимости от `find-process-mode` (`off` — `helper.FindProcess` вообще
    /// `nil`, `tunnel/tunnel.go`; `strict`/`always` — вызывается, но `component/process` ищет сокет
    /// по netlink INET_DIAG, ключуясь на *локальный* адрес, а у tproxy/redir-соединения локальный
    /// адрес сокета это исходный dst, а не IP LAN-клиента — владелец не находится никогда).
    /// `rules/common/process.go::Match` при этом не делает `return false` на пустой target, а
    /// сравнивает буквально: `PROCESS-NAME`/`-PATH` -> `EqualFold("", payload)` — всегда false,
    /// т.к. payload не может быть пустым (`rules/parser.go`). `rules/common/uid.go::Match` гасит
    /// сравнение до чтения диапазона: `metadata.Uid != 0` — тоже всегда false. Для
    /// `PROCESS-*-REGEX`/`-WILDCARD` результат зависит от паттерна (регэксп/wildcard, матчащий
    /// пустую строку, реально даёт `Match`) — такие узлы не используют этот вариант, а сворачиваются
    /// в `Match`/`NoMatch` уже при разборе (см. `build_rule_kind`).
    NoMatch,
    Unknown(String),
}

fn parse_params(params: &[String]) -> (bool, bool) {
    let is_src = params.iter().any(|p| p == "src");
    let no_resolve = if is_src {
        true
    } else {
        params.iter().any(|p| p == "no-resolve")
    };
    (is_src, no_resolve)
}

fn parse_asn(payload: &str) -> Option<u32> {
    let p = payload.trim();
    let digits = p.strip_prefix("AS").or_else(|| p.strip_prefix("as")).unwrap_or(p);
    digits.parse().ok()
}

/// Аналог `common.ParseRulePayload` в mihomo: `tp,payload,target(,params...)` либо
/// `tp,payload(,params...)` (если `need_target=false`). Часть типов (`NOT/OR/AND/SUB-RULE/
/// DOMAIN-REGEX/PROCESS-*-REGEX`) допускают запятые внутри payload и не имеют параметров.
fn parse_rule_payload(raw: &str, need_target: bool) -> (String, String, String, Vec<String>) {
    let items: Vec<String> = raw.split(',').map(|s| s.trim().to_string()).collect();
    let tp = items[0].to_uppercase();
    let mut payload = String::new();
    let mut target = String::new();
    let mut params: Vec<String> = Vec::new();
    if items.len() > 1 {
        match tp.as_str() {
            "MATCH" => target = items[1].clone(),
            "NOT" | "OR" | "AND" | "SUB-RULE" | "DOMAIN-REGEX" | "PROCESS-NAME-REGEX" | "PROCESS-PATH-REGEX" => {
                let mut rest = items[1..].to_vec();
                if need_target {
                    target = rest.pop().unwrap_or_default();
                }
                payload = rest.join(",");
            }
            _ => {
                payload = items[1].clone();
                if items.len() > 2 {
                    if need_target {
                        target = items[2].clone();
                        if items.len() > 3 {
                            params = items[3..].to_vec();
                        }
                    } else {
                        params = items[2..].to_vec();
                    }
                }
            }
        }
    }
    (tp, payload, target, params)
}

/// Аналог `Logic.format`/`findSubRuleRange`: прямые дочерние группы в скобках сразу внутри
/// внешней обёртывающей пары (внешняя пара — не отдельное правило, а просто группировка).
fn split_top_level_groups(payload: &str) -> Result<Vec<String>, String> {
    if !payload.starts_with('(') || !payload.ends_with(')') {
        return Err("ошибка формата логического правила: ожидались скобки".into());
    }
    let bytes = payload.as_bytes();
    let mut depth = 0i32;
    let mut start = None;
    let mut groups = Vec::new();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'(' {
            depth += 1;
            if depth == 2 {
                start = Some(i);
            }
        } else if b == b')' {
            if depth == 2
                && let Some(s) = start
            {
                groups.push(payload[s + 1..i].to_string());
            }
            if depth == 0 {
                return Err("лишняя закрывающая скобка".into());
            }
            depth -= 1;
        }
    }
    if depth != 0 {
        return Err("не хватает закрывающей скобки".into());
    }
    Ok(groups)
}

fn build_predicate_from_line(line: &str) -> RuleKind {
    let (tp, payload, _target, params) = parse_rule_payload(line, false);
    if tp == "MATCH" {
        return RuleKind::Unknown("MATCH нельзя использовать внутри логического правила".into());
    }
    build_rule_kind(&tp, &payload, &params)
}

fn build_logic(payload: &str, is_and: bool) -> RuleKind {
    match split_top_level_groups(payload) {
        Ok(groups) if !groups.is_empty() => {
            let children: Vec<RuleKind> = groups.iter().map(|g| build_predicate_from_line(g)).collect();
            if is_and {
                RuleKind::And(children)
            } else {
                RuleKind::Or(children)
            }
        }
        Ok(_) => RuleKind::Unknown("пустой список правил в логическом операторе".into()),
        Err(e) => RuleKind::Unknown(e),
    }
}

fn build_not(payload: &str) -> RuleKind {
    match split_top_level_groups(payload) {
        Ok(groups) if groups.len() == 1 => RuleKind::Not(Box::new(build_predicate_from_line(&groups[0]))),
        Ok(_) => RuleKind::Unknown("NOT должен содержать ровно одно правило".into()),
        Err(e) => RuleKind::Unknown(e),
    }
}

/// Разбирает предикат без цели — используется для classical-записей провайдеров (там же, где
/// mihomo зовёт `classicalStrategy.payloadToRule`, `MATCH`/`RULE-SET`/`SUB-RULE` запрещены).
pub(crate) fn parse_predicate(line: &str) -> Result<RuleKind, String> {
    let (tp, payload, _target, params) = parse_rule_payload(line, false);
    if matches!(tp.as_str(), "MATCH" | "RULE-SET" | "SUB-RULE") {
        return Err(format!("тип {tp} недопустим внутри classical rule-set"));
    }
    Ok(build_rule_kind(&tp, &payload, &params))
}

/// Для узлов, чей исход не зависит от цели (напр. `PROCESS-*-REGEX`/`-WILDCARD` против всегда
/// пустого `metadata.Process`/`ProcessPath`) — сворачиваем результат сразу при разборе правила.
fn rule_kind_from_bool(b: bool) -> RuleKind {
    if b { RuleKind::Match } else { RuleKind::NoMatch }
}

fn build_rule_kind(tp: &str, payload: &str, params: &[String]) -> RuleKind {
    match tp {
        "DOMAIN" => RuleKind::Domain(payload.to_lowercase()),
        "DOMAIN-SUFFIX" => RuleKind::DomainSuffix(payload.to_lowercase()),
        "DOMAIN-KEYWORD" => RuleKind::DomainKeyword(payload.to_lowercase()),
        "DOMAIN-REGEX" => match RegexBuilder::new(payload).case_insensitive(true).build() {
            Ok(re) => RuleKind::DomainRegex(re),
            Err(e) => RuleKind::Unknown(format!("неверное регулярное выражение: {e}")),
        },
        "DOMAIN-WILDCARD" => RuleKind::DomainWildcard(payload.to_lowercase()),
        "GEOSITE" => RuleKind::Geosite(payload.to_string()),
        "GEOIP" => {
            let (is_src, no_resolve) = parse_params(params);
            RuleKind::Geoip {
                country: payload.to_lowercase(),
                is_src,
                no_resolve,
            }
        }
        "SRC-GEOIP" => RuleKind::Geoip {
            country: payload.to_lowercase(),
            is_src: true,
            no_resolve: true,
        },
        "IP-ASN" => {
            let (is_src, no_resolve) = parse_params(params);
            match parse_asn(payload) {
                Some(asn) => RuleKind::IpAsn {
                    asn,
                    is_src,
                    no_resolve,
                },
                None => RuleKind::Unknown("неверный ASN".into()),
            }
        }
        "SRC-IP-ASN" => match parse_asn(payload) {
            Some(asn) => RuleKind::IpAsn {
                asn,
                is_src: true,
                no_resolve: true,
            },
            None => RuleKind::Unknown("неверный ASN".into()),
        },
        "IP-CIDR" | "IP-CIDR6" => {
            let (is_src, no_resolve) = parse_params(params);
            match Cidr::parse(payload) {
                Some(cidr) => RuleKind::IpCidr {
                    cidr,
                    is_src,
                    no_resolve,
                },
                None => RuleKind::Unknown("неверный IP-CIDR".into()),
            }
        }
        "SRC-IP-CIDR" => match Cidr::parse(payload) {
            Some(cidr) => RuleKind::IpCidr {
                cidr,
                is_src: true,
                no_resolve: true,
            },
            None => RuleKind::Unknown("неверный IP-CIDR".into()),
        },
        "IP-SUFFIX" => {
            let (is_src, no_resolve) = parse_params(params);
            match Cidr::parse(payload) {
                Some(cidr) => RuleKind::IpSuffix {
                    cidr,
                    is_src,
                    no_resolve,
                },
                None => RuleKind::Unknown("неверный IP-SUFFIX".into()),
            }
        }
        "SRC-IP-SUFFIX" => match Cidr::parse(payload) {
            Some(cidr) => RuleKind::IpSuffix {
                cidr,
                is_src: true,
                no_resolve: true,
            },
            None => RuleKind::Unknown("неверный IP-SUFFIX".into()),
        },
        "DST-PORT" => match PortRanges::parse(payload) {
            Ok(r) => RuleKind::DstPort(r),
            Err(e) => RuleKind::Unknown(e),
        },
        "SRC-PORT" => RuleKind::Unknown("нужен порт источника".into()),
        "IN-PORT" | "IN-TYPE" | "IN-USER" | "IN-NAME" => {
            RuleKind::Unknown("недоступно вне реального соединения".into())
        }
        "DSCP" => RuleKind::Unknown("DSCP недоступен для тестера маршрутов".into()),
        // Тестер симулирует пересылаемый через роутер LAN-трафик: владельца сокета найти нельзя
        // ни в одном режиме find-process-mode (см. `RuleKind::NoMatch`) -> `metadata.Process`/
        // `ProcessPath` в mihomo остаются "" на всё время матчинга (rules/common/process.go,
        // `Match`: `helper.FindProcess()` вызывается, но при провале просто не трогает metadata).
        // `Match` НЕ делает `return false` на пустой target — сравнивает/матчит буквально как есть:
        //   case ProcessName/ProcessPath: `strings.EqualFold(target, ps.pattern)`. payload не может
        //   быть пустым (`rules/parser.go`: `if tp != "MATCH" && payload == "" { error }`), значит
        //   `EqualFold("", непустой_payload)` — всегда false -> детерминированный NoMatch.
        "PROCESS-NAME" | "PROCESS-PATH" => RuleKind::NoMatch,
        //   case ProcessNameRegex/ProcessPathRegex: `ps.regexp.MatchString(target)` — обычный матч
        //   по пустой строке, результат зависит от паттерна (`.*` матчит "", `^discord$` — нет).
        //   Раз target зафиксирован как "" для всего прогона тестера, можно посчитать это один раз
        //   при разборе правила и сразу свернуть узел в `Match`/`NoMatch` (regexp2.IgnoreCase на
        //   исход матча с "" не влияет, но компилируем с ним же ради консистентности с mihomo).
        "PROCESS-NAME-REGEX" | "PROCESS-PATH-REGEX" => {
            match RegexBuilder::new(payload).case_insensitive(true).build() {
                Ok(re) => rule_kind_from_bool(re.is_match("")),
                Err(e) => RuleKind::Unknown(format!("неверное регулярное выражение: {e}")),
            }
        }
        //   case ProcessNameWildcard/ProcessPathWildcard: `wildcard.Match(strings.ToLower(pattern),
        //   strings.ToLower(target))` — та же `component/wildcard.Match`, что и у DOMAIN-WILDCARD
        //   (rules/common/domain_wildcard.go), уже реализована как `glob_match` в этом файле.
        //   `wildcard.Match("*", "")` возвращает true, поэтому чисто "*" реально матчит.
        "PROCESS-NAME-WILDCARD" | "PROCESS-PATH-WILDCARD" => {
            rule_kind_from_bool(glob_match(&payload.to_lowercase(), ""))
        }
        "NETWORK" => match payload.to_uppercase().as_str() {
            "TCP" => RuleKind::Network(Network::Tcp),
            "UDP" => RuleKind::Network(Network::Udp),
            _ => RuleKind::Unknown(format!("неизвестный тип сети: {payload}")),
        },
        // Как и PROCESS-*: metadata.Uid остаётся 0 (сокет LAN-клиента не принадлежит роутеру) ->
        // `Uid.Match` в mihomo падает в `metadata.Uid != 0 == false` -> NoMatch.
        "UID" => RuleKind::NoMatch,
        "REMATCH-NAME" => RuleKind::Unknown("REMATCH-NAME недоступен для тестера маршрутов".into()),
        "SUB-RULE" => RuleKind::Unknown("SUB-RULE не поддерживается".into()),
        "RULE-SET" => {
            let (is_src, no_resolve) = parse_params(params);
            RuleKind::RuleSet {
                name: payload.to_string(),
                is_src,
                no_resolve,
            }
        }
        "AND" => build_logic(payload, true),
        "OR" => build_logic(payload, false),
        "NOT" => build_not(payload),
        "MATCH" => RuleKind::Match,
        "" => RuleKind::Unknown("пустая строка правила".into()),
        other => RuleKind::Unknown(format!("неизвестный тип правила: {other}")),
    }
}

fn rebuild_text_without_target(tp: &str, payload: &str, params: &[String]) -> String {
    if payload.is_empty() && params.is_empty() {
        tp.to_string()
    } else if params.is_empty() {
        format!("{tp},{payload}")
    } else {
        format!("{tp},{payload},{}", params.join(","))
    }
}

struct TopRule {
    index: usize,
    text: String,
    target: String,
    node: RuleKind,
}

fn build_top_rules(lines: &[String]) -> Vec<TopRule> {
    lines
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let (tp, payload, target, params) = parse_rule_payload(raw, true);
            let text = rebuild_text_without_target(&tp, &payload, &params);
            let node = if tp == "MATCH" {
                if target.is_empty() {
                    RuleKind::Unknown("MATCH без цели".into())
                } else {
                    RuleKind::Match
                }
            } else if target.is_empty() {
                RuleKind::Unknown("не указана цель правила".into())
            } else {
                build_rule_kind(&tp, &payload, &params)
            };
            TopRule {
                index,
                text,
                target,
                node,
            }
        })
        .collect()
}

fn is_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_multicast() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Аналог IPSuffix.Match: сравнение хвостовых `bits` бит адреса (не требует выравнивания сети).
fn ip_suffix_match(pattern: IpAddr, bits: u8, ip: IpAddr) -> bool {
    let (p, i): (Vec<u8>, Vec<u8>) = match (pattern, ip) {
        (IpAddr::V4(p), IpAddr::V4(i)) => (p.octets().to_vec(), i.octets().to_vec()),
        (IpAddr::V6(p), IpAddr::V6(i)) => (p.octets().to_vec(), i.octets().to_vec()),
        _ => return false,
    };
    let size = p.len();
    let full_bytes = (bits / 8) as usize;
    if full_bytes > size {
        return false;
    }
    for k in 1..=full_bytes {
        if p[size - k] != i[size - k] {
            return false;
        }
    }
    let rem = bits % 8;
    if rem != 0 {
        let idx = size - full_bytes - 1;
        if (p[idx] << (8 - rem)) != (i[idx] << (8 - rem)) {
            return false;
        }
    }
    true
}

/// Glob как в `component/wildcard.Match`: `*` — ноль и более любых символов (включая точки),
/// `?` — ровно один символ. Используется только правилом `DOMAIN-WILDCARD` (не путать с
/// wildcard-синтаксисом провайдеров, который однолейбловый).
fn glob_match(pattern: &str, s: &str) -> bool {
    if pattern.is_empty() {
        return s.is_empty();
    }
    if pattern == "*" || s == pattern {
        return true;
    }
    let p = pattern.as_bytes();
    let t = s.as_bytes();
    let (mut pi, mut si, mut last_star, mut star): (usize, usize, usize, Option<usize>) = (0, 0, 0, None);
    loop {
        if si < t.len() {
            if pi < p.len() {
                match p[pi] {
                    b'?' => {
                        pi += 1;
                        si += 1;
                        continue;
                    }
                    b'*' => {
                        star = Some(pi);
                        last_star = si;
                        pi += 1;
                        continue;
                    }
                    c if c == t[si] => {
                        pi += 1;
                        si += 1;
                        continue;
                    }
                    _ => {}
                }
            }
            if let Some(s0) = star {
                pi = s0 + 1;
                last_star += 1;
                si = last_star;
                continue;
            }
            return false;
        }
        // si >= t.len()
        while pi < p.len() && p[pi] == b'*' {
            pi += 1;
        }
        return pi == p.len();
    }
}

/// Состояние вычисления для одной цели: резолв IP лениво и один раз (как в `tunnel.resolveMetadata`
/// — closure `resolved`), результат кешируется на все последующие правила в этом же прогоне.
pub(crate) struct EvalState<'a, R: Resolver> {
    domain_target: Option<&'a str>,
    ip_target: Option<IpAddr>,
    port: u16,
    network: Network,
    source_ip: Option<IpAddr>,
    resolver: &'a R,
    resolve_tried: bool,
    resolved_ip: Option<IpAddr>,
    resolved_ips_all: Vec<IpAddr>,
    dns_source: Option<DnsSource>,
    suppress_resolve: bool,
    /// `true` внутри classical-провайдера, доставаемого через `RULE-SET,name,src` — Src/Dst
    /// физически поменяны местами (см. `constant/metadata.go::SwapSrcDst`), поэтому у вложенных
    /// правил смысл их собственного `is_src` инвертируется. `Host` при этом НЕ меняется
    /// (`RuleHost()` не участвует в свопе), поэтому на доменные правила/провайдеры это не влияет.
    swap_src: bool,
    detail: Option<String>,
    providers: &'a Providers,
    geodata_mode: bool,
    geosite_path: Option<&'a Path>,
    geoip_dat_path: Option<&'a Path>,
    geoip_mmdb_path: Option<&'a Path>,
    asn_mmdb_path: Option<&'a Path>,
    warnings: &'a Mutex<Vec<String>>,
}

impl<'a, R: Resolver> EvalState<'a, R> {
    fn push_warning(&self, msg: String) {
        let mut w = self.warnings.lock().unwrap();
        if !w.contains(&msg) {
            w.push(msg);
        }
    }

    /// Возвращает DstIP, лениво резолвя домен не более одного раза за весь прогон (как
    /// `helper.ResolveIP` в tunnel.go). `no_resolve` подавляет резолв только для этого вызова,
    /// но не мешает более позднему правилу резолвить и не отменяет уже резолвленный IP.
    async fn dst_ip(&mut self, no_resolve: bool) -> Option<IpAddr> {
        if let Some(ip) = self.ip_target {
            return Some(ip);
        }
        if let Some(ip) = self.resolved_ip {
            return Some(ip);
        }
        if no_resolve || self.suppress_resolve || self.resolve_tried {
            return None;
        }
        self.resolve_tried = true;
        let domain = self.domain_target?;
        if let Ok((ips, source)) = self.resolver.resolve(domain).await
            && let Some(first) = ips.first().copied()
        {
            self.resolved_ip = Some(first);
            self.dns_source = Some(source);
            self.resolved_ips_all = ips;
        }
        self.resolved_ip
    }

    /// Единая точка получения IP для IP-правил (обычных и `SRC-*`), учитывающая своп Src/Dst
    /// внутри `RULE-SET,name,src` (см. `swap_src`). Физический слот, который реально читается —
    /// `is_src XOR swap_src`: без свопа `is_src` читает `source_ip` как обычно; внутри свопа
    /// значение инвертируется (mihomo: `RuleSet.Match` делает `metadata.SwapSrcDst()` перед вызовом
    /// `provider.Match`, так что поле `SrcIP` у вложенного правила физически хранит то, что было
    /// `DstIP`, и наоборот). Резолв в режиме src недоступен вообще (`helper.ResolveIP = nil`
    /// безусловно в `rule_set.go`) — обеспечивается тем, что `no_resolve` уже форсируется в
    /// `true` при `is_src` (см. `parse_params`), а здесь дополнительно форсируется через `swap_src`.
    /// Отсутствие `source_ip`, когда он нужен — не «не совпало», а «не можем проверить»: `Unknown`,
    /// как и у остальных `SRC-*` правил.
    async fn ip_for(&mut self, is_src: bool, no_resolve: bool) -> Result<IpAddr, Verdict> {
        let want_physical_source = is_src != self.swap_src;
        if want_physical_source {
            self.source_ip
                .ok_or_else(|| Verdict::Unknown("нужен IP источника".into()))
        } else {
            self.dst_ip(no_resolve || self.swap_src).await.ok_or(Verdict::NoMatch)
        }
    }

    async fn eval_geosite(&mut self, tag: &str) -> Verdict {
        let Some(domain) = self.domain_target else {
            return Verdict::NoMatch;
        };
        let Some(path) = self.geosite_path else {
            self.push_warning("Файл GeoSite.dat не найден в /opt/etc/mihomo, правила GEOSITE пропущены".into());
            return Verdict::Unknown("нет файла GeoSite.dat".into());
        };
        // Блокирующее чтение файла внутри geodb (само оно не tokio-осведомлено, сигнатуры общие с
        // xray.rs) — не даём ему замораживать рабочий поток рантайма (тот же приём, что в
        // `xray.rs::evaluate_rule`).
        match tokio::task::block_in_place(|| super::geodb::site_contains(path, tag, domain)) {
            Ok(b) => bool_verdict(b),
            Err(e) => {
                self.push_warning(format!("GEOSITE,{tag}: {e}"));
                Verdict::Unknown(e)
            }
        }
    }

    async fn eval_geoip(&mut self, country: &str, is_src: bool, no_resolve: bool) -> Verdict {
        let ip = match self.ip_for(is_src, no_resolve).await {
            Ok(ip) => ip,
            Err(v) => return v,
        };
        if country == "lan" {
            return bool_verdict(is_lan(ip));
        }
        if self.geodata_mode {
            let Some(path) = self.geoip_dat_path else {
                self.push_warning("Файл GeoIP.dat не найден в /opt/etc/mihomo, правила GEOIP пропущены".into());
                return Verdict::Unknown("нет файла GeoIP.dat".into());
            };
            let tag = country.to_uppercase();
            match tokio::task::block_in_place(|| super::geodb::ip_in_dat(path, &tag, ip)) {
                Ok(b) => bool_verdict(b),
                Err(e) => {
                    self.push_warning(format!("GEOIP,{country}: {e}"));
                    Verdict::Unknown(e)
                }
            }
        } else {
            let Some(path) = self.geoip_mmdb_path else {
                self.push_warning(
                    "Файл geoip.metadb/Country.mmdb не найден в /opt/etc/mihomo, правила GEOIP пропущены".into(),
                );
                return Verdict::Unknown("нет файла geoip.metadb".into());
            };
            match tokio::task::block_in_place(|| super::geodb::mmdb_country(path, ip)) {
                Ok(Some(codes)) => bool_verdict(codes.iter().any(|c| c.eq_ignore_ascii_case(country))),
                Ok(None) => Verdict::NoMatch,
                Err(e) => {
                    self.push_warning(format!("GEOIP,{country}: {e}"));
                    Verdict::Unknown(e)
                }
            }
        }
    }

    async fn eval_ipasn(&mut self, asn: u32, is_src: bool, no_resolve: bool) -> Verdict {
        let ip = match self.ip_for(is_src, no_resolve).await {
            Ok(ip) => ip,
            Err(v) => return v,
        };
        let Some(path) = self.asn_mmdb_path else {
            self.push_warning("Файл ASN.mmdb не найден в /opt/etc/mihomo, правила IP-ASN пропущены".into());
            return Verdict::Unknown("нет файла ASN.mmdb".into());
        };
        match tokio::task::block_in_place(|| super::geodb::mmdb_asn(path, ip)) {
            Ok(Some((num, _org))) => bool_verdict(num == asn),
            Ok(None) => Verdict::NoMatch,
            Err(e) => {
                self.push_warning(format!("IP-ASN: {e}"));
                Verdict::Unknown(e)
            }
        }
    }

    async fn eval_ruleset(&mut self, name: &str, is_src: bool, no_resolve: bool) -> Verdict {
        let Some(provider) = self.providers.get(name) else {
            let reason = self
                .providers
                .unusable_reason(name)
                .map(str::to_string)
                .unwrap_or_else(|| "не найден".to_string());
            self.push_warning(format!("Провайдер '{name}': {reason}, правила с ним пропущены"));
            return Verdict::Unknown(format!("провайдер '{name}' недоступен"));
        };
        match provider {
            ParsedProvider::Domain(dp) => match self.domain_target {
                Some(d) => match dp.matches(d) {
                    Some(text) => {
                        self.detail = Some(format!("{name}: {text}"));
                        Verdict::Match
                    }
                    None => Verdict::NoMatch,
                },
                None => Verdict::NoMatch,
            },
            ParsedProvider::IpCidr(ip) => {
                let ip_addr = match self.ip_for(is_src, no_resolve).await {
                    Ok(a) => Some(a),
                    Err(Verdict::Unknown(reason)) => return Verdict::Unknown(reason),
                    Err(_) => None,
                };
                match ip_addr.and_then(|a| ip.matches(a)) {
                    Some(text) => {
                        self.detail = Some(format!("{name}: {text}"));
                        Verdict::Match
                    }
                    None => Verdict::NoMatch,
                }
            }
            ParsedProvider::Classical(cp) => {
                // `is_src` => полный своп Src/Dst для вложенных правил (mihomo:
                // `RuleSet.Match`/`SwapSrcDst`); `Host` не свопается, поэтому доменные правила
                // внутри classical (в т.ч. через `swap_src`) читают тот же `domain_target`, что и
                // всегда — своп реально влияет только на IP-правила через `ip_for`.
                let saved_suppress = self.suppress_resolve;
                let saved_swap = self.swap_src;
                if no_resolve {
                    self.suppress_resolve = true;
                }
                if is_src {
                    self.swap_src = true;
                }
                let (verdict, matched_text) = cp.matches(self).await;
                self.suppress_resolve = saved_suppress;
                self.swap_src = saved_swap;
                if verdict == Verdict::Match
                    && let Some(t) = matched_text
                {
                    self.detail = Some(format!("{name}: {t}"));
                }
                verdict
            }
        }
    }
}

/// Рекурсивное async-вычисление предиката. Возвращает боксированный future явно — рекурсивные
/// `async fn` в Rust не компилируются без такого приёма (неизвестный размер future).
pub(crate) fn eval_predicate<'a, R: Resolver>(
    node: &'a RuleKind, eval: &'a mut EvalState<'_, R>,
) -> Pin<Box<dyn Future<Output = Verdict> + Send + 'a>> {
    Box::pin(async move {
        match node {
            RuleKind::Unknown(reason) => Verdict::Unknown(reason.clone()),
            RuleKind::Match => Verdict::Match,
            RuleKind::NoMatch => Verdict::NoMatch,
            RuleKind::Domain(d) => bool_verdict(eval.domain_target == Some(d.as_str())),
            RuleKind::DomainSuffix(s) => bool_verdict(
                eval.domain_target
                    .is_some_and(|t| t == s || t.ends_with(&format!(".{s}"))),
            ),
            RuleKind::DomainKeyword(k) => bool_verdict(eval.domain_target.is_some_and(|t| t.contains(k.as_str()))),
            RuleKind::DomainRegex(re) => bool_verdict(eval.domain_target.is_some_and(|t| re.is_match(t))),
            RuleKind::DomainWildcard(pattern) => {
                bool_verdict(eval.domain_target.is_some_and(|t| glob_match(pattern, t)))
            }
            RuleKind::Geosite(tag) => eval.eval_geosite(tag).await,
            RuleKind::IpCidr {
                cidr,
                is_src,
                no_resolve,
            } => {
                let ip = match eval.ip_for(*is_src, *no_resolve).await {
                    Ok(ip) => ip,
                    Err(v) => return v,
                };
                bool_verdict(cidr.contains(ip))
            }
            RuleKind::IpSuffix {
                cidr,
                is_src,
                no_resolve,
            } => {
                let ip = match eval.ip_for(*is_src, *no_resolve).await {
                    Ok(ip) => ip,
                    Err(v) => return v,
                };
                bool_verdict(ip_suffix_match(cidr.net, cidr.bits, ip))
            }
            RuleKind::IpAsn {
                asn,
                is_src,
                no_resolve,
            } => eval.eval_ipasn(*asn, *is_src, *no_resolve).await,
            RuleKind::Geoip {
                country,
                is_src,
                no_resolve,
            } => eval.eval_geoip(country, *is_src, *no_resolve).await,
            RuleKind::DstPort(ranges) => bool_verdict(ranges.check(eval.port)),
            RuleKind::Network(n) => bool_verdict(*n == eval.network),
            RuleKind::RuleSet {
                name,
                is_src,
                no_resolve,
            } => eval.eval_ruleset(name, *is_src, *no_resolve).await,
            RuleKind::And(children) => {
                let mut saw_unknown: Option<String> = None;
                for child in children {
                    match eval_predicate(child, eval).await {
                        Verdict::NoMatch => return Verdict::NoMatch,
                        Verdict::Unknown(reason) => {
                            if saw_unknown.is_none() {
                                saw_unknown = Some(reason);
                            }
                        }
                        Verdict::Match => {}
                    }
                }
                match saw_unknown {
                    Some(reason) => Verdict::Unknown(reason),
                    None => Verdict::Match,
                }
            }
            RuleKind::Or(children) => {
                let mut saw_unknown: Option<String> = None;
                for child in children {
                    match eval_predicate(child, eval).await {
                        Verdict::Match => return Verdict::Match,
                        Verdict::Unknown(reason) => {
                            if saw_unknown.is_none() {
                                saw_unknown = Some(reason);
                            }
                        }
                        Verdict::NoMatch => {}
                    }
                }
                match saw_unknown {
                    Some(reason) => Verdict::Unknown(reason),
                    None => Verdict::NoMatch,
                }
            }
            RuleKind::Not(child) => match eval_predicate(child, eval).await {
                Verdict::Match => Verdict::NoMatch,
                Verdict::NoMatch => Verdict::Match,
                Verdict::Unknown(reason) => Verdict::Unknown(reason),
            },
        }
    })
}

/// Загруженный и разобранный конфиг mihomo (правила, провайдеры, geo-файлы).
pub struct Engine {
    rules: Vec<TopRule>,
    providers: Providers,
    geodata_mode: bool,
    geosite_path: Option<PathBuf>,
    geoip_dat_path: Option<PathBuf>,
    geoip_mmdb_path: Option<PathBuf>,
    asn_mmdb_path: Option<PathBuf>,
    warnings: Mutex<Vec<String>>,
}

async fn find_geo_file(dir: &Path, candidates: &[&str]) -> Option<PathBuf> {
    let mut rd = tokio::fs::read_dir(dir).await.ok()?;
    let mut found: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        if let Ok(ft) = entry.file_type().await
            && ft.is_dir()
        {
            continue;
        }
        found.insert(entry.file_name().to_string_lossy().to_lowercase(), entry.path());
    }
    candidates.iter().find_map(|c| found.get(&c.to_lowercase()).cloned())
}

async fn build_engine(doc: &Yaml, base_dir: &Path) -> Result<Engine, String> {
    let rule_lines: Vec<String> = doc["rules"]
        .as_vec()
        .map(|v| v.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
        .unwrap_or_default();
    let rules = build_top_rules(&rule_lines);

    let defs = providers::parse_provider_defs(&doc["rule-providers"], base_dir);
    let providers = Providers::load(defs).await;

    let geodata_mode = doc["geodata-mode"].as_bool().unwrap_or(false);
    let geosite_path = find_geo_file(base_dir, &["geosite.dat"]).await;
    let geoip_dat_path = find_geo_file(base_dir, &["geoip.dat"]).await;
    let geoip_mmdb_path = find_geo_file(base_dir, &["country.mmdb", "geoip.db", "geoip.metadb"]).await;
    let asn_mmdb_path = find_geo_file(base_dir, &["asn.mmdb"]).await;

    Ok(Engine {
        rules,
        providers,
        geodata_mode,
        geosite_path,
        geoip_dat_path,
        geoip_mmdb_path,
        asn_mmdb_path,
        warnings: Mutex::new(Vec::new()),
    })
}

/// Загружает и парсит `config.yaml` + провайдеры активного mihomo.
pub async fn load() -> Result<Engine, String> {
    let docs = crate::ruleset_inspector::load_mihomo_yaml().await?;
    let doc = docs.first().ok_or_else(|| "YAML пуст".to_string())?;
    build_engine(doc, Path::new(crate::types::MIHOMO_CONF_DIR)).await
}

#[cfg(test)]
pub(crate) async fn from_yaml_str(yaml: &str, base_dir: &Path) -> Result<Engine, String> {
    let docs = yaml_rust2::YamlLoader::load_from_str(yaml).map_err(|e| e.to_string())?;
    let doc = docs.first().ok_or_else(|| "YAML пуст".to_string())?;
    build_engine(doc, base_dir).await
}

impl Engine {
    /// Прогоняет цель через список правил и возвращает итог сравнения.
    pub async fn evaluate<R: Resolver>(&self, ctx: &TestContext, resolver: &R) -> RouteResult {
        let (domain_target, ip_target) = match &ctx.target {
            super::Target::Domain(d) => (Some(d.as_str()), None),
            super::Target::Ip(ip) => (None, Some(*ip)),
        };
        let mut eval = EvalState {
            domain_target,
            ip_target,
            port: ctx.port,
            network: ctx.network,
            source_ip: ctx.source_ip,
            resolver,
            resolve_tried: false,
            resolved_ip: None,
            resolved_ips_all: Vec::new(),
            dns_source: None,
            suppress_resolve: false,
            swap_src: false,
            detail: None,
            providers: &self.providers,
            geodata_mode: self.geodata_mode,
            geosite_path: self.geosite_path.as_deref(),
            geoip_dat_path: self.geoip_dat_path.as_deref(),
            geoip_mmdb_path: self.geoip_mmdb_path.as_deref(),
            asn_mmdb_path: self.asn_mmdb_path.as_deref(),
            warnings: &self.warnings,
        };

        let mut skipped = Vec::new();
        let mut matched: Option<(String, MatchedRule)> = None;
        for rule in &self.rules {
            eval.detail = None;
            match eval_predicate(&rule.node, &mut eval).await {
                Verdict::Match => {
                    matched = Some((
                        rule.target.clone(),
                        MatchedRule {
                            index: rule.index,
                            text: rule.text.clone(),
                            detail: eval.detail.take(),
                        },
                    ));
                    break;
                }
                Verdict::Unknown(reason) => {
                    skipped.push(SkippedRule {
                        index: rule.index,
                        text: rule.text.clone(),
                        reason,
                    });
                }
                Verdict::NoMatch => {}
            }
        }

        let (outcome, outbound, rule) = match matched {
            Some((outbound, rule)) => (Outcome::Matched, Some(outbound), Some(rule)),
            None => (Outcome::Default, Some("DIRECT".to_string()), None),
        };

        RouteResult {
            target: ctx.target.to_string(),
            kind: ctx.target.kind().to_string(),
            outcome,
            outbound,
            rule,
            balancer: None,
            resolved_ips: eval.resolved_ips_all,
            dns_source: eval.dns_source,
            skipped,
            error: None,
        }
    }

    /// Предупреждения, накопленные при загрузке/вычислении (напр. отсутствующие geo-файлы).
    pub fn warnings(&self) -> Vec<String> {
        self.warnings.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route_test::dns::StaticResolver;
    use crate::route_test::{Network as Net, TestContext as Ctx};
    use std::collections::HashMap as Map;

    fn ctx_domain(domain: &str) -> Ctx {
        Ctx {
            target: super::super::Target::Domain(domain.to_string()),
            port: 443,
            network: Net::Tcp,
            source_ip: None,
            inbound_tag: None,
        }
    }

    fn ctx_ip(ip: &str) -> Ctx {
        Ctx {
            target: super::super::Target::Ip(ip.parse().unwrap()),
            port: 443,
            network: Net::Tcp,
            source_ip: None,
            inbound_tag: None,
        }
    }

    fn empty_resolver() -> StaticResolver {
        StaticResolver(Map::new())
    }

    const BASE_YAML: &str = r#"
geodata-mode: false
rule-providers:
  meta@domain: {type: http, format: text, behavior: domain, url: https://example.com/meta-domain.txt}
  meta@ipcidr: {type: http, format: text, behavior: ipcidr, url: https://example.com/meta-ipcidr.txt}
  user@classical: {type: http, format: text, behavior: classical, url: https://example.com/user-classical.txt}
  a1: &domain {type: http, format: mrs, behavior: domain, interval: 86400}
  refilter@domain:
    <<: *domain
    format: text
    url: https://example.com/refilter-domain.txt
rules:
  - "OR,((RULE-SET,meta@domain),(RULE-SET,meta@ipcidr,no-resolve)),Meta"
  - "OR,((RULE-SET,refilter@domain),(RULE-SET,user@classical)),Заблок. сервисы"
  - "IP-SUFFIX,1.2.3.4/32,DIRECT"
  - "DOMAIN-SUFFIX,x.com,DIRECT"
  - "SRC-IP-CIDR,192.168.1.5/32,Local"
  - "MATCH,Proxy"
"#;

    async fn write(dir: &Path, name: &str, content: &str) {
        tokio::fs::write(dir.join(name), content).await.unwrap();
    }

    async fn build_fixture_engine() -> (Engine, PathBuf) {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(dir.join("rules")).await.unwrap();
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/meta-domain.txt")),
            "+.youtube.com\ngoogle.com\n*.stream.example.com\n",
        )
        .await;
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/meta-ipcidr.txt")),
            "10.0.0.0/8\n",
        )
        .await;
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/user-classical.txt")),
            "DOMAIN-SUFFIX,example.org\nIP-CIDR,203.0.113.0/24,no-resolve\n",
        )
        .await;
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/refilter-domain.txt")),
            "+.twitch.tv\n",
        )
        .await;
        let engine = from_yaml_str(BASE_YAML, &dir).await.expect("engine should load");
        (engine, dir)
    }

    #[tokio::test]
    async fn ruleset_domain_provider_matches_via_or() {
        let (engine, _dir) = build_fixture_engine().await;
        let res = engine.evaluate(&ctx_domain("www.youtube.com"), &empty_resolver()).await;
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("Meta"));
        assert_eq!(res.rule.unwrap().index, 0);
    }

    #[tokio::test]
    async fn ruleset_ipcidr_no_resolve_skips_domain_target() {
        let (engine, _dir) = build_fixture_engine().await;
        // meta@domain не содержит example.org -> первая OR-ветка NoMatch/NoMatch, вторая (RULE-SET
        // meta@ipcidr,no-resolve) на доменную цель без резолва тоже NoMatch -> идём дальше.
        let res = engine.evaluate(&ctx_domain("example.org"), &empty_resolver()).await;
        // example.org матчится user@classical (DOMAIN-SUFFIX,example.org) из второго правила.
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("Заблок. сервисы"));
        let rule = res.rule.unwrap();
        assert_eq!(
            rule.detail.as_deref(),
            Some("user@classical: DOMAIN-SUFFIX,example.org")
        );
    }

    #[tokio::test]
    async fn detail_reports_matched_provider_entry() {
        let (engine, _dir) = build_fixture_engine().await;
        let res = engine.evaluate(&ctx_domain("sub.twitch.tv"), &empty_resolver()).await;
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("Заблок. сервисы"));
        assert_eq!(
            res.rule.unwrap().detail.as_deref(),
            Some("refilter@domain: +.twitch.tv")
        );
    }

    #[tokio::test]
    async fn ip_suffix_matches_exact_ip() {
        let (engine, _dir) = build_fixture_engine().await;
        let res = engine.evaluate(&ctx_ip("1.2.3.4"), &empty_resolver()).await;
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert_eq!(res.rule.unwrap().index, 2);
    }

    #[tokio::test]
    async fn domain_suffix_matches() {
        let (engine, _dir) = build_fixture_engine().await;
        let res = engine.evaluate(&ctx_domain("www.x.com"), &empty_resolver()).await;
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert_eq!(res.rule.unwrap().index, 3);
    }

    #[tokio::test]
    async fn src_ip_cidr_without_source_ip_is_unknown_and_skipped() {
        let (engine, _dir) = build_fixture_engine().await;
        let res = engine.evaluate(&ctx_domain("unrelated.test"), &empty_resolver()).await;
        // ничего конкретного не совпало -> дошли до MATCH,Proxy
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        let skip = res
            .skipped
            .iter()
            .find(|s| s.index == 4)
            .expect("SRC-IP-CIDR rule must be skipped");
        assert_eq!(skip.reason, "нужен IP источника");
        assert_eq!(skip.text, "SRC-IP-CIDR,192.168.1.5/32");
    }

    #[tokio::test]
    async fn match_rule_is_default_catch_all() {
        let (engine, _dir) = build_fixture_engine().await;
        let res = engine
            .evaluate(&ctx_domain("totally-unknown.example"), &empty_resolver())
            .await;
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        assert_eq!(res.rule.unwrap().index, 5);
    }

    #[tokio::test]
    async fn no_match_falls_back_to_direct_default() {
        let (engine, _dir) = build_fixture_engine().await;
        // Подменим движок без MATCH в конце, чтобы проверить дефолт DIRECT.
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-nomatch-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "DOMAIN,only.example,Proxy"
"#;
        let engine2 = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine2.evaluate(&ctx_domain("nope.example"), &empty_resolver()).await;
        assert_eq!(res.outcome, Outcome::Default);
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert!(res.rule.is_none());
        let _ = engine; // подавляем неиспользуемое предупреждение первого движка в этом тесте
    }

    #[tokio::test]
    async fn unknown_provider_is_reported_as_warning() {
        let (engine, _dir) = build_fixture_engine().await;
        let _ = engine.evaluate(&ctx_domain("www.youtube.com"), &empty_resolver()).await;
        // meta@ipcidr существует, поэтому явно проверим ссылку на несуществующий провайдер.
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-missing-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "OR,((RULE-SET,ads@domain)),Заблок"
  - "MATCH,DIRECT"
"#;
        let engine2 = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine2.evaluate(&ctx_domain("ads.example"), &empty_resolver()).await;
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        let warnings = engine2.warnings();
        assert!(warnings.iter().any(|w| w.contains("ads@domain")));
    }

    #[tokio::test]
    async fn and_propagates_unknown_when_no_nomatch() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-and-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "AND,((DOMAIN-SUFFIX,x.com),(SRC-IP-CIDR,10.0.0.0/8)),Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("a.x.com"), &empty_resolver()).await;
        // DOMAIN-SUFFIX matches, SRC-IP-CIDR требует source ip -> Unknown -> всё правило Unknown -> skip
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert_eq!(res.skipped.len(), 1);
        assert_eq!(res.skipped[0].index, 0);
    }

    #[tokio::test]
    async fn and_short_circuits_on_nomatch_even_with_unknown_present() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-and2-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "AND,((DOMAIN-SUFFIX,other.com),(SRC-IP-CIDR,10.0.0.0/8)),Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("a.x.com"), &empty_resolver()).await;
        // DOMAIN-SUFFIX не совпадает -> NoMatch должен победить Unknown -> правило просто NoMatch,
        // не Unknown, поэтому в skipped его быть не должно.
        assert!(res.skipped.is_empty());
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
    }

    #[tokio::test]
    async fn not_inverts_and_propagates_unknown() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-not-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "NOT,((DOMAIN-SUFFIX,other.com)),Proxy"
  - "NOT,((SRC-IP-CIDR,10.0.0.0/8)),Local"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("a.x.com"), &empty_resolver()).await;
        // NOT(DOMAIN-SUFFIX other.com) -> not-matched -> NOT дает Match
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
    }

    #[tokio::test]
    async fn domain_behavior_syntax_variants() {
        let (engine, _dir) = build_fixture_engine().await;
        // "+.youtube.com" -> точный домен youtube.com тоже должен матчиться.
        let res = engine.evaluate(&ctx_domain("youtube.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Meta"));
        // "google.com" plain -> точное совпадение матчится...
        let res = engine.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Meta"));
        // ...а поддомен НЕ матчится (plain != DOMAIN-SUFFIX) -> идём до MATCH.
        let res = engine.evaluate(&ctx_domain("www.google.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        // "*.stream.example.com" -> ровно один лейбл на месте *.
        let res = engine
            .evaluate(&ctx_domain("a.stream.example.com"), &empty_resolver())
            .await;
        assert_eq!(res.outbound.as_deref(), Some("Meta"));
        let res = engine
            .evaluate(&ctx_domain("a.b.stream.example.com"), &empty_resolver())
            .await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
    }

    #[tokio::test]
    async fn lazy_resolve_ip_rule_after_domain_rules_and_no_resolve_sees_unresolved() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-lazy-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "IP-CIDR,9.9.9.9/32,NoResolveHit,no-resolve"
  - "IP-CIDR,203.0.113.5/32,ResolvedHit"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let mut map = Map::new();
        map.insert("lazy.example".to_string(), vec!["203.0.113.5".parse().unwrap()]);
        let resolver = StaticResolver(map);
        let res = engine.evaluate(&ctx_domain("lazy.example"), &resolver).await;
        // первое правило no-resolve -> DstIP ещё невалиден -> NoMatch; второе триггерит резолв и матчит.
        assert_eq!(res.outbound.as_deref(), Some("ResolvedHit"));
        assert_eq!(res.resolved_ips, vec!["203.0.113.5".parse::<IpAddr>().unwrap()]);
    }

    #[tokio::test]
    async fn ip_target_skips_domain_rules() {
        let (engine, _dir) = build_fixture_engine().await;
        let res = engine.evaluate(&ctx_ip("8.8.8.8"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
    }

    #[tokio::test]
    async fn dst_port_ranges_and_lists() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-port-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "DST-PORT,80,HTTP"
  - "DST-PORT,1000-2000,Range"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let mut ctx = ctx_domain("x.example");
        ctx.port = 1500;
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Range"));
    }

    #[tokio::test]
    async fn network_rule_matches_udp() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-net-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "NETWORK,UDP,UdpOut"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let mut ctx = ctx_domain("x.example");
        ctx.network = Net::Udp;
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("UdpOut"));
    }

    #[tokio::test]
    async fn src_ip_cidr_matches_with_source_ip() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-src-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "SRC-IP-CIDR,192.168.1.0/24,Local"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let mut ctx = ctx_domain("x.example");
        ctx.source_ip = Some("192.168.1.5".parse().unwrap());
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Local"));
    }

    #[tokio::test]
    async fn geosite_without_file_is_unknown_and_skipped() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-geosite-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "GEOSITE,CN,Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("x.example"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert_eq!(res.skipped.len(), 1);
        assert_eq!(res.skipped[0].reason, "нет файла GeoSite.dat");
        assert!(engine.warnings().iter().any(|w| w.contains("GeoSite.dat")));
    }

    #[tokio::test]
    async fn geoip_without_file_is_unknown_and_skipped() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-geoip-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "GEOIP,US,Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_ip("1.1.1.1"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert_eq!(res.skipped.len(), 1);
    }

    #[tokio::test]
    async fn geoip_lan_pseudo_country_needs_no_file() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-lan-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "GEOIP,LAN,Local"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_ip("192.168.1.1"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Local"));
        assert!(res.skipped.is_empty());
    }

    // Минимальный protobuf-энкодер GeoSiteList (см. geodb.rs) — только затем, чтобы прогнать
    // GEOSITE через реальный geodb-вызов (а не только через ветку "файла нет"), это единственный
    // путь, реально попадающий под новый `tokio::task::block_in_place`.
    fn pb_varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let byte = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
    }
    fn pb_len_delim(field: u32, payload: &[u8], out: &mut Vec<u8>) {
        pb_varint(((field as u64) << 3) | 2, out);
        pb_varint(payload.len() as u64, out);
        out.extend_from_slice(payload);
    }
    fn pb_geosite_dat(code: &str, domain_full: &str) -> Vec<u8> {
        let mut domain = Vec::new();
        pb_varint(1 << 3, &mut domain); // field 1, wire varint
        pb_varint(3, &mut domain); // Domain.Type Full = 3
        pb_len_delim(2, domain_full.as_bytes(), &mut domain);
        let mut entry = Vec::new();
        pb_len_delim(1, code.as_bytes(), &mut entry);
        pb_len_delim(2, &domain, &mut entry);
        let mut list = Vec::new();
        pb_len_delim(1, &entry, &mut list);
        list
    }

    /// С реальным `GeoSite.dat` на диске GEOSITE доходит до `geodb::site_contains`, а значит — до
    /// `tokio::task::block_in_place`, которым обёрнут этот вызов (см. `eval_geosite`).
    /// `block_in_place` паникует под однопоточным `current_thread`-рантаймом, поэтому этот тест —
    /// на `flavor = "multi_thread"`.
    #[tokio::test(flavor = "multi_thread")]
    async fn geosite_with_real_file_goes_through_block_in_place() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-geosite-real-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("GeoSite.dat"), pb_geosite_dat("TESTTAG", "example.com"))
            .await
            .unwrap();
        let yaml = r#"
rules:
  - "GEOSITE,TESTTAG,Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("example.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        assert!(res.skipped.is_empty());
        let res_no = engine.evaluate(&ctx_domain("other.com"), &empty_resolver()).await;
        assert_eq!(res_no.outbound.as_deref(), Some("DIRECT"));
    }

    async fn build_src_swap_engine() -> (Engine, PathBuf) {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-srcswap-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(dir.join("rules")).await.unwrap();
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/localnet-classical.txt")),
            "IP-CIDR,192.168.1.0/24\nDOMAIN-SUFFIX,example.org\n",
        )
        .await;
        let yaml = r#"
rule-providers:
  localnet@classical: {type: http, format: text, behavior: classical, url: https://example.com/localnet-classical.txt}
rules:
  - "RULE-SET,localnet@classical,LocalSrc,src"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.expect("engine should load");
        (engine, dir)
    }

    #[tokio::test]
    async fn ruleset_src_swap_classical_ipcidr_matches_source_ip_in_range() {
        let (engine, _dir) = build_src_swap_engine().await;
        let mut ctx = ctx_domain("other.example");
        ctx.source_ip = Some("192.168.1.5".parse().unwrap());
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        // RULE-SET,...,src своппит Src/Dst перед вызовом classical-провайдера (mihomo:
        // rule_set.go::RuleSet.Match), поэтому вложенный (не-SRC) "IP-CIDR" физически читает
        // именно source_ip.
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("LocalSrc"));
    }

    #[tokio::test]
    async fn ruleset_src_swap_classical_ipcidr_nomatch_source_ip_out_of_range() {
        let (engine, _dir) = build_src_swap_engine().await;
        let mut ctx = ctx_domain("other.example");
        ctx.source_ip = Some("10.0.0.1".parse().unwrap());
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert!(res.skipped.is_empty());
    }

    #[tokio::test]
    async fn ruleset_src_swap_classical_unknown_without_source_ip() {
        let (engine, _dir) = build_src_swap_engine().await;
        let ctx = ctx_domain("other.example");
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        let skip = res
            .skipped
            .first()
            .expect("RULE-SET,...,src must be Unknown/skipped without source_ip");
        assert_eq!(skip.reason, "нужен IP источника");
    }

    #[tokio::test]
    async fn ruleset_src_swap_domain_provider_unaffected_by_swap() {
        let (engine, _dir) = build_src_swap_engine().await;
        // Host не участвует в SwapSrcDst (constant/metadata.go), поэтому DOMAIN-SUFFIX внутри
        // classical матчится по домену цели как обычно, даже без source_ip вовсе.
        let ctx = ctx_domain("sub.example.org");
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        assert_eq!(res.outcome, Outcome::Matched);
        assert_eq!(res.outbound.as_deref(), Some("LocalSrc"));
    }

    #[tokio::test]
    async fn ip_suffix_requires_explicit_bits() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-ipsuffix-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        // mihomo (rules/common/ipsuffix.go::NewIPSuffix) парсит payload через netip.ParsePrefix,
        // который требует "/bits" — bare IP обязан быть ошибкой парсинга, а не /32 по умолчанию.
        let yaml = r#"
rules:
  - "IP-SUFFIX,1.2.3.4,Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_ip("1.2.3.4"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert_eq!(res.skipped.len(), 1);
        assert_eq!(res.skipped[0].reason, "неверный IP-SUFFIX");
    }

    #[tokio::test]
    async fn ip_cidr_requires_explicit_bits_too() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-ipcidr-bare-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "IP-CIDR,1.2.3.4,Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_ip("1.2.3.4"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert_eq!(res.skipped.len(), 1);
        assert_eq!(res.skipped[0].reason, "неверный IP-CIDR");
    }

    #[tokio::test]
    async fn ip_cidr6_matches_ipv6_prefix() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-cidr6-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "IP-CIDR6,2001:db8::/32,V6Out"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_ip("2001:db8::1"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("V6Out"));
        let res_out = engine.evaluate(&ctx_ip("2001:db9::1"), &empty_resolver()).await;
        assert_eq!(res_out.outbound.as_deref(), Some("DIRECT"));
    }

    #[tokio::test]
    async fn domain_regex_with_embedded_commas_in_payload() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-regex-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        // DOMAIN-REGEX — один из типов с запятыми в payload (base.go::ParseRulePayload держит его
        // как единый кусок и восстанавливает join(",") между типом и целью).
        let yaml = r#"
rules:
  - 'DOMAIN-REGEX,^a{1,3}\.com$,Proxy'
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("aaa.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        let res_no = engine.evaluate(&ctx_domain("aaaa.com"), &empty_resolver()).await;
        assert_eq!(res_no.outbound.as_deref(), Some("DIRECT"));
    }

    #[tokio::test]
    async fn ruleset_no_resolve_scoping_inside_classical() {
        let dir = std::env::temp_dir().join(format!(
            "route-tester-mihomo-classical-noresolve-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(dir.join("rules")).await.unwrap();
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/mixed-classical.txt")),
            "DOMAIN-SUFFIX,example.org\nIP-CIDR,203.0.113.0/24\n",
        )
        .await;
        let yaml = r#"
rule-providers:
  mixed@classical: {type: http, format: text, behavior: classical, url: https://example.com/mixed-classical.txt}
rules:
  - "RULE-SET,mixed@classical,Mixed,no-resolve"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        // Доменное правило внутри classical не завязано на резолв вообще — no-resolve его не трогает.
        let res_domain = engine.evaluate(&ctx_domain("sub.example.org"), &empty_resolver()).await;
        assert_eq!(res_domain.outbound.as_deref(), Some("Mixed"));
        // IP-правило внутри classical при no-resolve не должно триггерить резолв домена — цель не
        // резолвится, DstIP невалиден, IP-CIDR не совпадает, RULE-SET уходит в NoMatch -> DIRECT.
        let mut map = Map::new();
        map.insert("lazy.example".to_string(), vec!["203.0.113.5".parse().unwrap()]);
        let resolver = StaticResolver(map);
        let res_ip = engine.evaluate(&ctx_domain("lazy.example"), &resolver).await;
        assert_eq!(res_ip.outbound.as_deref(), Some("DIRECT"));
        assert!(
            res_ip.resolved_ips.is_empty(),
            "no-resolve на RULE-SET не должен резолвить домен"
        );
    }

    #[test]
    fn split_top_level_groups_handles_nested_parens() {
        let groups = split_top_level_groups("((DOMAIN-SUFFIX,gql.twitch.tv),(DOMAIN-SUFFIX,usher.ttvnw.net))").unwrap();
        assert_eq!(
            groups,
            vec!["DOMAIN-SUFFIX,gql.twitch.tv", "DOMAIN-SUFFIX,usher.ttvnw.net"]
        );
    }

    #[test]
    fn split_top_level_groups_rejects_missing_paren() {
        assert!(split_top_level_groups("(DOMAIN-SUFFIX,x.com").is_err());
    }

    #[test]
    fn glob_match_handles_star_and_question_mark() {
        assert!(glob_match("*.example.com", "a.b.example.com"));
        assert!(glob_match("a?c.com", "abc.com"));
        assert!(!glob_match("a?c.com", "abcd.com"));
    }

    /// Формат портов как у `utils.NewUnsignedRanges` (`rules/common/port.go` делегирует туда):
    /// `,` и `/` — взаимозаменяемые разделители списка, `N-M` — диапазон.
    #[test]
    fn port_ranges_parses_slash_separated_lists_and_ranges() {
        let list = PortRanges::parse("2053/2083/2087/2096/8443").unwrap();
        assert!(list.check(2053));
        assert!(list.check(8443));
        assert!(!list.check(443));
        assert!(!list.check(2054));

        let ranges = PortRanges::parse("19200-19400/50000-50100").unwrap();
        assert!(ranges.check(19333));
        assert!(ranges.check(50100));
        assert!(!ranges.check(19199));
        assert!(!ranges.check(50101));
    }

    /// Мейнтейнерский сценарий: `discord@classical` из 8 строк, одна из них
    /// `PROCESS-NAME-REGEX` — не должна давать `Unknown` и засорять "Пропущено правил" для
    /// посторонней цели (google.com), но должна корректно матчить discord.com и UDP-диапазон.
    #[tokio::test]
    async fn classical_process_regex_line_does_not_poison_unrelated_targets() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-discord-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(dir.join("rules")).await.unwrap();
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/discord-classical.txt")),
            concat!(
                "PROCESS-NAME-REGEX,^([Dd]iscord(\\.exe)?|com\\.discord)$\n",
                "AND,((DOMAIN-KEYWORD,discord),(NOT,((DOMAIN-SUFFIX,ru))))\n",
                "AND,((RULE-SET,x@ipcidr,no-resolve),(NETWORK,TCP),(DST-PORT,2053/2083/2087/2096/8443))\n",
                "AND,((IP-CIDR,5.200.14.128/25,no-resolve),(NETWORK,UDP),(DST-PORT,19200-19400/50000-50100))\n",
                "DOMAIN-SUFFIX,discord.gg\n",
                "DOMAIN-SUFFIX,discordapp.com\n",
                "DOMAIN-SUFFIX,discordapp.net\n",
                "DOMAIN-SUFFIX,discord.media\n",
            ),
        )
        .await;
        write(
            &dir.join("rules"),
            &format!("{:x}", md5::compute("https://example.com/x-ipcidr.txt")),
            "1.1.1.0/24\n",
        )
        .await;
        let yaml = r#"
rule-providers:
  discord@classical: {type: http, format: text, behavior: classical, url: https://example.com/discord-classical.txt}
  x@ipcidr: {type: http, format: text, behavior: ipcidr, url: https://example.com/x-ipcidr.txt}
rules:
  - "RULE-SET,discord@classical,Discord"
  - "MATCH,Proxy"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();

        // Посторонняя цель: PROCESS-NAME-REGEX -> NoMatch, а не Unknown -> вся OR-цепочка
        // classical-провайдера NoMatch -> уходим до MATCH,Proxy, "Пропущено правил" пусто.
        let res = engine.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        assert!(
            res.skipped.is_empty(),
            "google.com не должен ничего пропускать: {:?}",
            res.skipped
        );

        // discord.com матчится веткой AND(DOMAIN-KEYWORD,NOT(DOMAIN-SUFFIX,ru)).
        let res = engine.evaluate(&ctx_domain("discord.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Discord"));
        assert!(res.skipped.is_empty());

        // IP в UDP-диапазоне из последней AND-ветки.
        let ctx = Ctx {
            target: super::super::Target::Ip("5.200.14.200".parse().unwrap()),
            port: 19333,
            network: Net::Udp,
            source_ip: None,
            inbound_tag: None,
        };
        let res = engine.evaluate(&ctx, &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Discord"));
        assert!(res.skipped.is_empty());
    }

    /// `PROCESS-NAME`/`UID` на верхнем уровне — NoMatch, а не Unknown: правило просто не
    /// срабатывает и не попадает в "Пропущено правил".
    #[tokio::test]
    async fn top_level_process_and_uid_rules_are_nomatch_not_skipped() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-proc-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "PROCESS-NAME,foo,DIRECT"
  - "PROCESS-NAME-REGEX,^foo$,DIRECT"
  - "PROCESS-PATH,/usr/bin/foo,DIRECT"
  - "PROCESS-PATH-REGEX,^/usr/bin/foo$,DIRECT"
  - "UID,1000-2000,DIRECT"
  - "MATCH,Proxy"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        assert_eq!(res.rule.unwrap().index, 5);
        assert!(
            res.skipped.is_empty(),
            "PROCESS-*/UID не должны попадать в skipped: {:?}",
            res.skipped
        );
    }

    /// `OR(PROCESS-NAME, DOMAIN-SUFFIX)` — ровно мейнтейнерский баг: раньше `Unknown` из
    /// PROCESS-NAME "побеждал" `NoMatch` от DOMAIN-SUFFIX и всё правило шло в skipped.
    #[tokio::test]
    async fn or_with_process_rule_and_nomatch_sibling_is_nomatch_not_unknown() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-or-proc-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "OR,((PROCESS-NAME,foo),(DOMAIN-SUFFIX,x.com)),Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("DIRECT"));
        assert!(res.skipped.is_empty());
    }

    /// `NOT(PROCESS-NAME)` инвертирует детерминированный NoMatch в Match — тоже без Unknown.
    #[tokio::test]
    async fn not_process_rule_inverts_nomatch_to_match() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-not-proc-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "NOT,((PROCESS-NAME,foo)),Proxy"
  - "MATCH,DIRECT"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();
        let res = engine.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("Proxy"));
        assert!(res.skipped.is_empty());
    }

    /// `PROCESS-*-REGEX`/`-WILDCARD` не сворачиваются в безусловный NoMatch: mihomo сравнивает
    /// паттерн с пустым `metadata.Process` буквально (`rules/common/process.go::Match`, без
    /// раннего `return false`), поэтому паттерн, матчащий пустую строку (`.*`, `*`), реально
    /// даёт `Match`. `component/wildcard.Match("*", "")` -> `true` (тот же код, что у
    /// DOMAIN-WILDCARD), обычный regex-движок аналогично матчит `.*` на "".
    #[tokio::test]
    async fn process_regex_and_wildcard_are_evaluated_against_empty_process_name() {
        let dir = std::env::temp_dir().join(format!("route-tester-mihomo-proc-re-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let yaml = r#"
rules:
  - "PROCESS-NAME-REGEX,.*,MatchAll"
  - "PROCESS-NAME-REGEX,^discord$,NoMatchDiscord"
  - "PROCESS-NAME-WILDCARD,*,MatchStar"
  - "PROCESS-NAME-WILDCARD,dis*,NoMatchDisStar"
  - "MATCH,Proxy"
"#;
        let engine = from_yaml_str(yaml, &dir).await.unwrap();

        // "PROCESS-NAME-REGEX,.*" матчит пустую строку -> первое правило само срабатывает.
        let res = engine.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        assert_eq!(res.outbound.as_deref(), Some("MatchAll"));
        assert!(res.skipped.is_empty());

        // Без правила ".*" (изолированно): "^discord$" не матчит "" -> NoMatch, не Unknown.
        let dir2 = std::env::temp_dir().join(format!("route-tester-mihomo-proc-re2-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir2).await.unwrap();
        let yaml2 = r#"
rules:
  - "PROCESS-NAME-REGEX,^discord$,NoMatchDiscord"
  - "PROCESS-NAME-WILDCARD,*,MatchStar"
  - "PROCESS-NAME-WILDCARD,dis*,NoMatchDisStar"
  - "MATCH,Proxy"
"#;
        let engine2 = from_yaml_str(yaml2, &dir2).await.unwrap();
        let res2 = engine2.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        // "^discord$" -> NoMatch, следующее правило "PROCESS-NAME-WILDCARD,*" матчит "" -> "MatchStar".
        assert_eq!(res2.outbound.as_deref(), Some("MatchStar"));
        assert!(res2.skipped.is_empty());

        // Изолируем "dis*" отдельно от "*", чтобы доказать, что оно само по себе NoMatch.
        let dir3 = std::env::temp_dir().join(format!("route-tester-mihomo-proc-re3-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir3).await.unwrap();
        let yaml3 = r#"
rules:
  - "PROCESS-NAME-REGEX,^discord$,NoMatchDiscord"
  - "PROCESS-NAME-WILDCARD,dis*,NoMatchDisStar"
  - "MATCH,Proxy"
"#;
        let engine3 = from_yaml_str(yaml3, &dir3).await.unwrap();
        let res3 = engine3.evaluate(&ctx_domain("google.com"), &empty_resolver()).await;
        assert_eq!(res3.outbound.as_deref(), Some("Proxy"));
        assert!(res3.skipped.is_empty());
    }
}
