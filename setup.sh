#!/bin/sh

set -e

GREEN='\033[1;32m'
RED='\033[1;31m'
NC='\033[0m'
BLUE='\033[1;34m'
YELLOW='\033[1;33m'

config_path="/opt/share/www/XKeen-UI/xkeen-ui.conf"
bin_path="/opt/sbin/xkeen-ui"
static_path="/opt/share/www/XKeen-UI"
init_path="/opt/etc/init.d/S80lighttpd"
lighttpd_bin_path="/opt/sbin/lighttpd"

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
              echo -e "\n${RED} Не удалось определить архитектуру.${NC}\n" >&2
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

  bin_name="xkeen-ui-$arch"
  static_name="xkeen-ui-static.tar.gz"
  static_tmp_path=/opt/tmp/$static_name

  echo -e "\n${BLUE}:: Загрузка статики...${NC}"
  if ! curl --progress-bar -Lfo $static_tmp_path $download_url/xkeen-ui-static.tar.gz; then
      echo -e "\n${RED} Не удалось скачать архив статики.${NC}\n"
      exit 1
  fi

  echo -e "\n${BLUE}:: Распаковка...${NC}"
  mkdir -p $static_path
  if ! tar -xzf $static_tmp_path -C $static_path; then
      echo -e "\n${RED} Не удалось распаковать архив статики.${NC}\n"
      rm -f $static_tmp_path
      exit 1
  fi
  rm -f $static_tmp_path

  echo -e "\n${BLUE}:: Загрузка бинарного файла xkeen-ui...${NC}"
  if ! (curl --progress-bar -Lfo $bin_path $download_url/$bin_name && chmod +x $bin_path); then
      echo -e "\n${RED} Не удалось скачать бинарный файл.${NC}\n"
      exit 1
  fi
}

setup_local_editor() {
  echo -e "\n${BLUE}:: Установка wget...${NC}"
  opkg update && opkg install wget

  echo -e "\n${BLUE}:: Загрузка Monaco Editor...${NC}\n"
  mkdir -p /opt/share/www/XKeen-UI/monaco-editor
  wget -q --show-progress -r -nH --cut-dirs=3 -P /opt/share/www/XKeen-UI/monaco-editor -np -R "index.html*" https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/
  curl -Lso /opt/share/www/XKeen-UI/monaco-editor/loader.min.js https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/loader.min.js

  echo -e "\n${BLUE}:: Загрузка Prettier...${NC}\n"
  mkdir -p /opt/share/www/XKeen-UI/prettier
  curl -Lso /opt/share/www/XKeen-UI/prettier/babel.min.js https://cdn.jsdelivr.net/npm/prettier@3/plugins/babel.min.js
  curl -Lso /opt/share/www/XKeen-UI/prettier/yaml.min.js https://cdn.jsdelivr.net/npm/prettier@3/plugins/yaml.min.js
  curl -Lso /opt/share/www/XKeen-UI/prettier/standalone.min.js https://cdn.jsdelivr.net/npm/prettier@2/standalone.min.js

  change_paths_to_local
}

change_paths_to_local() {
  echo -e "\n${BLUE}:: Правка локальных путей...${NC}\n"
  sed -i \
    -e 's|https://cdn.jsdelivr.net/npm/prettier@2/standalone.min.js|/prettier/standalone.min.js|g' \
    -e 's|https://cdn.jsdelivr.net/npm/prettier@3/plugins/babel.min.js|/prettier/babel.min.js|g' \
    -e 's|https://cdn.jsdelivr.net/npm/prettier@3/plugins/yaml.min.js|/prettier/yaml.min.js|g' \
    -e 's|https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs/loader.min.js|/monaco-editor/loader.min.js|g' \
    $static_path/index.html

  sed -i 's|https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs|/monaco-editor/vs|g' $static_path/script.js
}


install_xkeenui() {
  if [ -f /opt/sbin/lighttpd ]; then
    echo -e "${YELLOW}\nПредупреждение: обнаружен установленный инстанс lighttpd."
    echo -e "Перед продолжением требуется его полная деинсталляция.${NC}\n"
    read -p "Продолжить? [y/N]: " response < /dev/tty
    case "$response" in
        [Yy])
            uninstall_xkeenui
            ;;
        *)
            echo -e "\n${RED}Отмена операции.${NC}\n"
            exit 1
            ;;
    esac
  fi

  echo -ne "\n${YELLOW}Выберите версию (enter для latest):${NC} "
  read VERSION
  echo -e "\n${YELLOW}Вариант установки редактора:${NC}\n"
  echo -e "1. CDN (удаленно)"
  echo -e "2. Локально (требует дополнительно ~25МБ места)\n"
  read -p "Выбор: " editor_choice

  if [ "$editor_choice" = "2" ]; then
      mkdir -p $(dirname $config_path)
      echo "local=true" > $config_path
  fi
  clear

  echo -e "\n${BLUE}:: Установка lighttpd...${NC}"
  opkg update && opkg install lighttpd lighttpd-mod-fastcgi lighttpd-mod-setenv && sed -i "s/^PROCS=lighttpd$/PROCS=\/opt\/sbin\/lighttpd/" $init_path || {
      echo -e "\n${RED} Ошибка установки пакетов.${NC}\n"
      exit 1
  }

  if [ -f $init_path ]; then
      if $init_path status >/dev/null 2>&1; then
          $init_path stop
      fi
  fi

  echo -e "\n${BLUE}:: Создание конфигурации lighttpd...${NC}"
  cat << 'EOF' >/opt/etc/lighttpd/conf.d/90-xkeenui.conf
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

  detect_arch
  download_files "$VERSION"

  if [ -f $config_path ] && grep -q "local=true" $config_path; then
      setup_local_editor
  fi

  echo -e "\n${BLUE}:: Запуск веб-сервера lighttpd...${NC}"
  if ! /opt/sbin/lighttpd -f /opt/etc/lighttpd/lighttpd.conf; then
      echo -e "\n${RED} Не удалось запустить lighttpd.${NC}\n"
      exit 1
  fi

  router_ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
  router_ip=${router_ip:-"IP_Роутера"}

  clear
  echo -e "\n${GREEN} XKeen UI успешно установлен!${NC}\n"
  echo -e " Панель доступна по адресу: ${GREEN}http://$router_ip:1000${NC}\n"
}

update_xkeenui() {
  if ! [ -f $bin_path ]; then
    echo -e "${RED}\n Ошибка: XKeen-UI не установлен!\n${NC}"
    exit 1
  fi

  detect_arch

  if [ -f $init_path ]; then
      if $init_path status >/dev/null 2>&1; then
          $init_path stop
      fi
  fi

  download_files

  if [ -f $config_path ] && grep -q "local=true" $config_path; then
      if [ ! -d "/opt/share/www/XKeen-UI/monaco-editor" ] && [ ! -d "/opt/share/www/XKeen-UI/prettier" ]; then
          setup_local_editor
      else
          change_paths_to_local
      fi
  fi

  echo -e "\n${BLUE}:: Запуск веб-сервера lighttpd...${NC}"
  if ! /opt/sbin/lighttpd -f /opt/etc/lighttpd/lighttpd.conf; then
      echo -e "\n${RED} Не удалось запустить lighttpd.${NC}\n"
      exit 1
  fi

  clear
  echo -e "\n${GREEN} XKeen UI успешно обновлен!${NC}\n"
}

uninstall_xkeenui() {
  echo -e "\nДанное действие ${RED}удалит${NC} веб-сервер lighttpd, его зависимости и конфигурации, а также файлы XKeen-UI.\n"
  read -p "Продолжить? [y/N]: " response < /dev/tty
  case "$response" in
    [Yy])
        clear
        echo -e "\n${GREEN}:: Начинаем удаление...${NC}"
        ;;
    *)
        echo -e "\n${RED}Отмена операции.${NC}\n"
        exit 1
        ;;
  esac

  if [ -f $init_path ]; then
    if $init_path status >/dev/null 2>&1; then
        $init_path stop
    fi
  fi

  echo ""
  opkg remove --autoremove --force-removal-of-dependent-packages lighttpd
  rm -rf $static_path
  rm -rf /opt/etc/lighttpd/
  rm -f $bin_path
  rm -f $config_path
  echo -e "\n${GREEN}Удаление XKeen-UI завершено${NC}\n"
}

clear
echo -e "${BLUE}\nДобро пожаловать! Выберите действие:\n${NC}"
echo "1. Установить"
echo "2. Обновить"
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
