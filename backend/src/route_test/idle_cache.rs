//! Обобщённый кэш с TTL простоя: значения живут `ttl` с момента последнего обращения, после чего
//! фоновый tokio-таск («реапер») их вычищает и сам завершается, когда кэш пустеет — вместо
//! вытеснения "по обращению" (проверка TTL только при следующем `get`/`insert`), которое не
//! освобождает память, если к записи больше никто не обращается. Реапер запускается лениво при
//! первой вставке и перезапускается следующей вставкой, если успел остановиться.
//!
//! Общий для всех кэшей `route_test` (`geodb.rs` — байты `.dat` и `maxminddb::Reader`; в будущем —
//! разобранные rule-providers mihomo), поэтому не содержит ничего специфичного для конкретного
//! потребителя: ключ и значение — параметры типа.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex};
use std::time::Duration;
// `tokio::time::Instant`, не `std::time::Instant`: без активного tokio-таймера ведёт себя как
// обычный wall-clock `Instant` (безопасно для синхронных вызовов и тестов без рантайма), но
// внутри `#[tokio::test(start_paused = true)]` синхронизирован с виртуальным временем — иначе
// `tokio::time::advance` в тестах не сдвигал бы `last_used.elapsed()` и TTL было бы нечем проверить.
use tokio::time::Instant;

struct Entry<V> {
    value: Arc<V>,
    last_used: Instant,
}

struct State<K, V> {
    map: HashMap<K, Entry<V>>,
    reaper_running: bool,
}

/// `K` — ключ (например `(PathBuf, SystemTime)` — путь + mtime файла, чтобы смена файла на диске
/// сама давала промах кэша), `V` — значение, отдаётся через `Arc`, не клонируется по значению.
pub struct IdleCache<K, V> {
    state: Arc<Mutex<State<K, V>>>,
    ttl: Duration,
}

impl<K, V> Clone for IdleCache<K, V> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            ttl: self.ttl,
        }
    }
}

impl<K, V> IdleCache<K, V>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    V: Send + Sync + 'static,
{
    pub fn new(ttl: Duration) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                map: HashMap::new(),
                reaper_running: false,
            })),
            ttl,
        }
    }

    /// Возвращает закэшированное значение, если оно есть, и обновляет время последнего обращения.
    pub fn get(&self, key: &K) -> Option<Arc<V>> {
        let mut state = self.state.lock().unwrap();
        state.map.get_mut(key).map(|e| {
            e.last_used = Instant::now();
            e.value.clone()
        })
    }

    /// Кладёт значение в кэш (не под блокировкой — вызывающий код должен готовить `value` ДО
    /// вызова `insert`, например прочитать файл, а не внутри критической секции) и лениво
    /// запускает фонового реапера, если тот не крутится.
    pub fn insert(&self, key: K, value: Arc<V>) {
        let need_spawn = {
            let mut state = self.state.lock().unwrap();
            state.map.insert(
                key,
                Entry {
                    value,
                    last_used: Instant::now(),
                },
            );
            if state.reaper_running {
                false
            } else {
                state.reaper_running = true;
                true
            }
        };
        if need_spawn {
            self.spawn_reaper();
        }
    }

    fn spawn_reaper(&self) {
        let state = self.state.clone();
        let ttl = self.ttl;
        let sweep_every = (ttl / 2).max(Duration::from_millis(50));
        let task = async move {
            loop {
                tokio::time::sleep(sweep_every).await;
                let mut state = state.lock().unwrap();
                state.map.retain(|_, e| e.last_used.elapsed() < ttl);
                if state.map.is_empty() {
                    // Тот же лок, что видит `insert` — гонки "реапер решил остановиться, а в это
                    // время что-то вставили" не будет: либо вставка попадёт в этот map ДО retain
                    // (map не пуст, реапер продолжает крутиться), либо ПОСЛЕ (тогда insert сам
                    // увидит reaper_running == false и перезапустит реапер).
                    state.reaper_running = false;
                    return;
                }
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(task);
            }
            Err(_) => {
                // Нет активного tokio-рантайма (например, синхронный юнит-тест) — фоновой очистки
                // не будет, но сам кэш работает; следующая `insert` из async-контекста запустит
                // реапер как обычно.
                self.state.lock().unwrap().reaper_running = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tokio::time::advance` под паузой продвигает часы только до ближайшего таймера за один
    /// вызов — чтобы разбуженный реапер успел реально выполниться (а не просто "проснуться"),
    /// продвигаем время маленькими шагами, отдавая исполнителю управление между ними.
    async fn advance_and_pump(total: Duration) {
        let step = Duration::from_millis(5);
        let mut done = Duration::ZERO;
        while done < total {
            tokio::time::advance(step).await;
            tokio::task::yield_now().await;
            done += step;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn evicts_after_ttl_idle() {
        let cache: IdleCache<&'static str, u32> = IdleCache::new(Duration::from_millis(100));
        cache.insert("a", Arc::new(1));
        assert_eq!(cache.get(&"a").map(|v| *v), Some(1));

        advance_and_pump(Duration::from_millis(150)).await;

        assert_eq!(
            cache.get(&"a"),
            None,
            "запись должна быть вытеснена по истечении TTL простоя"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn access_resets_idle_timer() {
        let cache: IdleCache<&'static str, u32> = IdleCache::new(Duration::from_millis(100));
        cache.insert("a", Arc::new(1));

        advance_and_pump(Duration::from_millis(60)).await;
        assert_eq!(
            cache.get(&"a").map(|v| *v),
            Some(1),
            "запись ещё не должна была вытесниться"
        );

        advance_and_pump(Duration::from_millis(60)).await;
        // С момента последнего get() прошло 60мс < ttl=100мс — запись должна быть жива.
        assert_eq!(
            cache.get(&"a").map(|v| *v),
            Some(1),
            "обращение должно было сбросить таймер простоя"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reaper_restarts_after_stopping_on_empty_cache() {
        let cache: IdleCache<&'static str, u32> = IdleCache::new(Duration::from_millis(50));
        cache.insert("a", Arc::new(1));

        advance_and_pump(Duration::from_millis(150)).await;
        assert_eq!(cache.get(&"a"), None);

        // Реапер должен был остановиться (кэш опустел). Новая вставка обязана его перезапустить.
        cache.insert("b", Arc::new(2));
        assert_eq!(cache.get(&"b").map(|v| *v), Some(2));

        advance_and_pump(Duration::from_millis(150)).await;
        assert_eq!(
            cache.get(&"b"),
            None,
            "перезапущенный реапер должен вытеснить вторую запись"
        );
    }

    #[test]
    fn works_without_a_tokio_runtime() {
        // geodb.rs зовёт кэш из синхронных функций, которые в юнит-тестах вызываются без рантайма —
        // insert/get не должны паниковать даже без фонового реапера.
        let cache: IdleCache<&'static str, u32> = IdleCache::new(Duration::from_secs(5));
        cache.insert("a", Arc::new(42));
        assert_eq!(cache.get(&"a").map(|v| *v), Some(42));
    }
}
