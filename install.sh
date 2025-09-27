#!/bin/sh

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
BLUE='\033[1;34m'
PURPLE='\033[38;2;120;93;200m'

architecture=$(uname -m | tr '[:upper:]' '[:lower:]')
download_url="https://github.com/zxc-rv/XKeen-UI/releases/latest/download"

case $architecture in
*'armv8'* | *'aarch64'* | *'cortex-a'*)
  bin="xkeen-ui-arm64-v8a"
  ;;
*'armv5tel'* | *'armv6l'* | *'armv7'*)
  bin="xkeen-ui-arm32-v5"
  ;;
*'mips'*)
  bin="xkeen-ui-mips32"
  ;;
*'mipsle'* | *'mips 1004'* | *'mips 34'* | *'mips 24'*)
  bin="xkeen-ui-mips32le"
  ;;
*'mips64'*)
  bin="xkeen-ui-mips64"
  ;;
*'mips64le'*)
  bin="xkeen-ui-mips64le"
  ;;
*)
  echo -e "\n${RED}Неизвестная архитектура: $architecture${NC}"
  exit 1
  ;;
esac

set -e
clear

echo -e "\n${BLUE}Установка lighttpd...${NC}"
opkg update && opkg install lighttpd lighttpd-mod-fastcgi lighttpd-mod-setenv || {
    echo -e "${RED}Ошибка установки пакетов${NC}"
    exit 1
}

echo -e "\n${BLUE}Настройка init скрипта...${NC}"
if [ -f "/opt/etc/init.d/S80lighttpd" ] && grep -q "PROCS=lighttpd" /opt/etc/init.d/S80lighttpd; then
  sed -iE "s/^PROCS=lighttpd$/PROCS=\/opt\/sbin\/lighttpd/" /opt/etc/init.d/S80lighttpd
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
if ! curl -Lsfo "$tmp_static" "$download_url/xkeen-ui-static.tar.gz"; then
    echo -e "${RED}Не удалось скачать архив статики${NC}"
    exit 1
fi

echo -e "\n${BLUE}Распаковка архива...${NC}"
mkdir -p /opt/share/www/XKeen-UI
if ! tar -xzf "$tmp_static" -C /opt/share/www/XKeen-UI; then
    echo -e "${RED}Не удалось распаковать архив статики${NC}"
    exit 1
fi
rm -f "$tmp_static"

echo -e "\n${BLUE}Загрузка бинарника...${NC}"
if ! curl -Lsfo /opt/sbin/xkeen-ui "$download_url/$bin"; then
    echo -e "${RED}Не удалось скачать бинарный файл${NC}"
    exit 1
fi

echo -e "\n${BLUE}Установка прав на бинарник...${NC}"
chmod +x /opt/sbin/xkeen-ui

echo -e "\n${BLUE}Запуск lighttpd...${NC}"
/opt/etc/init.d/S80lighttpd start

router_ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
clear

echo -e "\n${GREEN}XKeen UI успешно установлен!${NC}\n"
echo -e "Панель доступна по адресу: ${GREEN}http://$router_ip:1000${NC}\n"
