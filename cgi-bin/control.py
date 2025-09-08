#!/opt/bin/python
import json
import os
import sys
import subprocess
import cgitb

cgitb.enable()

def send_response(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print("Access-Control-Allow-Methods: POST")
    print("Access-Control-Allow-Headers: Content-Type")
    print()
    print(json.dumps(data))

def execute_command(cmd):
    try:
        log_file = '/opt/var/log/xray/error.log'
        open(log_file, 'w').close()

        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return {
            "success": result.returncode == 0,
            "output": result.stdout + result.stderr,
            "returncode": result.returncode
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    method = os.environ.get('REQUEST_METHOD', 'GET')

    if method != 'POST':
        send_response({"success": False, "error": "Only POST allowed"}, 405)
        return

    try:
        content_length = int(os.environ.get('CONTENT_LENGTH', 0))
        if content_length == 0:
            send_response({"success": False, "error": "No data"}, 400)
            return

        post_data = sys.stdin.read(content_length)
        data = json.loads(post_data)
        action = data.get('action')

        if action == 'start':
            result = execute_command('xkeen -start >> /opt/var/log/xray/error.log 2>&1')
        elif action == 'stop':
            result = execute_command('xkeen -stop >> /opt/var/log/xray/error.log 2>&1')
        elif action == 'restart':
            result = execute_command('xkeen -restart >> /opt/var/log/xray/error.log 2>&1')
        else:
            send_response({"success": False, "error": "Unknown action"}, 400)
            return

        send_response(result)

    except Exception as e:
        send_response({"success": False, "error": str(e)}, 500)

if __name__ == "__main__":
    main()
