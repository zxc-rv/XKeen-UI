#!/bin/sh

send_response() {
    local data="$1"
    local status="${2:-200}"
    echo "Status: $status"
    echo "Content-Type: application/json"
    echo "Access-Control-Allow-Origin: *"
    echo
    echo "$data"
}

check_xray_status() {
    local output
    if output=$(xkeen -status 2>&1); then
        local clean_output
        clean_output=$(echo "$output" | sed 's/\x1b\[[0-9;]*m//g')

        if [[ "$clean_output" =~ запущен ]] && [[ ! "$clean_output" =~ "не запущен" ]]; then
            echo "true"
        else
            echo "false"
        fi
    else
        echo "false"
    fi
}

running=$(check_xray_status)
result=$(jq -n --argjson running "$running" --arg status "$([ "$running" == "true" ] && echo "running" || echo "stopped")" '{"running": $running, "status": $status}')
send_response "$result"
