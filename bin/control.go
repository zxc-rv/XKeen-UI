package bin

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func GetNameClient() {
	path := S24xray
	if _, err := os.Stat(path); err != nil {
		path = S99xkeen
	}
	b, _ := os.ReadFile(path)
	name := "xray"
	if strings.Contains(string(b), `name_client="mihomo"`) {
		name = "mihomo"
	}
	ClientMutex.Lock()
	CurrentCore = clientTypes[name]
	ClientMutex.Unlock()
}

func getPid(name string) int {
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		if !e.IsDir() || e.Name()[0] < '0' || e.Name()[0] > '9' { continue }
		if b, _ := os.ReadFile("/proc/" + e.Name() + "/comm"); strings.TrimSpace(string(b)) == name {
			if p, err := strconv.Atoi(e.Name()); err == nil { return p }
		}
	}
	return 0
}

func getCoreVersion(name string) string {
	arg := "version"
	if name == "mihomo" { arg = "-v" }
	out, err := exec.Command(name, arg).Output()
	if err != nil { return "" }
	s := string(out)
	parts := strings.Fields(s)
	if name == "xray" && len(parts) > 1 { return "v" + parts[1] }
	if name == "mihomo" && len(parts) > 2 { return parts[2] }
	return ""
}

func ControlHandler(w http.ResponseWriter, r *http.Request) {
	DebugLog("ControlHandler: method=%s", r.Method)
	if r.Method == http.MethodGet {
		ClientMutex.RLock()
		cur := CurrentCore.Name
		ClientMutex.RUnlock()

		if getPid(cur) == 0 {
			alt := "mihomo"
			if cur == "mihomo" { alt = "xray" }
			if getPid(alt) > 0 {
				ClientMutex.Lock()
				CurrentCore = clientTypes[alt]
				ClientMutex.Unlock()
				cur = alt
			}
		}

		cores, running := []string{}, false
		for _, c := range []string{"xray", "mihomo"} {
			if _, err := os.Stat("/opt/sbin/" + c); err == nil { cores = append(cores, c) }
			if getPid(c) > 0 { running = true }
		}

		ver := getCoreVersion(cur)
		jsonResponse(w, map[string]any{
			"success":     true,
			"cores":       cores,
			"currentCore": cur,
			"running":     running,
			"version":     ver,
		}, 200)
		return
	}

	var req struct{ Action, Core string }
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		DebugLog("ControlHandler: JSON decode error")
		jsonResponse(w, Response{Success: false, Error: "JSON error"}, 400)
		return
	}
	DebugLog("ControlHandler POST: action=%s core=%s", req.Action, req.Core)

	f, _ := os.OpenFile(ErrorLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	defer f.Close()

	switch req.Action {
	case "switchCore":
		DebugLog("ControlHandler: switching core to %s", req.Core)
		ClientMutex.RLock()
		oldCore := CurrentCore.Name
		if oldCore == req.Core {
			ClientMutex.RUnlock()
			DebugLog("ControlHandler: already on %s", req.Core)
			jsonResponse(w, Response{Success: true, Data: "Already " + req.Core}, 200)
			return
		}
		ClientMutex.RUnlock()

		os.Truncate(ErrorLog, 0)
		exec.Command("xkeen", "-stop").Run()

		path := S99xkeen
		if _, err := os.Stat(path); err != nil { path = S24xray }
		if data, err := os.ReadFile(path); err == nil {
			out := strings.Replace(string(data), `name_client="`+oldCore+`"`, `name_client="`+req.Core+`"`, 1)
			os.WriteFile(path, []byte(out), 0755)
		}

		ClientMutex.Lock()
		if c, ok := clientTypes[req.Core]; ok { CurrentCore = c }
		ClientMutex.Unlock()

		cmd := exec.Command("xkeen", "-start")
		cmd.Stdout, cmd.Stderr = f, f
		cmd.Run()
		DebugLog("ControlHandler: core switched to %s", req.Core)

	case "softRestart":
		DebugLog("ControlHandler: soft restarting %s", req.Core)
		if pid := getPid(req.Core); pid > 0 {
			DebugLog("ControlHandler: killing pid %d", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}

		cmd := exec.Command(req.Core)
		cmd.Env = append(os.Environ(), coreEnvs[req.Core]...)
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Gid: 11111}}
		cmd.Stdout, cmd.Stderr = f, f

		if cmd.Start() != nil {
			DebugLog("ControlHandler: start failed")
			jsonResponse(w, Response{Success: false, Error: "Start fail"}, 500)
			return
		}

		limit := uint64(10000)
		if runtime.GOARCH == "arm64" { limit = 40000 }
		unix.Prlimit(cmd.Process.Pid, unix.RLIMIT_NOFILE, &unix.Rlimit{Cur: limit, Max: limit}, nil)
		go cmd.Wait()
		DebugLog("ControlHandler: soft restart done, pid=%d", cmd.Process.Pid)

	case "start", "stop", "hardRestart":
		arg := "-" + req.Action
		if req.Action == "hardRestart" { arg = "-restart" }
		DebugLog("ControlHandler: executing xkeen %s", arg)
		os.Truncate(ErrorLog, 0)
		c := exec.Command("xkeen", arg)
		c.Stdout, c.Stderr = f, f
		c.Run()
		DebugLog("ControlHandler: xkeen %s done", arg)

	default:
		DebugLog("ControlHandler: bad action %s", req.Action)
		jsonResponse(w, Response{Success: false, Error: "Bad action"}, 400)
		return
	}
	jsonResponse(w, Response{Success: true}, 200)
}
