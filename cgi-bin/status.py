#!/opt/bin/python
import json
import subprocess

def send_response(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print()
    print(json.dumps(data))

def check_xray_status():
    try:
        result = subprocess.run(['pgrep', '-f', 'xray'], capture_output=True, text=True)
        return result.returncode == 0
    except:
        return False

def main():
    running = check_xray_status()
    send_response({"running": running, "status": "running" if running else "stopped"})

if __name__ == "__main__":
    main()
