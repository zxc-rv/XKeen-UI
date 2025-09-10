#!/bin/sh

send_response() {
    data="$1"
    status="${2:-200}"
    echo "Status: $status"
    echo "Content-Type: application/json"
    echo "Access-Control-Allow-Origin: *"
    echo
    echo "$data"
}

read_logs() {
    log_file="$1"

    case "$log_file" in
        error.log) log_path="/opt/var/log/xray/error.log" ;;
        access.log) log_path="/opt/var/log/xray/access.log" ;;
        *)
            echo '{"success": false, "error": "Доступ к этому файлу запрещен"}'
            return
            ;;
    esac

    if [ -f "$log_path" ]; then
        content=$(tail -n +1 "$log_path" 2>/dev/null)
        if [ $? -eq 0 ]; then
            echo "$content" | jq -Rs '{"success": true, "data": .}'
        else
            echo '{"success": false, "error": "Ошибка чтения файла"}'
        fi
    else
        jq -n --arg msg "Лог файл '$log_file' не найден" '{"success": true, "data": $msg}'
    fi
}

log_file="error.log"
case "$QUERY_STRING" in
    *file=*)
        log_file=$(printf "%s" "$QUERY_STRING" | sed -n 's/.*file=\([^&]*\).*/\1/p')
        ;;
esac

result=$(read_logs "$log_file")
send_response "$result"

