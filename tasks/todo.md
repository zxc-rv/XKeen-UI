# Аудит: оптимизация работоспособности + качество кода — ВЫПОЛНЕНО

Ветка: `feature/optimization` (от `main` = 564a38e), коммит `142caab`. Не запушена.
Аудит: 41 агент (6 ревью-направлений + адверсариальная проверка), 13 подтверждено / 22 отклонено.
Имплементация: 9 агентов (7 фиксов + 2 верификатора) + 2 ручных дофикса.

## Сделано (12 фиксов)

- [x] vite.config.ts — удалены manualChunks 'markdown' и 'motion' (react-markdown 45KB ушёл в lazy Update-чанк; domMax 27KB — в lazy motion-features)
- [x] App.tsx — framer-motion убран из entry, фейд login↔app на CSS (250ms, mode='wait' семантика)
- [x] toast.tsx + lib/motion-features.ts — LazyMotion async features
- [x] globals.css — явные @font-face, выпилены greek/vietnamese (~66KB из бинаря)
- [x] Selectors.tsx — стабильный key у SelectorCombobox + сброс open при collapse
- [x] updater.rs — RAM-порог 50→8MB; ELF magic + >1MB перед заменой бинаря; HTML-guard на прямом URL
- [x] configs.rs — атомарная запись (tmp+fsync+rename) + tokio::fs во всех 4 хендлерах
- [x] controller.rs — tokio::fs / spawn_blocking
- [x] auth.rs — BRUTE_CACHE retain-свип (TTL = LOCKOUT_SECS×2)
- [x] api_relay.rs — WS connect timeout 10s (оба транспорта)
- [x] geo.rs — DoH per-request timeout 5s
- [x] version.rs — subprocess timeout 5s

## Результат

- Eager JS: 179.6 → 109.7 KB gz (−39%); markdown-чанк и domMax больше не грузятся при старте
- Верификация: cargo check чистый (podman rust:slim); bun build ok; lint — 0 ошибок в изменённых файлах (7 pre-existing в чужих)
- UI/UX не изменён (фейд, тосты, комбобоксы — идентичное поведение)

## Не делалось (отклонено верификаторами как микро/неверное)

per-line аллокации logger/websocket, reqwest::Client per Unix-request, дубли кода (arch detection, ApiResponse, CoreInfo), asnCache cap, broadcast capacity — список с причинами в выводе аудит-воркфлоу wf_99e06380-8ab.
