package bin

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
)

func CoreHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		cores := []string{}
		if _, err := os.Stat("/opt/sbin/xray"); err == nil {
			cores = append(cores, "xray")
		}
		if _, err := os.Stat("/opt/sbin/mihomo"); err == nil {
			cores = append(cores, "mihomo")
		}

		ClientMutex.RLock()
		currentCoreName := CurrentClient.Name
		ClientMutex.RUnlock()

		jsonResponse(w, map[string]interface{}{
			"success":     true,
			"cores":       cores,
			"currentCore": currentCoreName,
		}, 200)
	case "POST":
		var req struct{ Core string `json:"core"` }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
			return
		}
		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Недопустимое ядро"}, 400)
			return
		}

		logFile := "/opt/var/log/xray/error.log"

		ClientMutex.RLock()
		currentCoreName := CurrentClient.Name
		ClientMutex.RUnlock()

		if currentCoreName == "xray" && req.Core == "mihomo" {
			os.Truncate(logFile, 0)
		}

		logFileHandle, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Cannot open log file"}, 500)
			return
		}
		defer logFileHandle.Close()
		var cmd1, cmd2 *exec.Cmd
		if req.Core == "mihomo" {
			cmd1 = exec.Command("xkeen", "-mihomo")
		} else {
			cmd1 = exec.Command("xkeen", "-xray")
		}
		cmd2 = exec.Command("xkeen", "-start")
		cmd1.Stdout, cmd1.Stderr = logFileHandle, logFileHandle
		cmd2.Stdout, cmd2.Stderr = logFileHandle, logFileHandle
		if err := cmd1.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка смены ядра"}, 500)
			return
		}
		if err := cmd2.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка запуска ядра"}, 500)
			return
		}

		ClientMutex.Lock()
		if client, exists := clientTypes[req.Core]; exists {
			CurrentClient = client
		}
		ClientMutex.Unlock()

		jsonResponse(w, Response{Success: true, Data: "Ядро изменено и запущено"}, 200)
	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}