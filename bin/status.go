package bin

import (
	"net/http"
	"os/exec"
	"strings"
)

func StatusHandler(w http.ResponseWriter, r *http.Request) {
	cmd := exec.Command("xkeen", "-status")
	output, err := cmd.CombinedOutput()
	running := false
	if err == nil {
		cleanOutput := strings.ReplaceAll(string(output), "\x1b[", "")
		running = strings.Contains(cleanOutput, "запущен") && !strings.Contains(cleanOutput, "не запущен")
	}
	status := "stopped"
	if running {
		status = "running"
	}
	jsonResponse(w, map[string]interface{}{"running": running, "status": status}, 200)
}