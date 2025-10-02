#!/bin/sh

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
BLUE='\033[1;34m'
PURPLE='\033[38;2;120;93;200m'

VERSION="$1"
if [ -n "$VERSION" ]; then
  download_url="https://github.com/zxc-rv/XKeen-UI/releases/download/${VERSION}"
else
  download_url="https://github.com/zxc-rv/XKeen-UI/releases/latest/download"
fi

cpuinfo=$(grep -i 'model name' /proc/cpuinfo | sed -e 's/.*: //i' | tr '[:upper:]' '[:lower:]')

case "$(uname -m | tr '[:upper:]' '[:lower:]')" in
    *'armv5tel'* | *'armv6l'* | *'armv7'*)
        arch='arm32-v5'
        ;;
    *'armv8'* | *'aarch64'* | *'cortex-a'* )
        arch='arm64-v8a'
        ;;
    *'mips64le'* )
        arch='mips64le'
        ;;
    *'mips64'* )
        arch='mips64'
        ;;
    *'mipsle'* | *'mips 1004'* | *'mips 34'* | *'mips 24'* )
        arch='mips32le'
        ;;
    *'mips'* )
        arch='mips32'
        ;;
    *)
        if echo "${cpuinfo}" | grep -q -e 'armv8' -e 'aarch64' -e 'cortex-a'; then
            arch='arm64-v8a'
        elif echo "${cpuinfo}" | grep -q 'mips64le'; then
            arch='mips64le'
        elif echo "${cpuinfo}" | grep -q 'mips64'; then
            arch='mips64'
        elif echo "${cpuinfo}" | grep -q -e 'mips32le' -e 'mips 1004' -e 'mips 34' -e 'mips 24'; then
            arch='mips32le'
        elif echo "${cpuinfo}" | grep -q 'mips'; then
            arch='mips32'
        fi
        ;;
esac

if [ "${arch}" = 'mips64' ] || [ "${arch}" = 'mips32' ]; then
    if [ ! -f /opt/bin/lscpu ]; then
        opkg install lscpu &>/dev/null
    fi

    lscpu_output="$(lscpu 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    if echo "${lscpu_output}" | grep -q "little endian"; then
        arch="${arch}le"
    fi
fi

case "${arch}" in
    arm32-v5|arm64-v8a|mips32|mips32le|mips64|mips64le)
        ;;
    *)
        echo -e "\n${RED}Не удалось определить архитектуру${NC}\n" >&2
        exit 1
        ;;
esac

set -e
clear

echo -e "\n${BLUE}Установка lighttpd...${NC}"
opkg update && opkg install lighttpd lighttpd-mod-fastcgi lighttpd-mod-setenv || {
    echo -e "\n${RED}Ошибка установки пакетов${NC}\n"
    exit 1
}

echo -e "\n${BLUE}Настройка init скрипта...${NC}"
if [ -f "/opt/etc/init.d/S80lighttpd" ] && grep -q "PROCS=lighttpd" /opt/etc/init.d/S80lighttpd; then
  sed -Ei "s/^PROCS=lighttpd$/PROCS=\/opt\/sbin\/lighttpd/" /opt/etc/init.d/S80lighttpd
fi

if [ -f "/opt/etc/init.d/S80lighttpd" ]; then
    if /opt/etc/init.d/S80lighttpd status >/dev/null 2>&1; then
        /opt/etc/init.d/S80lighttpd stop
    fi
fi

echo -e "\n${BLUE}Создание конфига lighttpd...${NC}"
cat <<'EOF' >/opt/etc/lighttpd/conf.d/90-xkeenui.conf
server.port := 1000
server.username := ""
server.groupname := ""

$SERVER["socket"] == ":1000" {
    server.document-root = "/opt/share/www/XKeen-UI"
    setenv.add-environment = (
        "PATH" => "/opt/bin:/opt/sbin:/bin:/sbin:/usr/bin:/usr/sbin"
    )
    fastcgi.server = (
        "/cgi/" => ((
            "bin-path" => "/opt/sbin/xkeen-ui",
            "socket"   => "/tmp/xkeen-ui.sock",
            "check-local" => "disable",
            "max-procs" => 1
        ))
    )
}
EOF

echo -e "\n${BLUE}Загрузка статики...${NC}"
tmp_static="/tmp/xkeen-ui-static.tar.gz"
if ! curl --progress-bar -Lfo "$tmp_static" "$download_url/xkeen-ui-static.tar.gz"; then
    echo -e "\n${RED}Не удалось скачать архив статики${NC}\n"
    exit 1
fi

echo -e "\n${BLUE}Распаковка архива...${NC}"
mkdir -p /opt/share/www/XKeen-UI
if ! tar -xzf "$tmp_static" -C /opt/share/www/XKeen-UI; then
    echo -e "\n${RED}Не удалось распаковать архив статики${NC}\n"
    exit 1
fi
rm -f "$tmp_static"

echo -e "\n${BLUE}Загрузка бинарника...${NC}"
bin=xkeen-ui-$arch
if ! curl --progress-bar -Lfo /opt/sbin/xkeen-ui "$download_url/$bin"; then
    echo -e "\n${RED}Не удалось скачать бинарный файл${NC}\n"
    exit 1
fi

echo -e "\n${BLUE}Установка прав на бинарник...${NC}"
chmod +x /opt/sbin/xkeen-ui

echo -e "\n${BLUE}Запуск lighttpd...${NC}"
/opt/etc/init.d/S80lighttpd start || true
if ! /opt/etc/init.d/S80lighttpd status >/dev/null 2>&1; then
    echo -e "\n${RED}Не удалось запустить lighttpd${NC}\n"
    exit 1
fi

router_ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
clear

echo -e "\n${GREEN}XKeen UI успешно установлен!${NC}\n"
echo -e "Панель доступна по адресу: ${GREEN}http://$router_ip:1000${NC}\n"

