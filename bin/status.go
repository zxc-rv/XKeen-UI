package bin
import (
	"net/http"
	"os/exec"
)
func StatusHandler(w http.ResponseWriter, r *http.Request) {
	running := exec.Command("pidof", "xray", "mihomo").Run() == nil
	status := "stopped"
	if running {
		status = "running"
	}
	jsonResponse(w, map[string]interface{}{"running": running, "status": status}, 200)
}