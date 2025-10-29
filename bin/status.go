package bin
import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
)
func updateCurrentClient() error {
    var initFile string
    if _, err := os.Stat("/opt/etc/init.d/S24xray"); err == nil {
        initFile = "/opt/etc/init.d/S24xray"
    } else if _, err := os.Stat("/opt/etc/init.d/S99xkeen"); err == nil {
        initFile = "/opt/etc/init.d/S99xkeen"
    } else {
        return fmt.Errorf("init files not found")
    }

    currentCore := "xray"
    content, err := os.ReadFile(initFile)
    if err != nil {
        return fmt.Errorf("cannot read init file: %v", err)
    }

    if strings.Contains(string(content), "name_client=\"mihomo\"") {
        currentCore = "mihomo"
    }

    ClientMutex.Lock()
    CurrentClient = clientTypes[currentCore]
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