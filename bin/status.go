package bin
import (
	"net/http"
	"os/exec"
)
func updateCurrentClient() (xrayRunning, mihomoRunning bool) {
	xrayRunning = exec.Command("pidof", "xray").Run() == nil
	mihomoRunning = exec.Command("pidof", "mihomo").Run() == nil

	ClientMutex.Lock()
	if xrayRunning {
		CurrentClient = clientTypes["xray"]
	} else if mihomoRunning {
		CurrentClient = clientTypes["mihomo"]
	}
	ClientMutex.Unlock()

	return
}

func StatusHandler(w http.ResponseWriter, r *http.Request) {
	xrayRunning, mihomoRunning := updateCurrentClient()

	running := xrayRunning || mihomoRunning
	status := "stopped"
	if running {
		status = "running"
	}

	jsonResponse(w, map[string]interface{}{"running": running, "status": status}, 200)
}