#!/bin/sh

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
BLUE='\033[1;34m'

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
        if echo "${cpuinfo}" | grep -qe 'armv8' -e 'aarch64' -e 'cortex-a'; then
            arch='arm64-v8a'
        elif echo "${cpuinfo}" | grep -q 'mips64le'; then
            arch='mips64le'
        elif echo "${cpuinfo}" | grep -q 'mips64'; then
            arch='mips64'
        elif echo "${cpuinfo}" | grep -qe 'mips32le' -e 'mips 1004' -e 'mips 34' -e 'mips 24'; then
            arch='mips32le'
        elif echo "${cpuinfo}" | grep -q 'mips'; then
            arch='mips32'
        else
            echo -e "\n${RED}Не удалось определить архитектуру${NC}\n" >&2
            exit 1
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

bin_name="xkeen-ui-$arch"
bin_path="/opt/sbin/xkeen-ui"
static_name="xkeen-ui-static.tar.gz"
static_path="/opt/share/www/XKeen-UI"
init_path="/opt/etc/init.d/S80lighttpd"

clear

echo -e "\n${BLUE}Установка lighttpd...${NC}"
opkg update && opkg install lighttpd lighttpd-mod-fastcgi lighttpd-mod-setenv || {
    echo -e "\n${RED}Ошибка установки пакетов${NC}\n"
    exit 1
}

echo -e "\n${BLUE}Настройка init скрипта...${NC}"
if [ -f $init_path ] && grep -q "PROCS=lighttpd" $init_path; then
  sed -Ei "s/^PROCS=lighttpd$/PROCS=\/opt\/sbin\/lighttpd/" $init_path
fi

if [ -f $init_path ]; then
    if $init_path status >/dev/null 2>&1; then
        $init_path stop
    fi
fi

echo -e "\n${BLUE}Создание конфигурации lighttpd...${NC}"
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
            "socket"   => "/opt/var/run/xkeen-ui.sock",
            "check-local" => "disable",
            "max-procs" => 1
        ))
    )
}
EOF

echo -e "\n${BLUE}Загрузка статики...${NC}"
static_tmp_path=/opt/tmp/$static_name
if ! curl --progress-bar -Lfo $static_tmp_path $download_url/xkeen-ui-static.tar.gz; then
    echo -e "\n${RED}Не удалось скачать архив статики${NC}\n"
    exit 1
fi

echo -e "\n${BLUE}Распаковка...${NC}"
mkdir -p $static_path
if ! tar -xzf $static_tmp_path -C $static_path; then
    echo -e "\n${RED}Не удалось распаковать архив статики${NC}\n"
    rm -f $static_tmp_path
    exit 1
fi
rm -f $static_tmp_path

echo -e "\n${BLUE}Загрузка бинарного файла...${NC}"
if ! (curl --progress-bar -Lfo $bin_path $download_url/$bin_name && chmod +x $bin_path); then
    echo -e "\n${RED}Не удалось скачать бинарный файл${NC}\n"
    exit 1
fi

echo -e "\n${BLUE}Запуск lighttpd...${NC}"
$init_path start >/dev/null 2>&1 || true
sleep 3
if ! $init_path status; then
    echo -e "\n${RED}Не удалось запустить lighttpd${NC}\n"
    exit 1
fi

router_ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
router_ip=${router_ip:-"IP_Роутера"}
clear

echo -e "\n${GREEN}XKeen UI успешно установлен!${NC}\n"
echo -e "Панель доступна по адресу: ${GREEN}http://$router_ip:1000${NC}\n"

