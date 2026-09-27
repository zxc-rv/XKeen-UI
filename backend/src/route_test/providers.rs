//! Rule-providers mihomo: разбор `rule-providers` из `config.yaml` (merge-key `<<`), загрузка
//! payload (inline/file/http, форматы text/yaml/mrs) и индексация под три поведения
//! (`domain`/`ipcidr`/`classical`). Кэш разобранных провайдеров ключуется по (путь, mtime) и
//! вытесняется через 5 минут простоя, чтобы память не росла бесконечно при частых запросах.
//!
//! Семантика соответствия — по `component/trie/domain_set.go` (`DomainSetBuilder`/`DomainSet::Has`)
//! и `rules/provider/{domain,ipcidr,classical}_strategy.go` ветки Alpha MetaCubeX/mihomo:
//! plain-домен матчится ТОЧНО (не как `DOMAIN-SUFFIX`), `.domain`/`+.domain` — как суффикс (`+.`
//! добавляет ещё и точное совпадение), `*.domain` — ровно один произвольный лейбл на месте `*`.
//!
//! Индексы `domain`/`ipcidr` построены как компактные арены (одна `Box<str>`/`Box<[T]>` на весь
//! набор + бинарный поиск) вместо `HashMap<String, String>`/`Vec<(Cidr, String)>` из первой
//! версии: на реальном конфиге роутера (44 rule-providers, ~400k записей суммарно) HashMap-подход
//! держал ~87 МБ RSS на данные, которые в компактном виде занимают на порядок меньше — служебные
//! поля `String`/`HashMap` (заголовок аллокации, паддинг, коэффициент заполнения hashbrown) на
//! запись стоили дороже самих данных. Строки при разборе берутся как `&str` из уже прочитанного
//! буфера (без промежуточного `Vec<String>` на каждую строку) и копируются один раз — в саму
//! арену.

use crate::route_test::cidr::{Cidr, Range};
use crate::route_test::dns::Resolver;
use crate::route_test::idle_cache::IdleCache;
use crate::route_test::mihomo::{EvalState, RuleKind, Verdict, parse_predicate};
use crate::ruleset_inspector;
use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};
use yaml_rust2::Yaml;
use yaml_rust2::yaml::Hash as YamlHash;

const CACHE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Behavior {
    Domain,
    IpCidr,
    Classical,
}

impl Behavior {
    fn as_mihomo_str(self) -> &'static str {
        match self {
            Behavior::Domain => "domain",
            Behavior::IpCidr => "ipcidr",
            Behavior::Classical => "classical",
        }
    }
}

/// Одна аллокация под множество коротких строк: конкатенированные байты и границы записей.
/// Экономит служебные поля, которые платит `String`/`HashMap` за отдельную запись (указатель,
/// длина и capacity аллокатора на каждую строку, плюс контрольные байты и незаполненные слоты
/// hashbrown) — при сотнях тысяч записей это доминирует над самими данными.
struct StrArena {
    data: Box<str>,
    offsets: Box<[u32]>,
}

impl Default for StrArena {
    fn default() -> Self {
        Self {
            data: Box::from(""),
            offsets: Box::from([0u32]),
        }
    }
}

/// Границы арены хранятся как `u32` (см. `StrArena`) — компактнее `usize`, но требует байтового
/// размера данных в пределах `u32::MAX`. На реальных провайдерах (единицы-десятки МБ) это на
/// порядки меньше лимита; проверка — просто защита от переполнения на кем-то подсунутом
/// гигантском провайдере, а не ожидаемый в проде путь.
fn check_arena_capacity(total_bytes: usize) -> Result<(), String> {
    if total_bytes > u32::MAX as usize {
        Err(format!(
            "провайдер слишком большой для компактного индекса ({total_bytes} байт > {} байт лимит), правила с ним пропущены",
            u32::MAX
        ))
    } else {
        Ok(())
    }
}

impl StrArena {
    /// Сортирует и дедуплицирует `items`, затем строит арену из `prefix + item` для каждой
    /// уникальной записи. Сортировка по «голому» значению (без `prefix`) даёт тот же порядок, что
    /// и по декорированному тексту — префикс общий для всех записей арены (`""` у `exact`, `"+."` у
    /// `plus`, `"."` у `suffix`), поэтому сравнение расходится только после него.
    fn from_sorted_dedup(mut items: Vec<Cow<'_, str>>, prefix: &str) -> Result<Self, String> {
        items.sort_unstable();
        items.dedup();
        let total: usize = items.iter().map(|s| prefix.len() + s.len()).sum();
        check_arena_capacity(total)?;
        let mut data = String::with_capacity(total);
        let mut offsets = Vec::with_capacity(items.len() + 1);
        offsets.push(0u32);
        for it in &items {
            data.push_str(prefix);
            data.push_str(it);
            offsets.push(data.len() as u32);
        }
        Ok(Self {
            data: data.into_boxed_str(),
            offsets: offsets.into_boxed_slice(),
        })
    }

    /// Строит арену, сохраняя порядок `items` как есть — для позиционного (без сортировки текста)
    /// хранения исходных строк ipcidr-диапазонов, уже упорядоченных вызывающим кодом по `start`.
    fn from_ordered<'a>(items: impl Iterator<Item = &'a str> + Clone) -> Result<Self, String> {
        let total: usize = items.clone().map(str::len).sum();
        check_arena_capacity(total)?;
        let mut data = String::with_capacity(total);
        let mut offsets = Vec::new();
        offsets.push(0u32);
        for it in items {
            data.push_str(it);
            offsets.push(data.len() as u32);
        }
        Ok(Self {
            data: data.into_boxed_str(),
            offsets: offsets.into_boxed_slice(),
        })
    }

    fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    fn get(&self, i: usize) -> &str {
        &self.data[self.offsets[i] as usize..self.offsets[i + 1] as usize]
    }

    /// Бинарный поиск точного совпадения (арена должна быть построена через `from_sorted_dedup`).
    fn binary_search(&self, needle: &str) -> Option<usize> {
        let mut lo = 0usize;
        let mut hi = self.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match self.get(mid).cmp(needle) {
                Ordering::Less => lo = mid + 1,
                Ordering::Greater => hi = mid,
                Ordering::Equal => return Some(mid),
            }
        }
        None
    }

    /// Как `binary_search`, но сравнивает `needle` с записью арены за вычетом первых `prefix_len`
    /// байт (записи вида `"+.example.com"`/`".example.com"`) — без аллокации декорированного ключа
    /// на каждый вызов.
    fn binary_search_stripped(&self, prefix_len: usize, needle: &str) -> Option<usize> {
        let mut lo = 0usize;
        let mut hi = self.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match self.get(mid)[prefix_len..].cmp(needle) {
                Ordering::Less => lo = mid + 1,
                Ordering::Greater => hi = mid,
                Ordering::Equal => return Some(mid),
            }
        }
        None
    }
}

/// Приводит `s` к нижнему регистру, только если в нём реально есть заглавные символы — реальные
/// списки (adlist/refilter и т.п.) уже в нижнем регистре, и лишняя аллокация на каждую из ~400k
/// строк при загрузке была бы чистыми потерями.
fn lower_cow(s: &str) -> Cow<'_, str> {
    if s.chars().any(char::is_uppercase) {
        Cow::Owned(s.to_lowercase())
    } else {
        Cow::Borrowed(s)
    }
}

/// Домен-индекс: точное совпадение, суффикс (строгий, без самого домена, включая `+.`-варианты) и
/// однолейбловый wildcard. `exact`/`plus`/`suffix` — арены декорированного текста (см. `StrArena`);
/// `detail` ответа получает готовый текст записи прямо из арены, без реконструкции на месте.
#[derive(Default)]
pub(crate) struct DomainProvider {
    exact: StrArena,
    plus: StrArena,
    suffix: StrArena,
    wildcard: Vec<Box<str>>,
}

/// Собирает `DomainProvider` из потока строк, храня их пока в виде `Cow<str>` (без аллокации для
/// уже-строчных данных, см. `lower_cow`) — окончательная (единственная на категорию) аллокация
/// происходит в `StrArena::from_sorted_dedup` при вызове `build`.
#[derive(Default)]
struct DomainBuilder<'a> {
    exact: Vec<Cow<'a, str>>,
    plus: Vec<Cow<'a, str>>,
    suffix: Vec<Cow<'a, str>>,
    wildcard: Vec<Cow<'a, str>>,
}

impl<'a> DomainBuilder<'a> {
    fn insert(&mut self, raw_line: &'a str) {
        let line = raw_line.trim();
        if line.is_empty() || line.contains('/') {
            return;
        }
        // Префиксы `+.`/`.`/wildcard `*` не содержат букв — проверяем их до приведения регистра,
        // на исходном срезе, чтобы не лишиться заимствования из буфера файла раньше времени.
        if let Some(rest) = line.strip_prefix("+.") {
            if !rest.is_empty() {
                self.plus.push(lower_cow(rest));
            }
        } else if let Some(rest) = line.strip_prefix('.') {
            if !rest.is_empty() {
                self.suffix.push(lower_cow(rest));
            }
        } else if line.contains('*') {
            let lower = lower_cow(line);
            if lower.split('.').all(|l| !l.is_empty()) {
                self.wildcard.push(lower);
            }
        } else {
            self.exact.push(lower_cow(line));
        }
    }

    fn build(self) -> Result<DomainProvider, String> {
        let mut wildcard: Vec<Box<str>> = {
            let mut w = self.wildcard;
            w.sort_unstable();
            w.dedup();
            w.into_iter().map(|c| Box::from(c.as_ref())).collect()
        };
        wildcard.shrink_to_fit();
        Ok(DomainProvider {
            exact: StrArena::from_sorted_dedup(self.exact, "")?,
            plus: StrArena::from_sorted_dedup(self.plus, "+.")?,
            suffix: StrArena::from_sorted_dedup(self.suffix, ".")?,
            wildcard,
        })
    }
}

impl DomainProvider {
    /// Возвращает исходный текст записи, под которую подпадает домен, если есть совпадение.
    /// Приоритет при нескольких подходящих паттернах (для `detail`, не для исхода Match/NoMatch —
    /// он не зависит от того, какая именно запись выбрана): `exact` > `plus`-точное > на каждом
    /// уровне суффикса `suffix` > `plus`-суффиксное > wildcard по лексикографическому порядку.
    pub(crate) fn matches(&self, domain: &str) -> Option<&str> {
        if let Some(i) = self.exact.binary_search(domain) {
            return Some(self.exact.get(i));
        }
        if let Some(i) = self.plus.binary_search_stripped(2, domain) {
            return Some(self.plus.get(i));
        }
        let mut rest = domain;
        while let Some(idx) = rest.find('.') {
            rest = &rest[idx + 1..];
            if rest.is_empty() {
                break;
            }
            if let Some(i) = self.suffix.binary_search_stripped(1, rest) {
                return Some(self.suffix.get(i));
            }
            if let Some(i) = self.plus.binary_search_stripped(2, rest) {
                return Some(self.plus.get(i));
            }
        }
        // `wildcard` отсортирован и дедуплицирован в `build` — при нескольких подходящих паттернах
        // побеждает первый в лексикографическом порядке.
        let labels: Vec<&str> = domain.split('.').collect();
        for pattern in &self.wildcard {
            let plabels: Vec<&str> = pattern.split('.').collect();
            if plabels.len() == labels.len() && plabels.iter().zip(labels.iter()).all(|(p, l)| *p == "*" || p == l) {
                return Some(pattern);
            }
        }
        None
    }
}

/// ipcidr-индекс: отдельные отсортированные массивы диапазонов для v4/v6 (семейства адресов никогда
/// не пересекаются, см. `cidr.rs`). Проверка «покрывает ли хоть один диапазон точку `ip`» сделана
/// через префиксные максимумы (`prefix_max_end`/`prefix_max_idx`): диапазон, дающий максимум конца
/// среди всех записей с `start <= ip`, гарантированно и сам имеет `start <= ip` — так что если этот
/// максимум `>= ip`, диапазон покрывает `ip`, а если нет — не покрывает и ни один другой (у него
/// конец не меньше). Работает корректно даже при вложенных/пересекающихся диапазонах, без явного
/// слияния интервалов и без потери исходного текста конкретной сработавшей записи.
struct RangeIndex<T> {
    starts: Box<[T]>,
    prefix_max_end: Box<[T]>,
    prefix_max_idx: Box<[u32]>,
    text: StrArena,
}

impl<T> Default for RangeIndex<T> {
    fn default() -> Self {
        Self {
            starts: Box::from([]),
            prefix_max_end: Box::from([]),
            prefix_max_idx: Box::from([]),
            text: StrArena::default(),
        }
    }
}

impl<T: Copy + Ord> RangeIndex<T> {
    /// `entries` — (начало, конец, исходный текст записи), уже замаскированные по `bits` (см.
    /// `Cidr::to_range`). Дедуплицирует точные повторы (одинаковый диапазон), сохраняя текст первой
    /// встреченной записи — сортировка стабильна специально ради этого.
    fn build(mut entries: Vec<(T, T, &str)>) -> Result<Self, String> {
        entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        entries.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
        let mut starts = Vec::with_capacity(entries.len());
        let mut prefix_max_end = Vec::with_capacity(entries.len());
        let mut prefix_max_idx = Vec::with_capacity(entries.len());
        let mut running: Option<(T, u32)> = None;
        for (i, (start, end, _)) in entries.iter().enumerate() {
            starts.push(*start);
            running = Some(match running {
                Some((max_end, max_idx)) if max_end >= *end => (max_end, max_idx),
                _ => (*end, i as u32),
            });
            let (max_end, max_idx) = running.expect("only just set to Some above");
            prefix_max_end.push(max_end);
            prefix_max_idx.push(max_idx);
        }
        let text = StrArena::from_ordered(entries.iter().map(|(_, _, t)| *t))?;
        Ok(Self {
            starts: starts.into_boxed_slice(),
            prefix_max_end: prefix_max_end.into_boxed_slice(),
            prefix_max_idx: prefix_max_idx.into_boxed_slice(),
            text,
        })
    }

    /// При нескольких перекрывающихся/вложенных диапазонах, содержащих `ip`, `detail` сообщает про
    /// диапазон с максимальным концом (см. doc-комментарий структуры), а не про первый по файлу —
    /// на исход Match/NoMatch порядок не влияет.
    fn matches(&self, ip: T) -> Option<&str> {
        let idx = self.starts.partition_point(|&s| s <= ip);
        if idx == 0 {
            return None;
        }
        if self.prefix_max_end[idx - 1] < ip {
            return None;
        }
        Some(self.text.get(self.prefix_max_idx[idx - 1] as usize))
    }
}

#[derive(Default)]
pub(crate) struct IpCidrProvider {
    v4: RangeIndex<u32>,
    v6: RangeIndex<u128>,
}

#[derive(Default)]
struct IpCidrBuilder<'a> {
    v4: Vec<(u32, u32, &'a str)>,
    v6: Vec<(u128, u128, &'a str)>,
}

impl<'a> IpCidrBuilder<'a> {
    fn insert(&mut self, raw_line: &'a str) {
        let trimmed = raw_line.trim();
        let Some(cidr) = Cidr::parse(trimmed) else {
            return;
        };
        match cidr.to_range() {
            Range::V4(start, end) => self.v4.push((start, end, trimmed)),
            Range::V6(start, end) => self.v6.push((start, end, trimmed)),
        }
    }

    fn build(self) -> Result<IpCidrProvider, String> {
        Ok(IpCidrProvider {
            v4: RangeIndex::build(self.v4)?,
            v6: RangeIndex::build(self.v6)?,
        })
    }
}

impl IpCidrProvider {
    /// Возвращает исходный текст записи, под которую подпадает IP, если есть совпадение.
    pub(crate) fn matches(&self, ip: IpAddr) -> Option<&str> {
        match ip {
            IpAddr::V4(v4) => self.v4.matches(u32::from(v4)),
            IpAddr::V6(v6) => self.v6.matches(u128::from(v6)),
        }
    }
}

/// `classical`-провайдер: список строк вида `TYPE,PAYLOAD[,params]` (без цели, см.
/// `classicalStrategy.payloadToRule` в mihomo — `needTarget=false`), объединённых через OR.
/// Храним рядом исходный текст записи — используется в `detail` ответа при совпадении. Такие
/// провайдеры (`user@classical`, `localnet@classical` и т.п.) на практике — десятки-сотни строк,
/// а не сотни тысяч, поэтому арена здесь не нужна: `RuleKind` всё равно держит свои собственные
/// разобранные поля отдельно от текста.
#[derive(Default)]
pub(crate) struct ClassicalProvider {
    pub(crate) rules: Vec<(RuleKind, String)>,
}

impl ClassicalProvider {
    /// Возвращает исход и (при совпадении) исходный текст сработавшей строки провайдера.
    pub(crate) async fn matches<R: Resolver>(&self, eval: &mut EvalState<'_, R>) -> (Verdict, Option<String>) {
        let mut saw_unknown: Option<String> = None;
        for (rule, text) in &self.rules {
            match crate::route_test::mihomo::eval_predicate(rule, eval).await {
                Verdict::Match => return (Verdict::Match, Some(text.clone())),
                Verdict::Unknown(reason) => {
                    if saw_unknown.is_none() {
                        saw_unknown = Some(reason);
                    }
                }
                Verdict::NoMatch => {}
            }
        }
        match saw_unknown {
            Some(reason) => (Verdict::Unknown(reason), None),
            None => (Verdict::NoMatch, None),
        }
    }
}

pub(crate) enum ParsedProvider {
    Domain(DomainProvider),
    IpCidr(IpCidrProvider),
    Classical(ClassicalProvider),
}

fn parse_provider_content(content: &str, behavior: Behavior) -> Result<ParsedProvider, String> {
    let trimmed = content.trim_start();
    let looks_like_yaml_key = trimmed.starts_with("payload:") || trimmed.starts_with("rules:");
    if looks_like_yaml_key
        && let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(content)
        && let Some(doc) = docs.first()
    {
        let arr = if !doc["payload"].is_badvalue() {
            doc["payload"].as_vec()
        } else {
            doc["rules"].as_vec()
        };
        if let Some(arr) = arr {
            // `v.as_str()` заимствует из `doc`/`docs` — они живут только до конца этого блока,
            // поэтому строки разбираются в структуры (которые копируют нужные байты в свои арены)
            // прямо здесь же, не выходя за пределы области видимости `docs`.
            return build_from_lines(arr.iter().filter_map(|v| v.as_str()), behavior);
        }
    }
    let lines = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"));
    build_from_lines(lines, behavior)
}

/// Строит итоговую структуру провайдера из потока строк-правил, заимствованных из исходного
/// буфера — без промежуточного `Vec<String>` на все строки сразу (см. doc-комментарий модуля).
/// Ошибка — только от переполнения компактного индекса (см. `check_arena_capacity`); вызывающий
/// код превращает её в тот же путь "провайдер недоступен + warning", что и ошибку чтения файла.
fn build_from_lines<'a>(lines: impl Iterator<Item = &'a str>, behavior: Behavior) -> Result<ParsedProvider, String> {
    match behavior {
        Behavior::Domain => {
            let mut b = DomainBuilder::default();
            for line in lines {
                b.insert(line);
            }
            Ok(ParsedProvider::Domain(b.build()?))
        }
        Behavior::IpCidr => {
            let mut b = IpCidrBuilder::default();
            for line in lines {
                b.insert(line);
            }
            Ok(ParsedProvider::IpCidr(b.build()?))
        }
        Behavior::Classical => {
            let mut p = ClassicalProvider::default();
            for line in lines {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(node) = parse_predicate(line) {
                    p.rules.push((node, line.to_string()));
                }
            }
            Ok(ParsedProvider::Classical(p))
        }
    }
}

/// Разрешает merge-key `<<` (одна мэппинг-запись или список мэппингов), явные ключи побеждают.
/// Псевдонимы (`*anchor`) yaml-rust2 уже разворачивает в клон исходного узла до этой функции.
fn resolve_merge(raw: &YamlHash) -> YamlHash {
    let merge_key = Yaml::String("<<".to_string());
    let mut merged = YamlHash::new();
    if let Some(merge_val) = raw.get(&merge_key) {
        match merge_val {
            Yaml::Hash(h) => {
                for (k, v) in h {
                    merged.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
            Yaml::Array(items) => {
                for item in items {
                    if let Yaml::Hash(h) = item {
                        for (k, v) in h {
                            merged.entry(k.clone()).or_insert_with(|| v.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for (k, v) in raw {
        if k == &merge_key {
            continue;
        }
        merged.insert(k.clone(), v.clone());
    }
    merged
}

enum Vehicle {
    Inline(Vec<String>),
    Path(String),
    /// Явно объявлен http/file, но не хватает `url`/`path` (напр. якорь-заготовка) — не ошибка,
    /// просто нечем пользоваться.
    Unusable,
}

pub(crate) struct ProviderDef {
    pub(crate) behavior: Behavior,
    format_mrs: bool,
    vehicle: Vehicle,
}

/// Разбирает мэппинг `rule-providers` верхнего уровня конфига (уже с учётом `<<`).
pub(crate) fn parse_provider_defs(rule_providers: &Yaml, base_dir: &Path) -> HashMap<String, ProviderDef> {
    let mut out = HashMap::new();
    let Some(map) = rule_providers.as_hash() else {
        return out;
    };
    for (name_yaml, raw_def) in map {
        let Some(name) = name_yaml.as_str() else { continue };
        let Yaml::Hash(raw_hash) = raw_def else { continue };
        let merged = resolve_merge(raw_hash);
        let get = |key: &str| -> Option<String> {
            merged
                .get(&Yaml::String(key.to_string()))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        };

        let Some(behavior) = get("behavior").and_then(|b| match b.as_str() {
            "domain" => Some(Behavior::Domain),
            "ipcidr" => Some(Behavior::IpCidr),
            "classical" => Some(Behavior::Classical),
            _ => None,
        }) else {
            continue;
        };
        let format = get("format").unwrap_or_default();
        let format_mrs = format.eq_ignore_ascii_case("mrs");

        let vtype = get("type").unwrap_or_default();
        let vehicle = match vtype.as_str() {
            "inline" => {
                let payload = merged
                    .get(&Yaml::String("payload".to_string()))
                    .and_then(|v| v.as_vec())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if payload.is_empty() {
                    Vehicle::Unusable
                } else {
                    Vehicle::Inline(payload)
                }
            }
            "file" => match get("path") {
                Some(p) => Vehicle::Path(ruleset_inspector::resolve_provider_path_in(
                    &p,
                    &base_dir.to_string_lossy(),
                )),
                None => Vehicle::Unusable,
            },
            "http" => {
                let url = get("url");
                let path = get("path");
                match (path, url) {
                    (Some(p), _) => Vehicle::Path(ruleset_inspector::resolve_provider_path_in(
                        &p,
                        &base_dir.to_string_lossy(),
                    )),
                    (None, Some(u)) => Vehicle::Path(format!("{}/rules/{:x}", base_dir.display(), md5::compute(&u))),
                    (None, None) => Vehicle::Unusable,
                }
            }
            _ => Vehicle::Unusable,
        };

        out.insert(
            name.to_string(),
            ProviderDef {
                behavior,
                format_mrs,
                vehicle,
            },
        );
    }
    out
}

/// Кэш разобранных провайдеров по (путь, mtime) — общий `IdleCache` (см. `idle_cache.rs`), тот же,
/// что и `geodb.rs` использует для `.dat`/`.mmdb`. Смена mtime сама даёт промах (новый ключ), фоновый
/// реапер вытесняет записи без обращений 5 минут.
type ProviderCacheKey = (PathBuf, SystemTime);
static PROVIDER_CACHE: LazyLock<IdleCache<ProviderCacheKey, ParsedProvider>> =
    LazyLock::new(|| IdleCache::new(CACHE_TTL));

/// Загружает и разбирает провайдер, используя кэш по (путь, mtime). Инлайн-провайдеры (без файла)
/// в общий кэш не кладутся — они и так строятся один раз на загрузку движка. Конвертация `.mrs`/
/// чтение файла происходит ДО обращения к кэшу — `IdleCache::insert` не держит блокировку на время
/// IO. Параллельный промах на один и тот же ключ может привести к повторной загрузке — это
/// допустимо (см. `idle_cache.rs`), не пытаемся её схлопывать через single-flight.
async fn load_from_path(path: &str, behavior: Behavior, mrs_behavior: bool) -> Result<Arc<ParsedProvider>, String> {
    let path_buf = PathBuf::from(path);
    let mtime = tokio::fs::metadata(&path_buf)
        .await
        .map_err(|e| format!("файл не найден: {e}"))?
        .modified()
        .map_err(|e| format!("нет mtime: {e}"))?;
    let key = (path_buf, mtime);

    if let Some(cached) = PROVIDER_CACHE.get(&key) {
        return Ok(cached);
    }

    let content = if mrs_behavior {
        ruleset_inspector::convert_mrs(path, behavior.as_mihomo_str()).await?
    } else {
        tokio::fs::read_to_string(&key.0)
            .await
            .map_err(|e| format!("ошибка чтения: {e}"))?
    };
    let parsed = Arc::new(parse_provider_content(&content, behavior)?);
    PROVIDER_CACHE.insert(key, parsed.clone());
    Ok(parsed)
}

/// Все провайдеры, на которые реально ссылаются правила конфига — держим готовые структуры (не
/// только определения), плюс список имён, недоступных для использования (для варнингов).
pub(crate) struct Providers {
    loaded: HashMap<String, Arc<ParsedProvider>>,
    unusable: HashMap<String, String>,
}

impl Providers {
    pub(crate) async fn load(defs: HashMap<String, ProviderDef>) -> Self {
        let mut loaded = HashMap::new();
        let mut unusable = HashMap::new();
        for (name, def) in defs {
            match def.vehicle {
                Vehicle::Unusable => {
                    unusable.insert(name, "провайдер без url/path/payload".to_string());
                }
                Vehicle::Inline(payload) => {
                    let content = payload.join("\n");
                    match parse_provider_content(&content, def.behavior) {
                        Ok(p) => {
                            loaded.insert(name, Arc::new(p));
                        }
                        Err(e) => {
                            unusable.insert(name, e);
                        }
                    }
                }
                Vehicle::Path(path) => match load_from_path(&path, def.behavior, def.format_mrs).await {
                    Ok(p) => {
                        loaded.insert(name, p);
                    }
                    Err(e) => {
                        unusable.insert(name, e);
                    }
                },
            }
        }
        Self { loaded, unusable }
    }

    pub(crate) fn get(&self, name: &str) -> Option<&ParsedProvider> {
        self.loaded.get(name).map(|a| a.as_ref())
    }

    pub(crate) fn unusable_reason(&self, name: &str) -> Option<&str> {
        self.unusable.get(name).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn domain_provider(lines: &[&str]) -> DomainProvider {
        let mut b = DomainBuilder::default();
        for l in lines {
            b.insert(l);
        }
        b.build().expect("test data fits the compact index")
    }

    fn ipcidr_provider(lines: &[&str]) -> IpCidrProvider {
        let mut b = IpCidrBuilder::default();
        for l in lines {
            b.insert(l);
        }
        b.build().expect("test data fits the compact index")
    }

    #[test]
    fn domain_empty_provider_matches_nothing() {
        let p = domain_provider(&[]);
        assert_eq!(p.matches("example.com"), None);
    }

    #[test]
    fn domain_plain_matches_exact_only() {
        let p = domain_provider(&["example.com"]);
        assert_eq!(p.matches("example.com"), Some("example.com"));
        assert_eq!(
            p.matches("sub.example.com"),
            None,
            "plain-домен не должен матчить как суффикс"
        );
    }

    #[test]
    fn domain_dot_prefix_matches_suffix_but_not_exact() {
        let p = domain_provider(&[".example.com"]);
        assert_eq!(p.matches("sub.example.com"), Some(".example.com"));
        assert_eq!(
            p.matches("example.com"),
            None,
            "`.x` — строгий суффикс, сам домен не должен матчиться"
        );
    }

    #[test]
    fn domain_plus_prefix_matches_exact_and_suffix() {
        let p = domain_provider(&["+.example.com"]);
        assert_eq!(p.matches("example.com"), Some("+.example.com"));
        assert_eq!(p.matches("sub.example.com"), Some("+.example.com"));
        assert_eq!(p.matches("deep.sub.example.com"), Some("+.example.com"));
        assert_eq!(p.matches("notexample.com"), None);
    }

    #[test]
    fn domain_wildcard_matches_single_label() {
        let p = domain_provider(&["*.stream.example.com"]);
        assert_eq!(p.matches("a.stream.example.com"), Some("*.stream.example.com"));
        assert_eq!(
            p.matches("a.b.stream.example.com"),
            None,
            "wildcard — ровно один лейбл на месте `*`"
        );
    }

    #[test]
    fn domain_wildcard_with_empty_label_is_dropped() {
        let p = domain_provider(&["*..com"]);
        assert_eq!(p.matches("a..com"), None);
    }

    #[test]
    fn domain_case_insensitive_and_deduplicated() {
        let p = domain_provider(&["Example.COM", "example.com", "EXAMPLE.com"]);
        assert_eq!(p.matches("example.com"), Some("example.com"));
    }

    #[test]
    fn domain_trailing_dot_in_pattern_is_not_stripped() {
        // Как и в исходной реализации: пробел/регистр у строки провайдера нормализуются, но
        // завершающая точка — нет (её нет и у нормализованной цели, см. mod.rs), поэтому такая
        // запись эффективно никогда не сработает. Поведение сохранено намеренно, не как баг.
        let p = domain_provider(&["example.com."]);
        assert_eq!(p.matches("example.com"), None);
    }

    #[test]
    fn domain_entries_with_slash_are_ignored() {
        let p = domain_provider(&["1.2.3.0/24"]);
        assert_eq!(p.matches("1.2.3.0/24"), None);
    }

    #[test]
    fn domain_bare_prefix_marker_is_skipped() {
        let p = domain_provider(&["+.", "."]);
        assert_eq!(p.matches(""), None);
        assert_eq!(p.matches("anything.com"), None);
    }

    #[test]
    fn ipcidr_empty_provider_matches_nothing() {
        let p = ipcidr_provider(&[]);
        assert_eq!(p.matches("1.2.3.4".parse().unwrap()), None);
    }

    #[test]
    fn ipcidr_v4_and_v6_never_cross_families() {
        let p = ipcidr_provider(&["10.0.0.0/8", "2001:db8::/32"]);
        assert_eq!(p.matches("10.1.2.3".parse().unwrap()), Some("10.0.0.0/8"));
        assert_eq!(p.matches("2001:db8::1".parse().unwrap()), Some("2001:db8::/32"));
        assert_eq!(
            p.matches("::ffff:10.1.2.3".parse().unwrap()),
            None,
            "v4-mapped v6 не должен матчить v4-префикс"
        );
    }

    #[test]
    fn ipcidr_deduplicates_identical_ranges_keeping_first_text() {
        let p = ipcidr_provider(&["10.0.0.0/8", "10.0.0.0/8"]);
        assert_eq!(p.matches("10.1.1.1".parse().unwrap()), Some("10.0.0.0/8"));
    }

    #[test]
    fn ipcidr_nested_ranges_both_match_by_containment() {
        let p = ipcidr_provider(&["10.0.0.0/8", "10.1.0.0/16"]);
        assert!(p.matches("10.1.5.5".parse().unwrap()).is_some());
        assert_eq!(p.matches("10.2.0.0".parse().unwrap()), Some("10.0.0.0/8"));
        assert_eq!(p.matches("192.168.0.1".parse().unwrap()), None);
    }

    #[test]
    fn domain_exact_wins_over_plus_prefix_for_same_text() {
        // Пин порядка приоритета: `exact` проверяется раньше `plus`, даже если оба паттерна дают
        // Match на один и тот же домен.
        let p = domain_provider(&["+.example.com", "example.com"]);
        assert_eq!(p.matches("example.com"), Some("example.com"));
    }

    #[test]
    fn domain_dot_suffix_wins_over_plus_suffix_at_same_level() {
        // Пин порядка приоритета: на каждом уровне суффикса `suffix` проверяется раньше `plus`.
        let p = domain_provider(&[".example.com", "+.example.com"]);
        assert_eq!(p.matches("sub.example.com"), Some(".example.com"));
    }

    #[test]
    fn domain_two_wildcards_pick_lexicographically_first() {
        // Оба паттерна матчат "a.b.com"; побеждает первый по сортировке (`*` < `a` по байту).
        let p = domain_provider(&["a.*.com", "*.b.com"]);
        assert_eq!(p.matches("a.b.com"), Some("*.b.com"));
    }

    #[test]
    fn ipcidr_nested_ranges_detail_reports_widest_max_end_range() {
        // Пин порядка приоритета: старый линейный `Vec::find` в порядке файла отдал бы первую
        // строку ("10.1.0.0/16"); компактный индекс отдаёт диапазон с максимальным концом среди
        // подходящих ("10.0.0.0/9") — см. doc-комментарий `RangeIndex::matches`.
        let p = ipcidr_provider(&["10.1.0.0/16", "10.0.0.0/9"]);
        assert_eq!(p.matches("10.1.5.5".parse().unwrap()), Some("10.0.0.0/9"));
    }

    #[test]
    fn ipcidr_invalid_lines_are_skipped() {
        let p = ipcidr_provider(&["not-a-cidr", "1.2.3.4"]);
        assert_eq!(
            p.matches("1.2.3.4".parse().unwrap()),
            None,
            "без /bits — не ipcidr-запись"
        );
    }

    #[test]
    fn str_arena_binary_search_stripped_matches_decorated_entries() {
        let items: Vec<Cow<str>> = vec![Cow::Borrowed("a.com"), Cow::Borrowed("b.com")];
        let arena = StrArena::from_sorted_dedup(items, "+.").unwrap();
        assert_eq!(arena.get(arena.binary_search_stripped(2, "a.com").unwrap()), "+.a.com");
        assert!(arena.binary_search_stripped(2, "c.com").is_none());
    }

    #[test]
    fn str_arena_rejects_data_larger_than_u32_offsets_can_address() {
        assert!(check_arena_capacity(u32::MAX as usize).is_ok());
        assert!(check_arena_capacity(u32::MAX as usize + 1).is_err());
    }

    // --- property-style тесты: детерминированный PRNG (без новых зависимостей), сверка с наивным
    // эталоном, реализующим задокументированную семантику напрямую, без арен/бинарного поиска. ---

    /// xorshift64* — маленький детерминированный генератор для property-тестов, без внешних крейтов.
    struct Rng(u64);

    impl Rng {
        fn new(seed: u64) -> Self {
            Self(seed | 1) // не даём стартовать с нуля — xorshift застревает в нём
        }

        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next_u64() % n as u64) as usize
        }
    }

    fn random_label(rng: &mut Rng) -> String {
        const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
        let len = 1 + rng.below(4);
        (0..len).map(|_| ALPHABET[rng.below(ALPHABET.len())] as char).collect()
    }

    fn random_domain(rng: &mut Rng, max_labels: usize) -> String {
        let n = 1 + rng.below(max_labels);
        (0..n).map(|_| random_label(rng)).collect::<Vec<_>>().join(".")
    }

    /// Наивный эталон — прямая реализация задокументированной семантики (doc-комментарий модуля),
    /// без арен и бинарного поиска, для сверки boolean-исхода с `DomainProvider::matches`.
    fn naive_domain_pattern_matches(pattern: &str, domain: &str) -> bool {
        let line = pattern.trim();
        if line.is_empty() || line.contains('/') {
            return false;
        }
        let lower = line.to_lowercase();
        if let Some(rest) = lower.strip_prefix("+.") {
            !rest.is_empty()
                && (domain == rest || (domain.ends_with(rest) && domain[..domain.len() - rest.len()].ends_with('.')))
        } else if let Some(rest) = lower.strip_prefix('.') {
            !rest.is_empty() && domain.ends_with(rest) && domain[..domain.len() - rest.len()].ends_with('.')
        } else if lower.contains('*') {
            let plabels: Vec<&str> = lower.split('.').collect();
            if plabels.iter().any(|l| l.is_empty()) {
                return false;
            }
            let dlabels: Vec<&str> = domain.split('.').collect();
            plabels.len() == dlabels.len() && plabels.iter().zip(dlabels.iter()).all(|(p, d)| *p == "*" || p == d)
        } else {
            domain == lower
        }
    }

    fn naive_domain_match(patterns: &[String], domain: &str) -> bool {
        patterns.iter().any(|p| naive_domain_pattern_matches(p, domain))
    }

    #[test]
    fn domain_property_matches_naive_reference_and_detail_is_valid() {
        let mut rng = Rng::new(0xD1CE_5EED);
        for _ in 0..300 {
            let pattern_count = 1 + rng.below(8);
            let mut patterns: Vec<String> = Vec::with_capacity(pattern_count);
            for _ in 0..pattern_count {
                let base = random_domain(&mut rng, 3);
                patterns.push(match rng.below(4) {
                    0 => base,
                    1 => format!(".{base}"),
                    2 => format!("+.{base}"),
                    _ => {
                        let mut labels: Vec<String> = base.split('.').map(String::from).collect();
                        let idx = rng.below(labels.len());
                        labels[idx] = "*".to_string();
                        labels.join(".")
                    }
                });
            }
            let refs: Vec<&str> = patterns.iter().map(String::as_str).collect();
            let provider = domain_provider(&refs);

            for _ in 0..10 {
                // Половина запросов — полностью случайные (в основном NoMatch), половина —
                // выведенные из существующего паттерна (чтобы регулярно попадать в Match).
                let query = if rng.below(2) == 0 {
                    random_domain(&mut rng, 3)
                } else {
                    let src = &patterns[rng.below(patterns.len())];
                    let stripped = src.strip_prefix("+.").or_else(|| src.strip_prefix('.')).unwrap_or(src);
                    let label = random_label(&mut rng);
                    stripped.replace('*', &label)
                };

                let expected = naive_domain_match(&patterns, &query);
                let got = provider.matches(&query);
                assert_eq!(
                    got.is_some(),
                    expected,
                    "boolean-исход разошёлся: patterns={patterns:?} query={query:?}"
                );
                if let Some(detail) = got {
                    assert!(
                        naive_domain_pattern_matches(detail, &query),
                        "detail {detail:?} сам не матчит query {query:?} (patterns={patterns:?})"
                    );
                }
            }
        }
    }

    fn random_cidr_v4(rng: &mut Rng) -> String {
        let addr = std::net::Ipv4Addr::from(rng.next_u64() as u32);
        let bits = rng.below(33);
        format!("{addr}/{bits}")
    }

    fn random_cidr_v6(rng: &mut Rng) -> String {
        let hi = (rng.next_u64() as u128) << 64;
        let addr = std::net::Ipv6Addr::from(hi | rng.next_u64() as u128);
        let bits = rng.below(129);
        format!("{addr}/{bits}")
    }

    /// Наивный эталон для ipcidr: линейный перебор через уже отдельно протестированный
    /// `Cidr::parse`/`Cidr::contains` (`cidr.rs`) — независимая от `RangeIndex` реализация того же
    /// документированного правила «точка внутри хотя бы одного диапазона».
    fn naive_ipcidr_match(patterns: &[String], ip: IpAddr) -> bool {
        patterns
            .iter()
            .any(|p| Cidr::parse(p.trim()).is_some_and(|c| c.contains(ip)))
    }

    #[test]
    fn ipcidr_property_matches_naive_reference_and_detail_is_valid() {
        let mut rng = Rng::new(0xC1DE_1234_5678_9ABC);
        for _ in 0..300 {
            let pattern_count = 1 + rng.below(8);
            let mut patterns: Vec<String> = Vec::with_capacity(pattern_count);
            for _ in 0..pattern_count {
                patterns.push(if rng.below(2) == 0 {
                    random_cidr_v4(&mut rng)
                } else {
                    random_cidr_v6(&mut rng)
                });
            }
            let refs: Vec<&str> = patterns.iter().map(String::as_str).collect();
            let provider = ipcidr_provider(&refs);

            for _ in 0..10 {
                // Половина запросов выведена из адреса существующего паттерна (чтобы регулярно
                // попадать в Match), половина — полностью случайная того же семейства.
                let use_existing = rng.below(2) == 0;
                let want_v4 = rng.below(2) == 0;
                let ip: IpAddr = if use_existing {
                    let c = Cidr::parse(patterns[rng.below(patterns.len())].trim()).unwrap();
                    c.net
                } else if want_v4 {
                    IpAddr::V4(std::net::Ipv4Addr::from(rng.next_u64() as u32))
                } else {
                    let hi = (rng.next_u64() as u128) << 64;
                    IpAddr::V6(std::net::Ipv6Addr::from(hi | rng.next_u64() as u128))
                };

                let expected = naive_ipcidr_match(&patterns, ip);
                let got = provider.matches(ip);
                assert_eq!(
                    got.is_some(),
                    expected,
                    "boolean-исход разошёлся: patterns={patterns:?} ip={ip}"
                );
                if let Some(detail) = got {
                    let c = Cidr::parse(detail.trim()).expect("detail должен быть валидной cidr-строкой");
                    assert!(
                        c.contains(ip),
                        "detail {detail:?} сам не содержит ip {ip} (patterns={patterns:?})"
                    );
                }
            }
        }
    }
}
