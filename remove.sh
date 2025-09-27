#!/bin/sh

clear

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "Данный скрипт ${RED}удалит${NC} веб-сервер lighttpd, его зависимости и конфигурации, а также файлы XKeen-UI."
echo -e "Продолжить? y/N"

read response < /dev/tty

case "$response" in
    [Yy]) 
        clear
        echo -e "${GREEN}Начинаем удаление...${NC}"
        echo ""
        ;;
    *)
        echo -e "${RED}Отмена операции.${NC}"
        echo ""
        exit 1
        ;;
esac

if [ -f "/opt/etc/init.d/S80lighttpd" ]; then
    /opt/etc/init.d/S80lighttpd status >/dev/null 2>&1
    if [ $? -eq 0 ]; then
        /opt/etc/init.d/S80lighttpd stop
    fi
fi

echo ""
opkg remove --autoremove lighttpd-mod-fastcgi lighttpd-mod-setenv lighttpd
rm -rf /opt/share/www/XKeen-UI
rm -rf /opt/etc/lighttpd/
rm /opt/sbin/xkeen-ui

echo ""
echo -e "${GREEN}Удаление XKeen-UI завершено${NC}"
echo ""
