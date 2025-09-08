#!/bin/sh

send_response() {
    local data="$1"
    local status="${2:-200}"
    echo "Status: $status"
    echo "Content-Type: application/json"
    echo "Access-Control-Allow-Origin: *"
    echo "Access-Control-Allow-Methods: POST"
    echo "Access-Control-Allow-Headers: Content-Type"
    echo
    echo "$data"
}

execute_command() {
    local cmd="$1"
    local log_file="/opt/var/log/xray/error.log"
    
    > "$log_file"
    
    if eval "$cmd" >> "$log_file" 2>&1; then
        echo '{"success": true, "output": "Command executed", "returncode": 0}'
    else
        local rc=$?
        echo "{\"success\": false, \"output\": \"Command failed\", \"returncode\": $rc}"
    fi
}

if [ "$REQUEST_METHOD" != "POST" ]; then
    send_response '{"success": false, "error": "Only POST allowed"}' 405
    exit 0
fi

if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -eq 0 ]; then
    send_response '{"success": false, "error": "No data"}' 400
    exit 0
fi

read -n "$CONTENT_LENGTH" post_data

action=$(echo "$post_data" | jq -r '.action')

case "$action" in
    "start")
        result=$(execute_command 'xkeen -start')
        ;;
    "stop")
        result=$(execute_command 'xkeen -stop')
        ;;
    "restart")
        result=$(execute_command 'xkeen -restart')
        ;;
    *)
        send_response '{"success": false, "error": "Unknown action"}' 400
        exit 0
        ;;
esac

send_response "$result"
