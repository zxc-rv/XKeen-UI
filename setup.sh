#!/bin/sh

set -e

GREEN='\033[1;32m'
RED='\033[1;31m'
NC='\033[0m'
BLUE='\033[1;34m'
YELLOW='\033[1;33m'

static_path="/opt/share/www/XKeen-UI"
xkeenui_bin_path="/opt/sbin/xkeen-ui"
local_mode_path="$static_path/local_mode.js"
lighttpd_init_path="/opt/etc/init.d/S80lighttpd"
lighttpd_bin_path="/opt/sbin/lighttpd"
lighttpd_conf_path="/opt/etc/lighttpd/lighttpd.conf"

detect_arch() {
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
          echo -e "${RED}\n Не удалось определить архитектуру.\n${NC}" >&2
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
}

download_files() {
  VERSION="$1"
  if [ -n "$VERSION" ]; then
    download_url="https://github.com/zxc-rv/XKeen-UI/releases/download/${VERSION}"
  else
    download_url="https://github.com/zxc-rv/XKeen-UI/releases/latest/download"
  fi

  local bin_name="xkeen-ui-$arch"
  local static_name="xkeen-ui-static.tar.gz"
  local static_tmp_path=/opt/tmp/$static_name

  echo -e "${BLUE}\n:: Загрузка статики...${NC}"
  if ! curl --progress-bar -Lfo $static_tmp_path $download_url/xkeen-ui-static.tar.gz; then
    echo -e "${RED}\n Не удалось скачать архив статики.\n${NC}"
    exit 1
  fi

  echo -e "${BLUE}\n:: Распаковка...${NC}"
  mkdir -p $static_path
  if ! tar -xzf $static_tmp_path -C $static_path; then
    echo -e "${RED}\n Не удалось распаковать архив статики.\n${NC}"
    rm -f $static_tmp_path
    exit 1
  fi
  rm -f $static_tmp_path

  echo -e "${BLUE}\n:: Загрузка бинарного файла xkeen-ui...${NC}"
  if ! (curl --progress-bar -Lfo $xkeenui_bin_path $download_url/$bin_name && chmod +x $xkeenui_bin_path); then
    echo -e "${RED}\n Не удалось скачать бинарный файл.\n${NC}"
    exit 1
  fi
}

setup_local_editor() {
  local editor_archive="monaco.tgz"
  local editor_tmp_path="/opt/tmp/$editor_archive"

  echo -e "${BLUE}\n:: Загрузка Monaco Editor...${NC}"
  mkdir -p $static_path/monaco-editor
  curl --progress-bar -Lfo $editor_tmp_path https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.52.2.tgz
  curl --progress-bar -Lfo $static_path/monaco-editor/loader.min.js https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.min.js

  echo -e "${BLUE}\n:: Распаковка...${NC}"
  if ! tar xf $editor_tmp_path --strip-components=2 -C $static_path/monaco-editor package/min/vs; then
    echo -e "${RED}\n Не удалось распаковать архив редактора.\n${NC}"
    rm -f $editor_tmp_path
    exit 1
  fi
  rm -f $editor_tmp_path

  echo -e "${BLUE}\n:: Загрузка Prettier...${NC}"
  mkdir -p $static_path/prettier
  curl --progress-bar -Lfo $static_path/prettier/babel.min.js https://cdn.jsdelivr.net/npm/prettier@3/plugins/babel.min.js
  curl --progress-bar -Lfo $static_path/prettier/yaml.min.js https://cdn.jsdelivr.net/npm/prettier@3/plugins/yaml.min.js
  curl --progress-bar -Lfo $static_path/prettier/standalone.min.js https://cdn.jsdelivr.net/npm/prettier@2/standalone.min.js

}

install_xkeenui() {
  if [ -f $lighttpd_bin_path ]; then
    echo -e "${YELLOW}\nПредупреждение: обнаружен установленный инстанс lighttpd."
    echo -e "Перед продолжением требуется его полная деинсталляция.\n${NC}"
    uninstall_xkeenui
  fi

  echo -ne "${YELLOW}\nВыберите версию (enter для latest):${NC} "
  read VERSION < /dev/tty
  echo -e "${YELLOW}\nВариант установки редактора:\n${NC}"
  echo -e "1. CDN"
  echo -e "2. Local\n"
  read -p "Выбор: " editor_choice < /dev/tty

  mkdir -p $static_path

  if [ "$editor_choice" = "2" ]; then
    echo "const LOCAL = true;" > $local_mode_path
  else
    echo "const LOCAL = false;" > $local_mode_path
  fi

  clear

  echo -e "${BLUE}\n:: Установка lighttpd...${NC}"
  opkg update && opkg install lighttpd lighttpd-mod-fastcgi lighttpd-mod-setenv && sed -i "s/^PROCS=lighttpd$/PROCS=\/opt\/sbin\/lighttpd/" $lighttpd_init_path || {
      echo -e "${RED}\n Ошибка установки пакетов.\n${NC}"
      exit 1
  }

  if [ -f $lighttpd_init_path ]; then
      if $lighttpd_init_path status >/dev/null 2>&1; then
          $lighttpd_init_path stop
      fi
  fi

  echo -e "${BLUE}\n:: Создание конфигурации lighttpd...${NC}"
  cat << EOF >/opt/etc/lighttpd/conf.d/90-xkeenui.conf
server.port := 1000
server.username := ""
server.groupname := ""

\$SERVER["socket"] == ":1000" {
    server.document-root = "$static_path"
    setenv.add-environment = (
        "PATH" => "/opt/bin:/opt/sbin:/bin:/sbin:/usr/bin:/usr/sbin"
    )
    fastcgi.server = (
        "/cgi/" => ((
            "bin-path" => "$xkeenui_bin_path",
            "socket"   => "/opt/var/run/xkeen-ui.sock",
            "check-local" => "disable",
            "max-procs" => 1
        ))
    )
}
EOF

  detect_arch
  download_files "$VERSION"

  if grep -q "LOCAL = true" "$local_mode_path"; then
    setup_local_editor
  fi

  echo -e "${BLUE}\n:: Запуск веб-сервера lighttpd...${NC}"
  if ! $lighttpd_bin_path -f $lighttpd_conf_path; then
    echo -e "${RED}\n Не удалось запустить lighttpd.\n${NC}"
    exit 1
  fi

  router_ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
  router_ip=${router_ip:-"IP_Роутера"}

  clear
  echo -e "${GREEN}\n XKeen UI успешно установлен!\n${NC}"
  echo -e " Панель доступна по адресу: ${GREEN}http://$router_ip:1000\n${NC}"
}

update_xkeenui() {
  if ! [ -f $xkeenui_bin_path ]; then
    echo -e "${RED}\n Ошибка: XKeen-UI не установлен!\n${NC}"
    exit 1
  fi

  detect_arch

  if [ -f $lighttpd_init_path ]; then
    if $lighttpd_init_path status >/dev/null 2>&1; then
        $lighttpd_init_path stop
    fi
  fi

  download_files

  if ! [ -f $local_mode_path ]; then
    echo "const LOCAL = false;" > $local_mode_path
  fi

  if grep -q "LOCAL = true" "$local_mode_path"; then
    if [ ! -d "$static_path/monaco-editor" ] || [ -z "$(ls "$static_path/monaco-editor" 2>/dev/null)" ] || [ ! -d "$static_path/prettier" ] || [ -z "$(ls "$static_path/prettier" 2>/dev/null)" ]; then
      setup_local_editor
    fi
  fi

  echo -e "${BLUE}\n:: Запуск веб-сервера lighttpd...${NC}"
  if ! $lighttpd_bin_path -f $lighttpd_conf_path; then
    echo -e "${RED}\n Не удалось запустить lighttpd.\n${NC}"
    exit 1
  fi

  router_ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
  router_ip=${router_ip:-"IP_Роутера"}

  clear

  echo -e "${GREEN}\n XKeen UI успешно обновлен!\n${NC}"
  echo -e " Панель доступна по адресу: ${GREEN}http://$router_ip:1000\n${NC}"
  echo -e " После перехода нажмите Ctrl+Shift+R для обновления кэша\n"
}

uninstall_xkeenui() {
  echo -e "\nДанное действие ${RED}удалит${NC} веб-сервер lighttpd, его зависимости и конфигурации, а также файлы XKeen-UI.\n"
  read -p "Продолжить? [y/N]: " response < /dev/tty
  case "$response" in
    [Yy])
        clear
        echo -e "${GREEN}\n:: Начинаем удаление...${NC}"
        ;;
    *)
        echo -e "${RED}\nОтмена операции.\n${NC}"
        exit 1
        ;;
  esac

  if [ -f $lighttpd_init_path ]; then
    if $lighttpd_init_path status >/dev/null 2>&1; then
        $lighttpd_init_path stop
    fi
  fi

  echo ""
  opkg remove --autoremove --force-removal-of-dependent-packages lighttpd
  rm -rf /opt/etc/lighttpd
  rm -rf $static_path
  rm -f $xkeenui_bin_path
  echo -e "${GREEN}\nУдаление XKeen-UI завершено\n${NC}"
}

clear
echo -e "${BLUE}\nДобро пожаловать! Выберите действие:\n${NC}"
echo -e "1. Установить/переустановить"
echo -e "2. Обновить"
echo -e "3. Удалить\n"
read -p "Выбор: " response < /dev/tty

case $response in
  1)
    install_xkeenui
    ;;
  2)
    update_xkeenui
    ;;
  3)
    uninstall_xkeenui
    ;;
  *)
    echo -e "${RED}\n Неверный выбор.\n${NC}"
    exit 1
    ;;
esac
