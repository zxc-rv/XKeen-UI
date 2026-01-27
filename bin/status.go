package bin

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
)

func updateCurrentClient() error {
	path := S24xray
	if _, err := os.Stat(path); err != nil {
		path = S99xkeen
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("init files not found")
		}
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	name := "xray"
	if strings.Contains(string(content), "name_client=\"mihomo\"") {
		name = "mihomo"
	}

	ClientMutex.Lock()
	CurrentClient = clientTypes[name]
	ClientMutex.Unlock()
	return nil
}

func StatusHandler(w http.ResponseWriter, r *http.Request) {
	if err := updateCurrentClient(); err != nil {
		jsonResponse(w, Response{Success: false, Error: err.Error()}, 500)
		return
	}

	running := exec.Command("pidof", "xray", "mihomo").Run() == nil
	status := "stopped"
	if running {
		status = "running"
	}

	jsonResponse(w, map[string]interface{}{"running": running, "status": status}, 200)
}
