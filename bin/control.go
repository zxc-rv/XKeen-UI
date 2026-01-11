package bin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
)

func ControlHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonResponse(w, Response{Success: false, Error: "Only POST allowed"}, 405)
		return
	}
	var req struct {
		Action string `json:"action"`
		Core   string `json:"core,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
		return
	}
	if req.Action == "restartCore" {
		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Invalid core"}, 400)
			return
		}
		updateCurrentClient()
		ClientMutex.Lock()
		currentClientType := CurrentClient
		ClientMutex.Unlock()
		requestedClientType, exists := clientTypes[req.Core]
		if !exists || currentClientType != requestedClientType {
			jsonResponse(w, Response{Success: false, Error: "Core mismatch"}, 400)
			return
		}
		script := fmt.Sprintf(`
		. "/opt/sbin/.xkeen/01_info/03_info_cpu.sh"
		status_file="/opt/lib/opkg/status"
		info_cpu
		name_client="%s"
		killall -q -9 $name_client
		case "$name_client" in
				xray)
						export XRAY_LOCATION_CONFDIR="/opt/etc/xray/configs"
						export XRAY_LOCATION_ASSET="/opt/etc/xray/dat"
						if [ "$architecture" = "arm64-v8a" ]; then
								ulimit -SHn "40000" && su -c "xray run" "xkeen" >/dev/null 2>&1 &
						else
								ulimit -SHn "10000" && su -c "xray run" "xkeen" >/dev/null 2>&1 &
						fi
				;;
				mihomo)
						if [ "$architecture" = "arm64-v8a" ]; then
								ulimit -SHn "40000" && su -c "mihomo -d /opt/etc/mihomo" "xkeen" >>/opt/var/log/xray/error.log 2>&1 &
						else
								ulimit -SHn "10000" && su -c "mihomo -d /opt/etc/mihomo" "xkeen" >>/opt/var/log/xray/error.log 2>&1 &
						fi
				;;
		esac
		`, req.Core)
		cmd := exec.Command("sh", "-c", script)
		logFileHandle, err := OpenLogFile()
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Cannot open log file"}, 500)
			return
		}
		defer logFileHandle.Close()
		cmd.Stdout = logFileHandle
		cmd.Stderr = logFileHandle
		if err := cmd.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
		} else {
			jsonResponse(w, Response{Success: true, Data: "Core restarted"}, 200)
		}
		return
	}
	var cmd *exec.Cmd
	switch req.Action {
	case "start":
		cmd = exec.Command("xkeen", "-start")
	case "stop":
		cmd = exec.Command("xkeen", "-stop")
	case "restart":
		cmd = exec.Command("xkeen", "-restart")
	default:
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
		return
	}
	os.Truncate("/opt/var/log/xray/error.log", 0)
	logFileHandle, err := OpenLogFile()
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Cannot open log file"}, 500)
		return
	}
	defer logFileHandle.Close()
	cmd.Stdout = logFileHandle
	cmd.Stderr = logFileHandle
	if err := cmd.Run(); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
	} else {
		jsonResponse(w, Response{Success: true, Data: "Command executed"}, 200)
	}
}