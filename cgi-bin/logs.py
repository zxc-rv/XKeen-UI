#!/opt/bin/python
import cgi
import json
import os
import subprocess

# Белый список разрешенных логов и их пути
ALLOWED_LOGS = {
    "error.log": "/opt/var/log/xray/error.log",
    "access.log": "/opt/var/log/xray/access.log"
}
LOGS_DIR = "/opt/var/log/xray/" # На случай, если захочешь добавить автопоиск

def send_response(data, status=200):
    print(f"Status: {status}")
    print("Content-Type: application/json")
    print("Access-Control-Allow-Origin: *")
    print()
    print(json.dumps(data))

def read_logs(log_file):
    # Проверяем, что запрошенный лог есть в нашем белом списке
    if log_file not in ALLOWED_LOGS:
        return {"success": False, "error": "Доступ к этому файлу запрещен"}

    log_path = ALLOWED_LOGS[log_file]

    try:
        if os.path.exists(log_path):
            result = subprocess.run(['tail', '-n', '100', log_path],
                                    capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                return {"success": True, "data": result.stdout}
            else:
                return {"success": False, "error": result.stderr}
        else:
            return {"success": True, "data": f"Лог файл '{log_file}' не найден"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    # Получаем параметры из GET-запроса
    form = cgi.FieldStorage()
    # По умолчанию читаем error.log, если параметр не передан
    log_file_to_read = form.getvalue('file', 'error.log')

    result = read_logs(log_file_to_read)
    send_response(result)

if __name__ == "__main__":
    main()
