#!/opt/bin/python
import json
import subprocess
import re

def send_response(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print()
    print(json.dumps(data))

def check_xray_status():
    try:
        result = subprocess.run(['xkeen', '-status'], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            output = result.stdout + result.stderr
            # Убираем ANSI коды
            clean_output = re.sub(r'\x1b\[[0-9;]*m', '', output)

            return 'запущен' in clean_output and 'не запущен' not in clean_output
        return False
    except:
        return False

def main():
    running = check_xray_status()
    send_response({"running": running, "status": "running" if running else "stopped"})

if __name__ == "__main__":
    main()
