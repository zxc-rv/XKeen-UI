#!/opt/bin/python
import json
import os
import sys
import cgi
import cgitb

cgitb.enable()

CONFIG_PATH = "/opt/etc/xray/configs/config.json"

def send_response(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print("Access-Control-Allow-Methods: GET, POST")
    print("Access-Control-Allow-Headers: Content-Type")
    print()
    print(json.dumps(data))

def read_config():
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            return {"success": True, "data": f.read()}
    except Exception as e:
        return {"success": False, "error": str(e)}

def write_config(data):
    try:
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            f.write(data)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    method = os.environ.get('REQUEST_METHOD', 'GET')

    if method == 'GET':
        result = read_config()
        send_response(result)
    elif method == 'POST':
        try:
            content_length = int(os.environ.get('CONTENT_LENGTH', 0))
            if content_length > 0:
                post_data = sys.stdin.read(content_length)
                data = json.loads(post_data)
                if data.get('action') == 'save':
                    result = write_config(data['data'])
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
