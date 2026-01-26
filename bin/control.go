package bin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"syscall"
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

		exec.Command("killall", "-q", "-9", req.Core).Run()

		limit := 10000
		if runtime.GOARCH == "arm64" {
			limit = 40000
		}

		runCmd := ""
		if req.Core == "xray" {
			os.Setenv("XRAY_LOCATION_CONFDIR", "/opt/etc/xray/configs")
			os.Setenv("XRAY_LOCATION_ASSET", "/opt/etc/xray/dat")
			runCmd = fmt.Sprintf("ulimit -SHn %d && xray run >/dev/null 2>>/opt/var/log/xray/error.log", limit)
		} else {
			os.Setenv("CLASH_HOME_DIR", "/opt/etc/mihomo")
			runCmd = fmt.Sprintf("ulimit -SHn %d && mihomo >>/opt/var/log/xray/error.log 2>&1", limit)
		}
		cmd = exec.Command("su", "xkeen", "-c", runCmd)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

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

	if req.Action != "restartCore" {
		f, err := OpenLogFile()
		if err == nil {
			defer f.Close()
			cmd.Stdout = f
			cmd.Stderr = f
		}
		if err := cmd.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
		} else {
			jsonResponse(w, Response{Success: true, Data: "Command executed"}, 200)
		}
	} else {
		if err := cmd.Start(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Core start failed"}, 500)
		} else {
			jsonResponse(w, Response{Success: true, Data: "Core restarting"}, 200)
		}
	}
}
