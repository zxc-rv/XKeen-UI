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

	var cmd *exec.Cmd

	if req.Action == "restartCore" {
		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Invalid core"}, 400)
			return
		}

		updateCurrentClient()
		ClientMutex.Lock()
		cur := CurrentClient
		ClientMutex.Unlock()

		if want, ok := clientTypes[req.Core]; !ok || cur != want {
			jsonResponse(w, Response{Success: false, Error: "Core mismatch"}, 400)
			return
		}

		envVars := ""
		runCmd := ""
		if req.Core == "xray" {
			envVars = `export XRAY_LOCATION_CONFDIR="/opt/etc/xray/configs"
            export XRAY_LOCATION_ASSET="/opt/etc/xray/dat"`
			runCmd = "xray run"
		} else {
			runCmd = "mihomo -d /opt/etc/mihomo"
		}

		script := fmt.Sprintf(`
        . "/opt/sbin/.xkeen/01_info/03_info_cpu.sh"
        status_file="/opt/lib/opkg/status"
        info_cpu
        killall -q -9 %s
        %s
        limit=10000
        [ "$architecture" = "arm64-v8a" ] && limit=40000
        ulimit -SHn "$limit" && su -c "%s" "xkeen" /opt/var/log/xray/error.log 2>&1 &
        `, req.Core, envVars, runCmd)

		cmd = exec.Command("sh", "-c", script)
	} else {
		switch req.Action {
		case "start", "stop", "restart":
			cmd = exec.Command("xkeen", "-"+req.Action)
			os.Truncate("/opt/var/log/xray/error.log", 0)
		default:
			jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
			return
		}
	}

	f, err := OpenLogFile()
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Cannot open log file"}, 500)
		return
	}
	defer f.Close()

	cmd.Stdout = f
	cmd.Stderr = f

	if err := cmd.Run(); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
	} else {
		jsonResponse(w, Response{Success: true, Data: "Command executed"}, 200)
	}
}