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
	"golang.org/x/sys/unix"
)

var env = map[string][]string{
	"xray": {"XRAY_LOCATION_CONFDIR=" + XrayConf, "XRAY_LOCATION_ASSET=" + XrayAsset},
	"mihomo": {"CLASH_HOME_DIR=" + MihomoConf},
}

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
		jsonResponse(w, map[string]any{"success": true, "cores": cores, "currentCore": name, "running": running, "status": status}, 200)
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
		if CurrentClient.Name == req.Core {
			ClientMutex.RUnlock()
			jsonResponse(w, Response{Success: true, Data: "Already using " + req.Core}, 200)
			return
		}
		oldCore := CurrentClient.Name
		ClientMutex.RUnlock()

		ClientMutex.Lock()
		CurrentClient = clientTypes[req.Core]
		ClientMutex.Unlock()

		exec.Command("xkeen", "-stop").Run()

		if data, err := os.ReadFile(S99xkeen); err == nil {
			content := strings.Replace(string(data), `name_client="`+oldCore+`"`, `name_client="`+req.Core+`"`, 1)
			os.WriteFile(S99xkeen, []byte(content), 0755)
		}

		os.Truncate(ErrorLog, 0)

		c := exec.Command("xkeen", "-start")
		c.Stdout, c.Stderr = f, f
		c.Run()

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

		limit := uint64(10000)
		if runtime.GOARCH == "arm64" { limit = 40000 }

		cmd := exec.Command(req.Core)
		cmd.Env = append(os.Environ(), env[req.Core]...)
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Gid: 11111}}
		cmd.Stdout, cmd.Stderr = f, f

		if cmd.Start() != nil {
			jsonResponse(w, Response{Success: false, Error: "Start failed"}, 500)
			return
		}
		unix.Prlimit(cmd.Process.Pid, unix.RLIMIT_NOFILE, &unix.Rlimit{Cur: limit, Max: limit}, nil)
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
	b, err := os.ReadFile(path)
	if err != nil { return err }
	name := "xray"
	if strings.Contains(string(b), `name_client="mihomo"`) { name = "mihomo" }

	ClientMutex.Lock()
	CurrentClient = clientTypes[name]
	ClientMutex.Unlock()
	return nil
}