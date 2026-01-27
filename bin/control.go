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
		cores := []string{}
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

	if r.Method != "POST" {
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
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

	if req.Action == "switchCore" {
		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Invalid core"}, 400)
			return
		}

		ClientMutex.RLock()
		cur := CurrentClient.Name
		ClientMutex.RUnlock()

		if cur == "xray" && req.Core == "mihomo" {
			os.Truncate(ErrorLogPath, 0)
		}

		f, err := os.OpenFile(ErrorLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Log error"}, 500)
			return
		}
		defer f.Close()

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

		jsonResponse(w, Response{Success: true, Data: "Core switched"}, 200)
		return
	}

	var cmd *exec.Cmd

	if req.Action == "softRestart" {
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

		f, err := os.OpenFile(ErrorLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Log error"}, 500)
			return
		}
		defer f.Close()

		shellCmd := ""
    if req.Core == "xray" {
        shellCmd = fmt.Sprintf("ulimit -SHn %d && xray run", limit)
        cmd = exec.Command("sh", "-c", shellCmd)
        cmd.Env = append(os.Environ(), "XRAY_LOCATION_CONFDIR=/opt/etc/xray/configs", "XRAY_LOCATION_ASSET=/opt/etc/xray/dat")
        cmd.Stderr = f
    } else {
        shellCmd = fmt.Sprintf("ulimit -SHn %d && mihomo", limit)
        cmd = exec.Command("sh", "-c", shellCmd)
        cmd.Env = append(os.Environ(), "CLASH_HOME_DIR=/opt/etc/mihomo")
        cmd.Stdout = f
        cmd.Stderr = f
    }

    cmd.SysProcAttr = &syscall.SysProcAttr{
        Credential: &syscall.Credential{Gid: 11111},
    }

		if err := cmd.Start(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Core start failed"}, 500)
			return
		}
		go cmd.Wait()
		jsonResponse(w, Response{Success: true, Data: "Core restarting"}, 200)
		return
	}

	xkeenAction := req.Action
	if req.Action == "hardRestart" {
		xkeenAction = "restart"
	}

	switch req.Action {
	case "start", "stop", "hardRestart":
		cmd = exec.Command("xkeen", "-"+xkeenAction)
		os.Truncate(ErrorLogPath, 0)
	default:
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
		return
	}

	f, err := OpenLogFile()
	if err == nil {
		defer f.Close()
		cmd.Stdout = f
		cmd.Stderr = f
	}
	if err := cmd.Run(); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
		return
	}
	jsonResponse(w, Response{Success: true, Data: "Command executed"}, 200)
}