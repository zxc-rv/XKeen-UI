#!/bin/sh

GREEN=$'\033[32m'
GREEN_BOLD=$'\033[1;32m'
RED=$'\033[31m'
RED_BOLD=$'\033[1;31m'
NC=$'\033[0m'
BLUE=$'\033[1;34m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[96m'

XKEENUI_BIN="/opt/sbin/xkeen-ui"
XKEENUI_INIT="/opt/etc/init.d/S99xkeen-ui"
STATIC_DIR="/opt/share/www/XKeen-UI"
MONACO_DIR="$STATIC_DIR/monaco-editor"
LOCAL_MODE_PATH="$STATIC_DIR/local_mode.js"
LIGHTTPD_INIT="/opt/etc/init.d/S80lighttpd"
LIGHTTPD_DIR="/opt/etc/lighttpd"
LIGHTTPD_CONF="$LIGHTTPD_DIR/conf.d/90-xkeenui.conf"

BETA=false
[ "$1" = "beta" ] && BETA=true

spinner() {
  local pid=$1 msg=$2
  trap 'printf "\r ❌ %s\n" "$msg"; return 130' INT
  set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r$GREEN %s $NC %s" "$1" "$msg"
    set -- "$@" "$1"
    shift
    usleep 100000
  done
  wait "$pid" && printf "\r ✔  %s\n" "$msg" || { printf "\r ❌ %s\n" "$msg"; return 1; }
}

get_arch() {
  local cpuinfo=$(grep -i 'model name' /proc/cpuinfo | sed -e 's/.*: //i' | tr '[:upper:]' '[:lower:]')

  case "$(uname -m | tr '[:upper:]' '[:lower:]')" in
    *'armv8'* | *'aarch64'* | *'cortex-a'* ) ARCH='arm64-v8a';;
    *'mipsle'* | *'mips 1004'* | *'mips 34'* | *'mips 24'* ) ARCH='mips32le';;
    *'mips'* ) ARCH='mips32';;
    *)  if echo "${cpuinfo}" | grep -qe 'armv8' -e 'aarch64' -e 'cortex-a'; then
          ARCH='arm64-v8a'
        elif echo "${cpuinfo}" | grep -qe 'mips32le' -e 'mips 1004' -e 'mips 34' -e 'mips 24'; then
            ARCH='mips32le'
        elif echo "${cpuinfo}" | grep -q 'mips'; then
            ARCH='mips32'
        else
            printf "${RED_BOLD}\n Не удалось определить архитектуру.\n\n${NC}" >&2
            exit 1
        fi
        ;;
  esac

  if [[ "$ARCH" = mips32 || "$ARCH" = mips64 ]]; then
    [ -f /opt/bin/lscpu ] || opkg install lscpu &>/dev/null
    local lscpu_output="$(lscpu 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    echo "$lscpu_output" | grep -q "little endian" && ARCH="${ARCH}le"
  fi
}

download_files() {
  local base_url="https://github.com/zxc-rv/XKeen-UI/releases"
  local download_url="$base_url/latest/download"
  local bin_name="xkeen-ui-$ARCH"

  if [ "$BETA" = true ]; then
    local beta_tag="/tmp/xkeen_beta_tag"
    (curl -s https://api.github.com/repos/zxc-rv/XKeen-UI/releases | \
      jq -re '[.[] | select(.prerelease == true)][0].tag_name' > $beta_tag) &

    if ! spinner $! "Поиск бета-релиза..."; then
      rm -f $beta_tag
      printf "${RED_BOLD}\n Нет актуального бета-релиза\n\n${NC}"
      $XKEENUI_INIT start >/dev/null 2>&1 || :
      exit 1
    fi

    beta_tag=$(cat $beta_tag)
    rm -f $beta_tag
    download_url="$base_url/download/$beta_tag"
  fi

  mkdir -p $STATIC_DIR
  ( set -e; curl -Ls "$download_url/xkeen-ui-static.tar.gz" | tar -xz -C "$STATIC_DIR" ) &
  if ! spinner $! "Загрузка статики..."; then
    printf "${RED_BOLD}\n Не удалось загрузить статику.\n\n${NC}"
    exit 1
  fi

  ( set -e; curl -Lsfo $XKEENUI_BIN $download_url/$bin_name && chmod +x $XKEENUI_BIN ) &
  if ! spinner $! "Загрузка бинарника..."; then
    printf "${RED_BOLD}\n Не удалось скачать бинарник.\n\n${NC}"
    exit 1
  fi
}

setup_local_editor() {
  (
    set -e
    mkdir -p $MONACO_DIR
    curl -Lsf "https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.52.2.tgz" | tar -xz -C "$MONACO_DIR" --strip-components=2 package/min/vs
    curl -Lsf \
      "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.min.js" -o "$MONACO_DIR/loader.min.js" \
      "https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js" -o "$MONACO_DIR/js-yaml.min.js" \
      "https://cdn.jsdelivr.net/npm/prettier@2/standalone.min.js" -o "$MONACO_DIR/standalone.min.js" \
      "https://cdn.jsdelivr.net/npm/prettier@3/plugins/babel.min.js" -o "$MONACO_DIR/babel.min.js" \
      "https://cdn.jsdelivr.net/npm/prettier@3/plugins/yaml.min.js" -o "$MONACO_DIR/yaml.min.js"
  ) &
  if ! spinner $! "Загрузка файлов редактора..."; then
    printf "${RED_BOLD}\n Не удалось загрузить файлы редактора.\n\n${NC}"
    exit 1
  fi
}

install_xkeenui() {
  if [[ -d $STATIC_DIR || -f $XKEENUI_BIN || -f $XKEENUI_INIT || -f $LIGHTTPD_CONF ]]; then
    printf "${YELLOW}\n Обнаружены файлы XKeen UI, запуск переустановки...\n${NC}"
    uninstall_xkeenui
  fi

  printf "${YELLOW}\n Вариант установки редактора:\n\n${NC}"
  printf " 1. CDN\n"
  printf " 2. Local\n\n"
  read -p "${GREEN_BOLD}>: ${NC}" editor_choice < /dev/tty

  case "$editor_choice" in
    1) mkdir -p $STATIC_DIR; echo "const LOCAL = false" > "$LOCAL_MODE_PATH";;
    2) mkdir -p $STATIC_DIR; echo "const LOCAL = true" > "$LOCAL_MODE_PATH";;
    *) printf "${RED}\n ❌${RED_BOLD} Неверный выбор.\n\n${NC}"; exit 1;;
  esac

  printf "${CYAN}\n ℹ️  Начинаем установку...${NC}\n\n"

  download_files; create_xkeenui_init
  [ $editor_choice = 2 ] && setup_local_editor

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start >/dev/null 2>&1 &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.\n\n${NC}"
    exit 1
  fi

  local ip=$(ip -4 a s br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p'); ip=${ip:-"IP_Роутера"}
  local port=$(sed -n 's/.*-p \([0-9]*\).*/\1/p' /opt/etc/init.d/S99xkeen-ui 2>/dev/null); port=${port:-1000}

  printf "${GREEN}\n ✅${GREEN_BOLD} XKeen UI успешно установлен!\n\n${NC}"
  printf " Панель доступна по адресу: ${GREEN_BOLD}http://$ip:$port\n\n${NC}"
}

update_xkeenui() {
  [ -f "$XKEENUI_BIN" ] || { printf "\n\n${RED}❌ ${RED_BOLD}Ошибка: XKeen UI не установлен!\n\n${NC}"; exit 1; }

  printf "${CYAN}\n ℹ️  Начинаем обновление...${NC}\n\n"

  if [ ! -f $XKEENUI_INIT ]; then
    (
      set -e
      killall -q -9 xkeen-ui >/dev/null 2>&1 || :
      create_xkeenui_init
    ) &
    spinner $! "Создание скрипта запуска..."
  elif pidof xkeen-ui >/dev/null 2>&1; then
    (
      sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
      $XKEENUI_INIT stop >/dev/null 2>&1 || :
      killall -q -9 xkeen-ui || :
    ) &
    spinner $! "Остановка XKeen UI..."
  else
    sed -i 's|^PROCS=/opt/sbin/xkeen-ui$|PROCS=xkeen-ui|' /opt/etc/init.d/S99xkeen-ui
  fi

  legacy_installation_check; download_files

  [ -f $LOCAL_MODE_PATH ] || echo "const LOCAL = false" > $LOCAL_MODE_PATH

  grep -q "LOCAL = true" "$LOCAL_MODE_PATH" && ! check_monaco_files && setup_local_editor

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start >/dev/null 2>&1 &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.\n\n${NC}"
    exit 1
  fi

  local ip=$(ip -4 a s br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p'); ip=${ip:-"IP_Роутера"}
  local port=$(sed -n 's/.*-p \([0-9]*\).*/\1/p' /opt/etc/init.d/S99xkeen-ui 2>/dev/null); port=${port:-1000}

  printf "${GREEN}\n ✅${GREEN_BOLD} XKeen UI успешно обновлен!\n\n${NC}"
  printf " Панель доступна по адресу: ${GREEN_BOLD}http://$ip:$port\n${NC}"
  printf " После перехода нажмите Ctrl+Shift+R для обновления кэша\n\n"
}

uninstall_xkeenui() {
  printf "\n Данное действие ${RED_BOLD}удалит${NC} XKeen UI, его файлы и зависимости.\n\n"
  read -p " Продолжить? [y/N]: " response < /dev/tty
  response=$(printf '%s' "$response" | tr -cd 'YyNn')
  case "$response" in
    [Yy]) printf "${CYAN}\n ℹ️  Начинаем удаление...\n\n${NC}";;
    *) printf "${RED}\n ❌${RED_BOLD} Отмена операции.\n\n${NC}"; exit 1;;
  esac

  (
    if [[ -f "$LIGHTTPD_INIT" && -f "$LIGHTTPD_CONF" ]]; then
      if $LIGHTTPD_INIT status >/dev/null 2>&1; then
          $LIGHTTPD_INIT stop >/dev/null 2>&1 || :
          opkg remove --autoremove --force-removal-of-dependent-packages lighttpd >/dev/null 2>&1
          rm -rf $LIGHTTPD_DIR
      fi
    fi
    if [ -f $XKEENUI_INIT ]; then
      if $XKEENUI_INIT status >/dev/null 2>&1; then
        $XKEENUI_INIT stop >/dev/null 2>&1 || :
        killall -q -9 xkeen-ui || :
      fi
    fi
  ) &
  spinner $! "Остановка XKeen UI..."

  (rm -rf $STATIC_DIR; rm -f $XKEENUI_BIN $XKEENUI_INIT) &
  spinner $! "Удаление файлов XKeen UI..."
  printf "${GREEN}\n ✅${GREEN_BOLD} Удаление XKeen-UI завершено\n\n${NC}"
}

legacy_installation_check() {
  if [ -f "$LIGHTTPD_CONF" ]; then
    $LIGHTTPD_INIT status >/dev/null 2>&1 && $LIGHTTPD_INIT stop
    rm -f "$LIGHTTPD_CONF"
    printf "${YELLOW}\n Веб-сервер lighttpd для работы XKeen UI более не используется.\n${NC}"
    read -p " Удалить его? [Y/n]: " response < /dev/tty
    response=$(printf '%s' "$response" | tr -cd 'YyNn')
    case "$response" in
      [Nn]) return;;
      *) opkg remove --autoremove --force-removal-of-dependent-packages lighttpd; rm -rf $LIGHTTPD_DIR;;
    esac
  fi
}

create_xkeenui_init() {
  cat << EOF > $XKEENUI_INIT
#!/bin/sh

ENABLED=yes
PROCS=xkeen-ui
ARGS="-p 1000"
PREARGS=""
DESC="\$PROCS"
PATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

. /opt/etc/init.d/rc.func
EOF
  chmod +x $XKEENUI_INIT
}

get_editor_mode() {
  case "$(sed -n 's/.*LOCAL = \(true\|false\).*/\1/p' "$LOCAL_MODE_PATH" 2>/dev/null)" in
    true)  printf "${GREEN_BOLD}🏠 Local${NC}\n";;
    false) printf "${CYAN}🌐 CDN${NC}\n";;
    *)     printf "${RED_BOLD}N/A${NC}\n";;
  esac
}

get_status() {
  [ ! -f "$XKEENUI_BIN" ] && printf "Статус панели: ${RED_BOLD}не установлена${NC}" && return

  local version=$(timeout 1 $XKEENUI_BIN -v 2>/dev/null | awk '{print $3}')
  local status="${RED_BOLD}не запущена"

  version=${version:-"legacy"}

  pidof xkeen-ui >/dev/null 2>&1 && status="${GREEN_BOLD}запущена"
  printf "Статус панели: $status ${NC}[$version]"
}

check_monaco_files() {
  for file in loader.min.js js-yaml.min.js standalone.min.js babel.min.js yaml.min.js; do
    [ -f "$MONACO_DIR/$file" ] || return 1
  done
}

toggle_editor_mode() {
  [ -f "$XKEENUI_BIN" ] || { printf "\n\n${RED}❌ ${RED_BOLD}Ошибка: XKeen UI не установлен!\n\n${NC}"; exit 1; }

  if grep -q "const LOCAL = true" "$LOCAL_MODE_PATH"; then
    echo "const LOCAL = false" > "$LOCAL_MODE_PATH"
    printf "${GREEN}\n ✅ ${GREEN_BOLD}Режим редактора переключен на CDN\n\n${NC}"
    return
  fi

  if ! check_monaco_files; then
    printf "${CYAN}\n ℹ️  Будет выполнена загрузка файлов редактора.\n\n Продолжить? [Y/n]: ${NC}"
    read -r response < /dev/tty
    response=$(printf '%s' "$response" | tr -cd 'YyNn')
    case "$response" in [Yy]|"") echo;; *) echo; return;; esac
    setup_local_editor
    sync & spinner $! "Запись данных..."
  fi

  echo "const LOCAL = true" > "$LOCAL_MODE_PATH"
  printf "${GREEN}\n ✅ ${GREEN_BOLD}Режим редактора переключен на Local\n\n${NC}"
}

clear
get_arch
printf "${CYAN}"
cat <<'EOF'
   _  __  __ __                       __  __ ____
  | |/ / / //_/___   ___   ____      / / / //  _/
  |   / / ,<  / _ \ / _ \ / __ \    / / / / / /
 /   | / /| |/  __//  __// / / /   / /_/ /_/ /
/_/|_|/_/ |_|\___/ \___//_/ /_/    \____//___/
EOF

printf "${NC}\n$(get_status)\n"
printf "Архитектура: ${GREEN_BOLD}$ARCH\n"
printf "\nДобро пожаловать! Выберите действие:\n\n${NC}"
printf " 1. Установить/переустановить\n"
printf " 2. Обновить\n"
printf " 3. Удалить\n"
printf " 4. Сменить режим редактора [Сейчас: $(get_editor_mode)]\n"
printf " 5. Выйти\n\n"

read -p "${GREEN_BOLD}>: ${NC}" response < /dev/tty

case $response in
  1) install_xkeenui;;
  2) update_xkeenui;;
  3) uninstall_xkeenui;;
  4) toggle_editor_mode;;
  5) echo; exit;;
  *) printf "${RED}\n ❌${RED_BOLD} Неверный выбор.\n\n${NC}"; exit 1;;
esac