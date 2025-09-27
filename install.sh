#!/bin/sh

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
  echo "Неизвестная архитектура: $architecture"
  exit 1
  ;;
esac

opkg update && opkg install lighttpd lighttpd-mod-fastcgi lighttpd-mod-setenv

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

mkdir -p /opt/share/www/XKeen-UI
for file in index.html script.js style.css favicon.png; do
  curl -Lfo /opt/share/www/XKeen-UI/$file https://raw.githubusercontent.com/zxc-rv/XKeen-UI/refs/heads/main/$file
done

curl -Lfo /opt/sbin/xkeen-ui $download_url/$bin && chmod +x /opt/sbin/xkeen-ui

if [ -f "/opt/etc/init.d/S80lighttpd" ] && grep -q "PROCS=lighttpd" /opt/etc/init.d/S80lighttpd; then
  /opt/etc/init.d/S80lighttpd stop
  sed -i -E "s/^PROCS=lighttpd$/PROCS=\/opt\/sbin\/lighttpd/" /opt/etc/init.d/S80lighttpd
  /opt/etc/init.d/S80lighttpd start
fi

router_ip=$(ip -f inet addr show dev br0 2>/dev/null | grep inet | sed -n 's/.*inet \([0-9.]\+\).*/\1/p')

echo ""
echo "Успех!"
echo "XKeen-UI доступен по адресу: http://$router_ip:1000"
