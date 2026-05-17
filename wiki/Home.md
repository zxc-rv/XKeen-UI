# XKeen UI

Ультра-лёгкая и быстрая панель управления для [XKeen](https://github.com/Skrill0/XKeen) — обёртки Xray-core / Mihomo (Clash Meta) для роутеров Keenetic. Один самодостаточный бинарь, минимум зависимостей, LAN-доступ через браузер.

![preview](https://github.com/zxc-rv/XKeen-UI/blob/main/preview.gif?raw=true)

## Установка

Стабильная версия:

```sh
curl https://raw.githubusercontent.com/zxc-rv/XKeen-UI/main/setup.sh | sh
```

Бета:

```sh
curl https://raw.githubusercontent.com/zxc-rv/XKeen-UI/main/setup.sh | sh -s -- beta
```

Скрипт интерактивный, предлагает меню:

1. Установить / переустановить
2. Обновить
3. Удалить

Архитектура определяется автоматически (`uname -m`, `/proc/cpuinfo`, `lscpu`).

## Доступ

После установки панель доступна по адресу `http://<router-ip>:1000`. Порт по умолчанию — **1000**, меняется в init-скрипте `/opt/etc/init.d/S99xkeen-ui` через `ARGS="-p <PORT>"`.

Авторизация **по умолчанию выключена** — после установки панель открывается без пароля. Чтобы включить:

1. Открыть `Настройки` → переключатель `Авторизация`.
2. После включения панель предложит экран установки пароля.

Хеширование — Argon2. Защита от перебора: 5 неуспешных попыток → блокировка на 60 секунд. Сброс пароля из CLI: `xkeen-ui --reset-password`.

## Управление сервисом

```sh
/opt/etc/init.d/S99xkeen-ui {start|restart|stop|status}
```

## Возможности

- Мониторинг и управление сервисом XKeen (start / stop / restart / status)
- Редактор конфигов с подсветкой, валидацией и форматированием (CodeMirror 6)
- Просмотр логов в реальном времени: авто-обновление, фильтрация, выбор таймзоны
- Переключение, установка и обновление ядер Xray и Mihomo (Clash Meta)
- Генератор outbound из подписочных ссылок (доступен также автономно: [Outbound Generator](https://zxc-rv.github.io/XKeen-UI/Outbound_Generator/))
- Сканер DAT-файлов (geoip / geosite) — ruleset inspector
- Полная реализация Clash API для Mihomo (HTTP + WebSocket, через TCP и Unix-сокет)
- Резервное копирование и восстановление конфигов

## Поддерживаемые архитектуры

| Бинарь | Rust target | Применение |
|---|---|---|
| `xkeen-ui-arm64-v8a` | `aarch64-unknown-linux-musl` | Keenetic ARM64 |
| `xkeen-ui-mips32` | `mips-unknown-linux-musl` | MIPS BE |
| `xkeen-ui-mips32le` | `mipsel-unknown-linux-musl` | MIPS LE (musl) |
| `xkeen-ui-mips32le-gnu` | `mipsel-unknown-linux-gnu` | MIPS LE (glibc) |

## CLI

| Команда | Назначение |
|---|---|
| `xkeen-ui -p <port>` | старт на указанном порту |
| `xkeen-ui -d` | debug-режим |
| `xkeen-ui -v` | вывод версии |
| `xkeen-ui --reset-password` | сброс пароля |

## Пути в системе

| Путь | Назначение |
|---|---|
| `/opt/sbin/xkeen-ui` | бинарь |
| `/opt/etc/init.d/S99xkeen-ui` | init-скрипт |
| `/opt/etc/xkeen/xkeen-ui.json` | конфиг приложения |

## Ссылки

- [Руководство](Guide) — пошаговая настройка _(в разработке)_
- [FAQ](FAQ) — частые вопросы _(в разработке)_
- [Outbound Generator (web)](https://zxc-rv.github.io/XKeen-UI/Outbound_Generator/)
- [Релизы](https://github.com/zxc-rv/XKeen-UI/releases)
- [Issues](https://github.com/zxc-rv/XKeen-UI/issues)
