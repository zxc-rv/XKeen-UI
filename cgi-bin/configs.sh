#!/bin/sh

CONFIGS_DIR="/opt/etc/xray/configs"

send_response() {
    local data="$1"
    local status="${2:-200}"
    echo "Status: $status"
    echo "Content-Type: application/json"
    echo "Access-Control-Allow-Origin: *"
    echo "Access-Control-Allow-Methods: GET, POST, DELETE"
    echo "Access-Control-Allow-Headers: Content-Type"
    echo
    echo "$data"
}

get_all_configs() {
    if [[ ! -d "$CONFIGS_DIR" ]]; then
        mkdir -p "$CONFIGS_DIR" 2>/dev/null || {
            echo '{"success": false, "error": "Cannot create configs directory"}'
            return
        }
    fi
    
    local configs_array=""
    local first=true
    
    for file in "$CONFIGS_DIR"/*.json; do
        [[ ! -f "$file" ]] && continue
        
        local filename=$(basename "$file")
        local name="${filename%.json}"
        local content
        
        if content=$(cat "$file" 2>/dev/null); then
            local config_json=$(jq -n --arg name "$name" --arg filename "$filename" --arg content "$content" '{"name": $name, "filename": $filename, "content": $content}')
            
            if [[ "$first" == "true" ]]; then
                configs_array="$config_json"
                first=false
            else
                configs_array="$configs_array,$config_json"
            fi
        fi
    done
    
    if [[ "$first" == "true" ]]; then
        local default_config='{
  "log": {"loglevel": "warning"},
  "inbounds": [],
  "outbounds": []
}'
        echo "$default_config" > "$CONFIGS_DIR/config.json" 2>/dev/null || {
            echo '{"success": false, "error": "Cannot write default config"}'
            return
        }
        configs_array=$(jq -n --arg name "config" --arg filename "config.json" --arg content "$default_config" '{"name": $name, "filename": $filename, "content": $content}')
    fi
    
    echo "{\"success\": true, \"configs\": [$configs_array]}"
}

save_config() {
    local filename="$1"
    local content="$2"
    
    [[ ! "$filename" =~ \.json$ ]] && filename+=".json"
    
    local file_path="$CONFIGS_DIR/$filename"
    
    if echo -e "$content" > "$file_path" 2>/dev/null; then
        echo '{"success": true}'
    else
        echo '{"success": false, "error": "Ошибка записи файла"}'
    fi
}

delete_config() {
    local filename="$1"
    
    [[ ! "$filename" =~ \.json$ ]] && filename+=".json"
    
    local file_path="$CONFIGS_DIR/$filename"
    
    if [[ -f "$file_path" ]]; then
        if rm "$file_path" 2>/dev/null; then
            echo '{"success": true}'
        else
            echo '{"success": false, "error": "Ошибка удаления файла"}'
        fi
    else
        echo '{"success": false, "error": "File not found"}'
    fi
}

case "$REQUEST_METHOD" in
    "GET")
        result=$(get_all_configs)
        send_response "$result"
        ;;
    "POST")
        if [[ -z "$CONTENT_LENGTH" ]] || [[ "$CONTENT_LENGTH" -eq 0 ]]; then
            send_response '{"success": false, "error": "No data"}' 400
            exit 0
        fi
        
        read -n "$CONTENT_LENGTH" post_data
        
        action=$(echo "$post_data" | jq -r '.action')
        
        case "$action" in
            "save")
                filename=$(echo "$post_data" | jq -r '.filename')
                content=$(echo "$post_data" | jq -r '.content')
                result=$(save_config "$filename" "$content")
                ;;
            "delete")
                filename=$(echo "$post_data" | jq -r '.filename')
                result=$(delete_config "$filename")
                ;;
            *)
                send_response '{"success": false, "error": "Unknown action"}' 400
                exit 0
                ;;
        esac
        
        send_response "$result"
        ;;
    *)
        send_response '{"success": false, "error": "Method not allowed"}' 405
        ;;
esac
