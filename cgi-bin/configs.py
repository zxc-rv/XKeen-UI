#!/opt/bin/python
import json
import os
import sys
import glob
import cgitb

cgitb.enable()

CONFIGS_DIR = "/opt/etc/xray/configs"

def send_response(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print("Access-Control-Allow-Methods: GET, POST, DELETE")
    print("Access-Control-Allow-Headers: Content-Type")
    print()
    print(json.dumps(data))

def get_all_configs():
    try:
        if not os.path.exists(CONFIGS_DIR):
            os.makedirs(CONFIGS_DIR)
            return {"success": True, "configs": []}
        
        json_files = glob.glob(os.path.join(CONFIGS_DIR, "*.json"))
        configs = []
        
        for file_path in sorted(json_files):
            filename = os.path.basename(file_path)
            name = os.path.splitext(filename)[0]
            
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                configs.append({
                    "name": name,
                    "filename": filename,
                    "content": content
                })
            except Exception as e:
                configs.append({
                    "name": name,
                    "filename": filename,
                    "content": "",
                    "error": str(e)
                })
        
        if not configs:
            default_config = {
                "log": {"loglevel": "warning"},
                "inbounds": [],
                "outbounds": []
            }
            default_path = os.path.join(CONFIGS_DIR, "config.json")
            with open(default_path, 'w', encoding='utf-8') as f:
                f.write(json.dumps(default_config, indent=2))
            configs.append({
                "name": "config",
                "filename": "config.json",
                "content": json.dumps(default_config, indent=2)
            })
        
        return {"success": True, "configs": configs}
    except Exception as e:
        return {"success": False, "error": str(e)}

def save_config(filename, content):
    try:
        if not filename.endswith('.json'):
            filename += '.json'
        
        file_path = os.path.join(CONFIGS_DIR, filename)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

def delete_config(filename):
    try:
        if not filename.endswith('.json'):
            filename += '.json'
        
        file_path = os.path.join(CONFIGS_DIR, filename)
        if os.path.exists(file_path):
            os.remove(file_path)
            return {"success": True}
        else:
            return {"success": False, "error": "File not found"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    method = os.environ.get('REQUEST_METHOD', 'GET')

    if method == 'GET':
        result = get_all_configs()
        send_response(result)
    elif method == 'POST':
        try:
            content_length = int(os.environ.get('CONTENT_LENGTH', 0))
            if content_length > 0:
                post_data = sys.stdin.read(content_length)
                data = json.loads(post_data)
                action = data.get('action')
                
                if action == 'save':
                    result = save_config(data['filename'], data['content'])
                    send_response(result)
                elif action == 'delete':
                    result = delete_config(data['filename'])
                    send_response(result)
                else:
                    send_response({"success": False, "error": "Unknown action"}, 400)
            else:
                send_response({"success": False, "error": "No data"}, 400)
        except Exception as e:
            send_response({"success": False, "error": str(e)}, 500)
    else:
        send_response({"success": False, "error": "Method not allowed"}, 405)

if __name__ == "__main__":
    main()
