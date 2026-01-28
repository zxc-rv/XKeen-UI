package bin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
)

func ControlHandler(w http.ResponseWriter, r *http.Request) {
	updateCurrentClient()
	if r.Method == http.MethodGet {
		cores := []string{}
		for _, c := range []string{"xray", "mihomo"} {
			if _, err := os.Stat("/opt/sbin/" + c); err == nil {
				cores = append(cores, c)
			}
		}
		running := exec.Command("pidof", "xray", "mihomo").Run() == nil
		status := map[bool]string{true: "running", false: "stopped"}[running]
		ClientMutex.RLock()
		name := CurrentClient.Name
		ClientMutex.RUnlock()
		jsonResponse(w, map[string]interface{}{"success": true, "cores": cores, "currentCore": name, "running": running, "status": status}, 200)
		return
	}

	var req struct {
		Action string `json:"action"`
		Core   string `json:"core"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
		return
	}

	f, _ := os.OpenFile(ErrorLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	defer f.Close()

	switch req.Action {

	case "switchCore":
		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Invalid core"}, 400)
			return
		}
		ClientMutex.RLock()
		if CurrentClient.Name == "xray" && req.Core == "mihomo" {
			os.Truncate(ErrorLog, 0)
		}
		ClientMutex.RUnlock()
		for _, arg := range []string{"-" + req.Core, "-start"} {
			c := exec.Command("xkeen", arg)
			c.Stdout, c.Stderr = f, f
			c.Run()
		}
		ClientMutex.Lock()
		CurrentClient = clientTypes[req.Core]
		ClientMutex.Unlock()

	case "softRestart":
		ClientMutex.Lock()
		cur, ok := clientTypes[req.Core]
		if !ok || CurrentClient != cur {
			ClientMutex.Unlock()
			jsonResponse(w, Response{Success: false, Error: "Core mismatch"}, 400)
			return
		}
		ClientMutex.Unlock()

		exec.Command("killall", "-q", "-9", req.Core).Run()

		limit := 10000
		if runtime.GOARCH == "arm64" { limit = 40000 }

		cmd := exec.Command("sh", "-c", fmt.Sprintf("ulimit -SHn %d && exec %s", limit, req.Core))
		cmd.Stdout, cmd.Stderr = f, f
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Gid: 11111}}
		env := map[string][]string{
			"xray":   {"XRAY_LOCATION_CONFDIR=" + XrayConf, "XRAY_LOCATION_ASSET=" + XrayAsset},
			"mihomo": {"CLASH_HOME_DIR=" + MihomoConf}}
		cmd.Env = append(os.Environ(), env[req.Core]...)

		if cmd.Start() != nil {
			jsonResponse(w, Response{Success: false, Error: "Start failed"}, 500)
			return
		}
		go cmd.Wait()

	case "start", "stop", "hardRestart":
		arg := "-" + req.Action
		if req.Action == "hardRestart" {
			arg = "-restart"
		}
		os.Truncate(ErrorLog, 0)
		c := exec.Command("xkeen", arg)
		c.Stdout, c.Stderr = f, f
		c.Run()
	default:
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
		return
	}
	jsonResponse(w, Response{Success: true, Data: "OK"}, 200)
}

func updateCurrentClient() error {
	path := S24xray
	if _, err := os.Stat(path); err != nil {
		path = S99xkeen
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("init files not found")
		}
	}
	content, _ := os.ReadFile(path)
	name := "xray"
	if strings.Contains(string(content), "name_client=\"mihomo\"") {
		name = "mihomo"
	}
	ClientMutex.Lock()
	CurrentClient = clientTypes[name]
	ClientMutex.Unlock()
	return nil
}
