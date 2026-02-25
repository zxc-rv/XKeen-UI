#!/bin/sh

GREEN=$'\033[32m'
GREEN_BOLD=$'\033[1;32m'
RED=$'\033[31m'
RED_BOLD=$'\033[1;31m'
NC=$'\033[0m'
NCN="$NC\n\n"
BLUE=$'\033[1;34m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[1;96m'

ERROR="\n${RED} ❌${RED_BOLD}"
SUCCESS="\n${GREEN} ✅${GREEN_BOLD}"
INFO="\n${CYAN} ℹ️ "

XKEENUI_BIN="/opt/sbin/xkeen-ui"
XKEENUI_INIT="/opt/etc/init.d/S99xkeen-ui"
STATIC_DIR="/opt/share/www/XKeen-UI"
LOCAL_MODE_PATH="$STATIC_DIR/local_mode.js"
LIGHTTPD_INIT="/opt/etc/init.d/S80lighttpd"
LIGHTTPD_DIR="/opt/etc/lighttpd"
LIGHTTPD_CONF="$LIGHTTPD_DIR/conf.d/90-xkeenui.conf"

BETA=false
[ "$1" = "beta" ] && BETA=true

spinner() {
  local pid=$1 msg=$2
  trap 'kill "$pid" 2>/dev/null; printf "\r${RED} ❌ ${NC}%s\033[K\n" "$msg"; printf "\033[?25h"; return 130' INT
  set -- ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
  printf "\033[?25l"
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r${GREEN} %s ${NC} %s\033[K" "$1" "$msg"
    set -- "$@" "$1"
    shift
    usleep 100000
  done
  printf "\033[?25h"
  wait "$pid" && printf "\r ✔  %s\033[K\n" "$msg" || { printf "\r ❌ %s\033[K\n" "$msg"; return 1; }
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
            printf "${RED_BOLD}\n Не удалось определить архитектуру.${NCN}" >&2
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
    local beta_tag="/tmp/xkeen_beta"
    trap "rm -f $beta_tag" EXIT
    (curl -s https://api.github.com/repos/zxc-rv/XKeen-UI/releases | \
      jq -re '[.[] | select(.prerelease == true)][0].tag_name' > $beta_tag) &
    if ! spinner $! "Поиск бета-релиза..."; then
      printf "${RED_BOLD}\n Нет актуального бета-релиза${NCN}"
      $XKEENUI_INIT start >/dev/null 2>&1 || :
      exit 1
    fi
    beta_tag=$(cat $beta_tag)
    download_url="$base_url/download/$beta_tag"
  fi

  if ! [ -f /opt/bin/tar ]; then
    ( opkg update >/dev/null 2>&1; opkg install tar >/dev/null 2>&1 ) &
    ! spinner $! "Установка tar..." && printf "${RED_BOLD}\n Не удалось установить tar.${NCN}"
  fi

  mkdir -p $STATIC_DIR
  ( set -e; curl -Ls "$download_url/xkeen-ui-static.tar.gz" | tar -xz -C "$STATIC_DIR" ) &
  if ! spinner $! "Загрузка статики..."; then
    printf "${RED_BOLD}\n Не удалось загрузить статику.${NCN}"
    exit 1
  fi

  ( set -e; curl -Lsfo $XKEENUI_BIN $download_url/$bin_name && chmod +x $XKEENUI_BIN ) &
  if ! spinner $! "Загрузка бинарника..."; then
    printf "${RED_BOLD}\n Не удалось загрузить бинарник.${NCN}"
    exit 1
  fi
}

install_xkeenui() {
  if [[ -d $STATIC_DIR || -f $XKEENUI_BIN || -f $XKEENUI_INIT || -f $LIGHTTPD_CONF ]]; then
    printf "${YELLOW}\n Обнаружены файлы XKeen UI, запуск переустановки...\n${NC}"
    uninstall_xkeenui
  fi

  printf "${INFO} Начинаем установку...${NCN}"

  download_files; create_xkeenui_init

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start >/dev/null 2>&1 &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "установлен"
}

update_xkeenui() {
  [ -f "$XKEENUI_BIN" ] || { printf "${ERROR} Ошибка: XKeen UI не установлен!${NCN}"; exit 1; }

  printf "${INFO} Начинаем обновление...${NCN}"

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

  sync & spinner $! "Запись данных..."

  $XKEENUI_INIT start >/dev/null 2>&1 &
  if ! spinner $! "Запуск XKeen UI..."; then
    printf "${RED_BOLD}\n Не удалось запустить XKeen UI.${NCN}"
    exit 1
  fi

  finish_setup "обновлен"
}

uninstall_xkeenui() {
  printf "\n Данное действие ${RED_BOLD}удалит${NC} XKeen UI, его файлы и зависимости.\n\n"
  read -p " Продолжить? [y/N]: " response < /dev/tty
  response=$(printf '%s' "$response" | tr -cd 'YyNn')
  case "$response" in
    [Yy]) printf "${INFO} Начинаем удаление...${NCN}";;
    *) printf "${ERROR} Отмена операции.${NCN}"; exit 1;;
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
  printf "${SUCCESS} Удаление XKeen-UI завершено${NCN}"
}

finish_setup() {
  local ip=$(ip -4 a s br0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p'); ip=${ip:-"IP_Роутера"}
  local port=$(sed -n 's/.*-p \([0-9]*\).*/\1/p' $XKEENUI_INIT 2>/dev/null); port=${port:-1000}

  printf "${SUCCESS} XKeen UI успешно $1!${NCN}"
  printf " Панель доступна по адресу: ${GREEN_BOLD}http://$ip:$port${NC}"
  [ $1 == "обновлен" ] && printf "\n После перехода нажмите Ctrl+Shift+R для обновления кэша\n\n" || printf "\n\n"
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

get_status() {
  [ ! -f "$XKEENUI_BIN" ] && printf "Статус панели: ${RED_BOLD}не установлена${NC}" && return

  local version=$(timeout 1 $XKEENUI_BIN -v 2>/dev/null | awk '{print $3}')
  local status="${RED_BOLD}не запущена"

  version=${version:-"legacy"}

  pidof xkeen-ui >/dev/null 2>&1 && status="${GREEN_BOLD}запущена"
  printf "Статус панели: $status ${NC}[$version]"
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
printf "\nДобро пожаловать! Выберите действие:${NCN}"
printf "  1. Установить/переустановить\n"
printf "  2. Обновить\n"
printf "  3. Удалить\n"
printf "  4. Выйти\n\n"

read -p "${GREEN_BOLD}>: ${NC}" response < /dev/tty

case $response in
  1) install_xkeenui;;
  2) update_xkeenui;;
  3) uninstall_xkeenui;;
  4) echo; exit;;
  *) printf "${ERROR} Неверный выбор.${NCN}"; exit 1;;
esac