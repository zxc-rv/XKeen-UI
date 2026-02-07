#!/bin/sh

set -e

GREEN=$'\033[1;32m'
RED=$'\033[1;31m'
NC=$'\033[0m'
BLUE=$'\033[1;34m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[96m'

xkeenui_bin="/opt/sbin/xkeen-ui"
xkeenui_init="/opt/etc/init.d/S99xkeen-ui"
static_dir="/opt/share/www/XKeen-UI"
monaco_dir="$static_dir/monaco-editor"
local_mode_path="$static_dir/local_mode.js"
lighttpd_init="/opt/etc/init.d/S80lighttpd"
lighttpd_dir="/opt/etc/lighttpd"
lighttpd_conf="$lighttpd_dir/conf.d/90-xkeenui.conf"

beta=false
[ "$1" = "beta" ] && beta=true

detect_arch() {
  cpuinfo=$(grep -i 'model name' /proc/cpuinfo | sed -e 's/.*: //i' | tr '[:upper:]' '[:lower:]')

  case "$(uname -m | tr '[:upper:]' '[:lower:]')" in
    *'armv8'* | *'aarch64'* | *'cortex-a'* )
      arch='arm64-v8a'
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

  local base_url="https://github.com/zxc-rv/XKeen-UI/releases"
  local download_url="$base_url/latest/download"

  if [ "$beta" = true ]; then
    echo -e "${CYAN}\n ℹ️  Поиск бета-релиза...${NC}"
    local tag=$(curl -s https://api.github.com/repos/zxc-rv/XKeen-UI/releases | grep -m1 '"tag_name":' | cut -d'"' -f4)
    download_url="$base_url/download/$tag"
  fi

  local bin_name="xkeen-ui-$arch"
  local static_name="xkeen-ui-static.tar.gz"
  local static_tmp_path=/opt/tmp/$static_name

  echo -e "${CYAN}\n ℹ️  Загрузка статики...${NC}"
  if ! curl --progress-bar -Lfo $static_tmp_path $download_url/xkeen-ui-static.tar.gz; then
    echo -e "${RED}\n ❌ Не удалось скачать архив статики.\n${NC}"
    exit 1
  fi

  echo -e "${CYAN}\n ℹ️  Распаковка...${NC}"
  mkdir -p $static_dir
  if ! tar -xzf $static_tmp_path -C $static_dir; then
    echo -e "${RED}\n ❌ Не удалось распаковать архив статики.\n${NC}"
    rm -f $static_tmp_path
    exit 1
  fi
  rm -f $static_tmp_path

  echo -e "${CYAN}\n ℹ️  Загрузка бинарного файла xkeen-ui...${NC}"
  if ! (curl --progress-bar -Lfo $xkeenui_bin $download_url/$bin_name && chmod +x $xkeenui_bin); then
    echo -e "${RED}\n Не удалось скачать бинарный файл.\n${NC}"
    exit 1
  fi
}

setup_local_editor() {

  local monaco_tmp_path="/opt/tmp/monaco.tgz"

  echo -e "${CYAN}\n ℹ️  Загрузка Monaco Editor...${NC}"
  mkdir -p $monaco_dir
  curl --progress-bar -Lfo $monaco_tmp_path https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.52.2.tgz
  curl --progress-bar -Lfo $monaco_dir/loader.min.js https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.min.js
  curl --progress-bar -Lfo $monaco_dir/js-yaml.min.js https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js
  curl --progress-bar -Lfo $monaco_dir/standalone.min.js https://cdn.jsdelivr.net/npm/prettier@2/standalone.min.js
  curl --progress-bar -Lfo $monaco_dir/babel.min.js https://cdn.jsdelivr.net/npm/prettier@3/plugins/babel.min.js
  curl --progress-bar -Lfo $monaco_dir/yaml.min.js https://cdn.jsdelivr.net/npm/prettier@3/plugins/yaml.min.js

  echo -e "${CYAN}\n ℹ️  Распаковка...${NC}"
  if ! tar xf $monaco_tmp_path --strip-components=2 -C $static_dir/monaco-editor package/min/vs; then
    echo -e "${RED}\n ❌ Не удалось распаковать архив редактора.\n${NC}"
    rm -f $monaco_tmp_path
    exit 1
  fi
  rm -f $monaco_tmp_path
}

install_xkeenui() {

  if [ -d $static_dir ] || [ -f $xkeenui_bin ] || [ -f $xkeenui_init ] || [ -f $lighttpd_conf ]; then
    echo -e "${YELLOW}\n  ⚠️ Обнаружены файлы XKeen UI, запуск переустановки...${NC}"
    uninstall_xkeenui
  fi

  echo -e "${YELLOW}\n Вариант установки редактора:\n${NC}"
  echo -e " 1. CDN"
  echo -e " 2. Local\n"
  read -p "${GREEN}>: ${NC}" editor_choice < /dev/tty

  mkdir -p $static_dir

  if [ "$editor_choice" = "2" ]; then
    echo "const LOCAL = true" > $local_mode_path
  else
    echo "const LOCAL = false" > $local_mode_path
  fi

  clear
  detect_arch
  download_files
  create_xkeenui_init

  if grep -q "LOCAL = true" "$local_mode_path"; then
    setup_local_editor
  fi

  echo -e "${CYAN}\n ℹ️  Запуск XKeen UI...${NC}"
  if ! $xkeenui_init start; then
    echo -e "${RED}\n ❌ Не удалось запустить XKeen UI.\n${NC}"
    exit 1
  fi

  local ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
  local ip=${ip:-"IP_Роутера"}
  local port=$(grep -oP 'ARGS=.*-p\s+\K\d+' /opt/etc/init.d/S99xkeen-ui 2>/dev/null || :)
  local port=${port:-1000}

  clear
  echo -e "${GREEN}\n ✅ XKeen UI успешно установлен!\n${NC}"
  echo -e " Панель доступна по адресу: ${GREEN}http://$ip:$port\n${NC}"
}

update_xkeenui() {
  echo
  if [ ! -f $xkeenui_bin ]; then
    echo -e "${RED}❌ Ошибка: XKeen UI не установлен!\n${NC}"
    exit 1
  fi

  if [ ! -f $xkeenui_init ]; then
    create_xkeenui_init
  else
    $xkeenui_init stop || :
    killall -q -9 xkeen-ui || :
  fi

  legacy_installation_check
  detect_arch
  download_files

  if ! [ -f $local_mode_path ]; then
    echo "const LOCAL = false" > $local_mode_path
  fi

  if grep -q "LOCAL = true" "$local_mode_path"; then
    if [ ! -f "$monaco_dir/loader.min.js" ] || [ ! -f "$monaco_dir/js-yaml.min.js" ] || [ ! -f "$monaco_dir/standalone.min.js" ] || [ ! -f "$monaco_dir/babel.min.js" ] || [ ! -f "$monaco_dir/yaml.min.js" ]; then
      setup_local_editor
    fi
  fi

  echo -e "${CYAN}\n ℹ️  Запуск XKeen UI...${NC}"
  if ! $xkeenui_init start; then
    echo -e "${RED}\n Не удалось запустить XKeen UI.\n${NC}"
    exit 1
  fi

  local ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')
  local ip=${ip:-"IP_Роутера"}
  local port=$(grep -oP 'ARGS=.*-p\s+\K\d+' /opt/etc/init.d/S99xkeen-ui 2>/dev/null || :)
  local port=${port:-1000}

  clear

  echo -e "${GREEN}\n ✅ XKeen UI успешно обновлен!\n${NC}"
  echo -e " Панель доступна по адресу: ${GREEN}http://$ip:$port${NC}"
  echo -e " После перехода нажмите Ctrl+Shift+R для обновления кэша\n"
}

uninstall_xkeenui() {
  echo -e "\n ❗ Данное действие ${RED}удалит${NC} XKeen UI, его файлы и зависимости.\n"
  read -p " Продолжить? [y/N]: " response < /dev/tty
  case "$response" in
    [Yy])
        clear
        echo -e "${GREEN}\n ℹ️  Начинаем удаление...${NC}"
        ;;
    *)
        echo -e "${RED}\n ❌ Отмена операции.\n${NC}"
        exit 1
        ;;
  esac

  echo

  if [ -f $lighttpd_init ] && [ -f $lighttpd_conf ]; then
    if $lighttpd_init status >/dev/null 2>&1; then
        $lighttpd_init stop
        opkg remove --autoremove --force-removal-of-dependent-packages lighttpd
        rm -rf $lighttpd_dir
    fi
  fi

  if [ -f $xkeenui_init ]; then
    if $xkeenui_init status >/dev/null 2>&1; then
      $xkeenui_init stop || :
      killall -q -9 xkeen-ui || :
    fi
  fi

  rm -rf $static_dir
  rm -f $xkeenui_bin $xkeenui_init
  echo -e "${GREEN}\n ✅ Удаление XKeen-UI завершено\n${NC}"
}

legacy_installation_check() {
  if [ -f "$lighttpd_conf" ]; then
    $lighttpd_init status >/dev/null 2>&1 && $lighttpd_init stop
    rm -f "$lighttpd_conf"
    echo -e "${YELLOW}\n ℹ️ Веб-сервер lighttpd для работы XKeen UI более не используется.${NC}"
    read -p " Удалить его? [Y/n]: " response < /dev/tty

    case "$response" in
      [Nn])
        return
        ;;
      *)
        opkg remove --autoremove --force-removal-of-dependent-packages lighttpd
        rm -rf $lighttpd_dir
        ;;
    esac
  fi
}

create_xkeenui_init() {
  cat << EOF > $xkeenui_init
#!/bin/sh

ENABLED=yes
PROCS=/opt/sbin/xkeen-ui
ARGS="-p 1000"
PREARGS=""
DESC=$PROCS
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF
  chmod +x $xkeenui_init
}

get_editor_mode() {
  if grep -q "const LOCAL = true" "$local_mode_path" 2>/dev/null; then
    echo -e "${GREEN}🏠 Local${NC}"
  elif grep -q "const LOCAL = false" "$local_mode_path" 2>/dev/null; then
    echo -e "${CYAN}🌐 CDN${NC}"
  else
    echo -e "${RED}N/A${NC}"
  fi
}

toggle_editor_mode() {
  if [ ! -f "$local_mode_path" ]; then
    echo -e "${RED}\n ❌ Ошибка: XKeen UI не установлен\n${NC}"
    exit 1
  fi

  if grep -q "const LOCAL = true" "$local_mode_path"; then
    echo "const LOCAL = false" > "$local_mode_path"
    echo -e "${GREEN}\n ✅ Режим редактора переключен на CDN\n${NC}"
  else
    if [ ! -f "$monaco_dir/loader.min.js" ] || [ ! -f "$monaco_dir/js-yaml.min.js" ] || [ ! -f "$monaco_dir/standalone.min.js" ] || [ ! -f "$monaco_dir/babel.min.js" ] || [ ! -f "$monaco_dir/yaml.min.js" ]; then
      echo -e "\n ℹ️ Будет выполнена загрузка файлов редактора.\n"
      read -p " Продолжить? [Y/n]: " response < /dev/tty
      [[ ! $response =~ ^[Yy]?$ ]] && echo && return
      setup_local_editor
    fi
    echo "const LOCAL = true" > "$local_mode_path"
    echo -e "${GREEN}\n ✅ Режим редактора переключен на Local\n${NC}"
  fi
}

clear
echo -e "${CYAN}"
cat <<'EOF'
   _  __  __ __                       __  __ ____
  | |/ / / //_/___   ___   ____      / / / //  _/
  |   / / ,<  / _ \ / _ \ / __ \    / / / / / /
 /   | / /| |/  __//  __// / / /   / /_/ /_/ /
/_/|_|/_/ |_|\___/ \___//_/ /_/    \____//___/
EOF
echo -e "\nДобро пожаловать! Выберите действие:\n${NC}"

current_mode=$(get_editor_mode)

echo -e " 1. Установить/переустановить"
echo -e " 2. Обновить"
echo -e " 3. Удалить"
echo -e " 4. Сменить режим редактора [Сейчас: ${YELLOW}$current_mode${NC}]"
echo -e " 5. Выйти\n"

read -p "${CYAN}~ # ${NC}" response < /dev/tty

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
  4)
    toggle_editor_mode
    ;;
  5)
    echo
    exit
    ;;
  *)
    echo -e "${RED}\n ❌ Неверный выбор.\n${NC}"
    exit 1
    ;;
esac