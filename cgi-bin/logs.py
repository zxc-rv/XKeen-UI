#!/opt/bin/python
import json
import os
import subprocess

LOGS_PATH = "/opt/var/log/xray/error.log"

def send_response(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print()
    print(json.dumps(data))

def read_logs():
    try:
        if os.path.exists(LOGS_PATH):
            result = subprocess.run(['tail', '-n', '100', LOGS_PATH], 
                                  capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                return {"success": True, "data": result.stdout}
            else:
                return {"success": False, "error": result.stderr}
        else:
            return {"success": True, "data": "Лог файл не найден"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    result = read_logs()
    send_response(result)

if __name__ == "__main__":
    main()
