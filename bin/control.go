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
	if r.Method == "GET" {
		var cores []string
		for _, c := range []string{"xray", "mihomo"} {
			if _, err := os.Stat("/opt/sbin/" + c); err == nil {
				cores = append(cores, c)
			}
		}
		ClientMutex.RLock()
		name := CurrentClient.Name
		ClientMutex.RUnlock()
		jsonResponse(w, map[string]interface{}{"success": true, "cores": cores, "currentCore": name}, 200)
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
	defer r.Body.Close()

	if (req.Action == "switchCore" || req.Action == "softRestart") && req.Core != "xray" && req.Core != "mihomo" {
		jsonResponse(w, Response{Success: false, Error: "Invalid core"}, 400)
		return
	}

	f, err := os.OpenFile(ErrorLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Log error"}, 500)
		return
	}
	defer f.Close()

	switch req.Action {
	case "switchCore":
		ClientMutex.RLock()
		cur := CurrentClient.Name
		ClientMutex.RUnlock()

		if cur == "xray" && req.Core == "mihomo" {
			os.Truncate(ErrorLog, 0)
		}

		for _, arg := range []string{"-" + req.Core, "-start"} {
			cmd := exec.Command("xkeen", arg)
			cmd.Stdout, cmd.Stderr = f, f
			if err := cmd.Run(); err != nil {
				jsonResponse(w, Response{Success: false, Error: "Exec failed: " + arg}, 500)
				return
			}
		}

		ClientMutex.Lock()
		CurrentClient = clientTypes[req.Core]
		ClientMutex.Unlock()

	case "softRestart":
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

		cmd := exec.Command("sh", "-c", fmt.Sprintf("ulimit -SHn %d && %s", limit, req.Core))
		cmd.Stdout, cmd.Stderr = f, f
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Gid: 11111}}

		if req.Core == "xray" {
			cmd.Env = append(os.Environ(), "XRAY_LOCATION_CONFDIR="+XrayConf, "XRAY_LOCATION_ASSET="+XrayAsset)
		} else {
			cmd.Env = append(os.Environ(), "CLASH_HOME_DIR="+MihomoConf)
		}

		if err := cmd.Start(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Start failed"}, 500)
			return
		}
		go cmd.Wait()

	case "start", "stop", "hardRestart":
		cmd := exec.Command("xkeen", "-"+req.Action)
		if req.Action == "hardRestart" {
			cmd = exec.Command("xkeen", "-restart")
		}
		os.Truncate(ErrorLog, 0)
		cmd.Stdout, cmd.Stderr = f, f
		if err := cmd.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
			return
		}

	default:
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
		return
	}

	jsonResponse(w, Response{Success: true, Data: "OK"}, 200)
}
