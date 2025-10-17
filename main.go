package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/fcgi"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"github.com/gorilla/websocket"
	"gopkg.in/yaml.v2"
)

type ClientType struct {
	Name      string
	ConfigDir string
	ConfigExt string
	IsJSON    bool
}

var (
	clientTypes = map[string]ClientType{
		"xray": {
			Name:      "xray",
			ConfigDir: "/opt/etc/xray/configs",
			ConfigExt: "*.json",
			IsJSON:    true,
		},
		"mihomo": {
			Name:      "mihomo",
			ConfigDir: "/opt/etc/mihomo",
			ConfigExt: "config.yaml",
			IsJSON:    false,
		},
	}

	currentClient ClientType
)

type Response struct {
	Success bool        `json:"success"`
	Error   string      `json:"error,omitempty"`
	Data    interface{} `json:"data,omitempty"`
}

type Config struct {
	Name     string `json:"name"`
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

type ConfigsResponse struct {
	Success bool     `json:"success"`
	Configs []Config `json:"configs,omitempty"`
	Error   string   `json:"error,omitempty"`
}

type ActionRequest struct {
	Action   string `json:"action"`
	Filename string `json:"filename,omitempty"`
	Content  string `json:"content,omitempty"`
}

type WSMessage struct {
	Type  string `json:"type"`
	Query string `json:"query,omitempty"`
	File  string `json:"file,omitempty"`
}

type LogCache struct {
	content  string
	lines    []string
	lastSize int64
	lastMod  time.Time
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	HandshakeTimeout: 10 * time.Second,
}

var logCache = make(map[string]*LogCache)

func detectClientType() ClientType {
	initFiles := []string{"/opt/etc/init.d/S24xray", "/opt/etc/init.d/S99xkeen"}

	for _, initFile := range initFiles {
		log.Printf("Checking init file: %s", initFile)
		if _, err := os.Stat(initFile); err == nil {
			log.Printf("Init file exists: %s", initFile)
			content, err := os.ReadFile(initFile)
			if err != nil {
				log.Printf("Error reading %s: %v", initFile, err)
				continue
			}

			contentStr := string(content)
			log.Printf("Content preview: %s", contentStr[:min(len(contentStr), 200)])

			if strings.Contains(contentStr, `name_client="xray"`) {
				log.Printf("Found xray client in %s", initFile)
				if client, exists := clientTypes["xray"]; exists {
					return client
				}
			}

			if strings.Contains(contentStr, `name_client="mihomo"`) {
				log.Printf("Found mihomo client in %s", initFile)
				if client, exists := clientTypes["mihomo"]; exists {
					return client
				}
			}
		} else {
			log.Printf("Init file not found: %s", initFile)
		}
	}

	log.Printf("No client found, defaulting to xray")
	return clientTypes["xray"]
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func jsonResponse(w http.ResponseWriter, data interface{}, status int) {
	setCORSHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func adjustTimezone(content string) string {
	reXray := regexp.MustCompile(`(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})`)
	content = reXray.ReplaceAllStringFunc(content, func(match string) string {
		parts := reXray.FindStringSubmatch(match)
		if len(parts) != 7 {
			return match
		}

		year, _ := strconv.Atoi(parts[1])
		month, _ := strconv.Atoi(parts[2])
		day, _ := strconv.Atoi(parts[3])
		hour, _ := strconv.Atoi(parts[4])
		min, _ := strconv.Atoi(parts[5])
		sec, _ := strconv.Atoi(parts[6])

		t := time.Date(year, time.Month(month), day, hour, min, sec, 0, time.UTC)
		t = t.Add(3 * time.Hour)

		return t.Format("2006/01/02 15:04:05")
	})

	reMihomo := regexp.MustCompile(`time="(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d+)Z"`)
	content = reMihomo.ReplaceAllStringFunc(content, func(match string) string {
		parts := reMihomo.FindStringSubmatch(match)
		if len(parts) != 8 {
			return match
		}

		year, _ := strconv.Atoi(parts[1])
		month, _ := strconv.Atoi(parts[2])
		day, _ := strconv.Atoi(parts[3])
		hour, _ := strconv.Atoi(parts[4])
		min, _ := strconv.Atoi(parts[5])
		sec, _ := strconv.Atoi(parts[6])
		nsec, _ := strconv.Atoi(parts[7])

		t := time.Date(year, time.Month(month), day, hour, min, sec, nsec, time.UTC)
		t = t.Add(3 * time.Hour)

		return fmt.Sprintf(`time="%s"`, t.Format("2006-01-02T15:04:05.000000000Z"))
	})

	return content
}

func getLogLines(logPath string) []string {
	stat, err := os.Stat(logPath)
	if err != nil {
		return []string{}
	}

	cache, exists := logCache[logPath]
	if !exists || cache.lastSize != stat.Size() || cache.lastMod != stat.ModTime() {
		content, err := os.ReadFile(logPath)
		if err != nil {
			return []string{}
		}

		adjusted := adjustTimezone(string(content))
		lines := strings.Split(adjusted, "\n")

		var filteredLines []string
		for _, line := range lines {
			if strings.TrimSpace(line) != "" {
				filteredLines = append(filteredLines, line)
			}
		}

		logCache[logPath] = &LogCache{
			content:  adjusted,
			lines:    filteredLines,
			lastSize: stat.Size(),
			lastMod:  stat.ModTime(),
		}
		cache = logCache[logPath]
	}

	return cache.lines
}

func websocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	logFile := r.URL.Query().Get("file")
	if logFile == "" {
		logFile = "error.log"
	}

	var logPath string
	switch logFile {
	case "error.log":
		logPath = "/opt/var/log/xray/error.log"
	case "access.log":
		logPath = "/opt/var/log/xray/access.log"
	default:
		logPath = "/opt/var/log/xray/error.log"
	}

	logDir := "/opt/var/log/xray/"
	if _, err := os.Stat(logDir); os.IsNotExist(err) {
		os.MkdirAll(logDir, 0755)
	}

	var lastSize int64 = 0

	sendInitialLogs := func() {
		lines := getLogLines(logPath)
		displayLines := lines
		if len(lines) > 1000 {
			displayLines = lines[len(lines)-1000:]
		}

		if err := conn.WriteJSON(map[string]interface{}{
			"type":         "initial",
			"allLines":     lines,
			"displayLines": displayLines,
		}); err != nil {
			log.Println("WebSocket write error:", err)
			return
		}

		if stat, err := os.Stat(logPath); err == nil {
			lastSize = stat.Size()
		}
	}

	filterLogs := func(query string) {
		lines := getLogLines(logPath)
		var matchedLines []string
		for _, line := range lines {
			if strings.Contains(line, query) {
				matchedLines = append(matchedLines, line)
			}
		}

		if err := conn.WriteJSON(map[string]interface{}{
			"type":  "filtered",
			"lines": matchedLines,
		}); err != nil {
			log.Println("WebSocket write error:", err)
		}
	}

	sendInitialLogs()

	done := make(chan struct{})
	defer close(done)

	go func() {
		for {
			var msg WSMessage
			err := conn.ReadJSON(&msg)
			if err != nil {
				done <- struct{}{}
				return
			}

			if msg.Type == "ping" {
				conn.SetReadDeadline(time.Now().Add(60 * time.Second))
				continue
			}

			switch msg.Type {
			case "filter":
				filterLogs(msg.Query)
			case "switchFile":
				logFile = msg.File
				switch logFile {
				case "error.log":
					logPath = "/opt/var/log/xray/error.log"
				case "access.log":
					logPath = "/opt/var/log/xray/access.log"
				default:
					logPath = "/opt/var/log/xray/error.log"
				}
				lastSize = 0
				sendInitialLogs()
			}

			conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		}
	}()

	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			stat, err := os.Stat(logPath)
			if err != nil {
				if err := conn.WriteJSON(map[string]string{"type": "clear"}); err != nil {
					log.Println("WebSocket write error:", err)
					return
				}
				lastSize = 0
				continue
			}

			currentSize := stat.Size()

			if currentSize < lastSize {
				delete(logCache, logPath)
				if err := conn.WriteJSON(map[string]string{"type": "clear"}); err != nil {
					log.Println("WebSocket write error:", err)
					return
				}
				lastSize = 0
				sendInitialLogs()
				continue
			}

			if currentSize > lastSize {
				delete(logCache, logPath)
				file, err := os.Open(logPath)
				if err != nil {
					continue
				}

				file.Seek(lastSize, 0)
				newData, err := io.ReadAll(file)
				file.Close()

				if err == nil && len(newData) > 0 {
					if err := conn.WriteJSON(map[string]string{
						"type":    "append",
						"content": adjustTimezone(string(newData)),
					}); err != nil {
						log.Println("WebSocket write error:", err)
						return
					}
				}

				lastSize = currentSize
			}

			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))

		case <-done:
			return
		}
	}
}

func statusHandler(w http.ResponseWriter, r *http.Request) {
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

	jsonResponse(w, map[string]interface{}{
		"running": running,
		"status":  status,
	}, 200)
}

func logsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		logFile := r.URL.Query().Get("file")
		if logFile == "" {
			logFile = "error.log"
		}

		var logPath string
		switch logFile {
		case "error.log":
			logPath = "/opt/var/log/xray/error.log"
		case "access.log":
			logPath = "/opt/var/log/xray/access.log"
		default:
			jsonResponse(w, Response{Success: false, Error: "Доступ к этому файлу запрещен"}, 400)
			return
		}

		content := ""
		if _, err := os.Stat(logPath); err == nil {
			data, err := os.ReadFile(logPath)
			if err == nil {
				content = adjustTimezone(string(data))
			} else {
				jsonResponse(w, Response{Success: false, Error: "Ошибка чтения файла"}, 500)
				return
			}
		} else {
			content = fmt.Sprintf("Лог файл '%s' не найден", logFile)
		}

		jsonResponse(w, Response{Success: true, Data: content}, 200)

	case "POST":
		body, err := io.ReadAll(r.Body)
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Cannot read request body"}, 400)
			return
		}

		var req struct {
			Action string `json:"action"`
			File   string `json:"file"`
		}

		if err := json.Unmarshal(body, &req); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
			return
		}

		if req.Action == "clear" {
			var logPath string
			switch req.File {
			case "error.log":
				logPath = "/opt/var/log/xray/error.log"
			case "access.log":
				logPath = "/opt/var/log/xray/access.log"
			default:
				jsonResponse(w, Response{Success: false, Error: "Недопустимый файл лога"}, 400)
				return
			}

			if err := os.Truncate(logPath, 0); err != nil {
				jsonResponse(w, Response{Success: false, Error: "Ошибка очистки файла лога"}, 500)
				return
			}

			delete(logCache, logPath)
			jsonResponse(w, Response{Success: true, Data: "Лог очищен"}, 200)
		} else {
			jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
		}

	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}

func configsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		getConfigs(w, r)
	case "POST":
		postConfigs(w, r)
	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}

func isValidYAML(content string) bool {
	var data interface{}
	return yaml.Unmarshal([]byte(content), &data) == nil
}

func getConfigs(w http.ResponseWriter, r *http.Request) {
	// Обновляем тип клиента при каждом запросе
	currentClient = detectClientType()

	if _, err := os.Stat(currentClient.ConfigDir); os.IsNotExist(err) {
		jsonResponse(w, ConfigsResponse{Success: false, Error: "Директория конфигов не найдена"}, 404)
		return
	}

	var configs []Config

	if currentClient.IsJSON {
		files, err := filepath.Glob(filepath.Join(currentClient.ConfigDir, currentClient.ConfigExt))
		if err != nil {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "Ошибка чтения директории конфигов"}, 500)
			return
		}

		if len(files) == 0 {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "JSON конфиги не найдены"}, 404)
			return
		}

		for _, file := range files {
			content, err := os.ReadFile(file)
			if err != nil {
				continue
			}

			filename := filepath.Base(file)
			name := strings.TrimSuffix(filename, ".json")

			configs = append(configs, Config{
				Name:     name,
				Filename: filename,
				Content:  string(content),
			})
		}
	} else {
		configPath := filepath.Join(currentClient.ConfigDir, currentClient.ConfigExt)

		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "YAML конфиг не найден"}, 404)
			return
		}

		content, err := os.ReadFile(configPath)
		if err != nil {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "Ошибка чтения конфига"}, 500)
			return
		}

		configs = append(configs, Config{
			Name:     "config",
			Filename: currentClient.ConfigExt,
			Content:  string(content),
		})
	}

	// Добавляем .lst файлы из /opt/etc/xkeen
	xkeenDir := "/opt/etc/xkeen"
	if _, err := os.Stat(xkeenDir); err == nil {
		lstFiles, err := filepath.Glob(filepath.Join(xkeenDir, "*.lst"))
		if err == nil {
			for _, file := range lstFiles {
				content, err := os.ReadFile(file)
				if err != nil {
					continue
				}

				filename := filepath.Base(file)
				name := strings.TrimSuffix(filename, ".lst")

				configs = append(configs, Config{
					Name:     name,
					Filename: filename,
					Content:  string(content),
				})
			}
		}
	}

	jsonResponse(w, ConfigsResponse{Success: true, Configs: configs}, 200)
}

func postConfigs(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Cannot read request body"}, 400)
		return
	}

	var req ActionRequest
	if err := json.Unmarshal(body, &req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
		return
	}

	switch req.Action {
	case "save":
		filename := req.Filename
		var filePath string

		if strings.HasSuffix(filename, ".lst") {
			filePath = filepath.Join("/opt/etc/xkeen", filename)
		} else {
			if currentClient.IsJSON {
				if !strings.HasSuffix(filename, ".json") {
					filename += ".json"
				}
			} else {
				if !isValidYAML(req.Content) {
					jsonResponse(w, Response{Success: false, Error: "Невалидный YAML"}, 400)
					return
				}
			}
			filePath = filepath.Join(currentClient.ConfigDir, filename)
		}

		if err := os.WriteFile(filePath, []byte(req.Content), 0644); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка записи файла"}, 500)
		} else {
			jsonResponse(w, Response{Success: true}, 200)
		}

	case "delete":
		filename := req.Filename
		var filePath string

		if strings.HasSuffix(filename, ".lst") {
			filePath = filepath.Join("/opt/etc/xkeen", filename)
		} else {
			if currentClient.IsJSON && !strings.HasSuffix(filename, ".json") {
				filename += ".json"
			}
			filePath = filepath.Join(currentClient.ConfigDir, filename)
		}

		if err := os.Remove(filePath); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка удаления файла"}, 500)
		} else {
			jsonResponse(w, Response{Success: true}, 200)
		}

	default:
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
	}
}

func controlHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		jsonResponse(w, Response{Success: false, Error: "Only POST allowed"}, 405)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Cannot read request body"}, 400)
		return
	}

	var req struct {
		Action string `json:"action"`
		Core   string `json:"core,omitempty"`
	}

	if err := json.Unmarshal(body, &req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
		return
	}

	if req.Action == "restartCore" {
		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Invalid core"}, 400)
			return
		}

		script := fmt.Sprintf(`
		. "/opt/sbin/.xkeen/01_info/03_info_cpu.sh"
		status_file="/opt/lib/opkg/status"
		info_cpu
		name_client="%s"
		killall -q -9 $name_client
		case "$name_client" in
				xray)
						export XRAY_LOCATION_CONFDIR="/opt/etc/xray/configs"
						export XRAY_LOCATION_ASSET="/opt/etc/xray/dat"
						if [ "$architecture" = "arm64-v8a" ]; then
								ulimit -SHn "40000" && su -c "xray run" "xkeen" >/dev/null 2>&1 &
						else
								ulimit -SHn "10000" && su -c "xray run" "xkeen" >/dev/null 2>&1 &
						fi
				;;
				mihomo)
						if [ "$architecture" = "arm64-v8a" ]; then
								ulimit -SHn "40000" && su -c "mihomo -d /opt/etc/mihomo" "xkeen" >>/opt/var/log/xray/error.log 2>&1 &
						else
								ulimit -SHn "10000" && su -c "mihomo -d /opt/etc/mihomo" "xkeen" >>/opt/var/log/xray/error.log 2>&1 &
						fi
				;;
		esac
		`, req.Core)

		cmd := exec.Command("sh", "-c", script)

		logFile := "/opt/var/log/xray/error.log"
		logFileHandle, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Cannot open log file"}, 500)
			return
		}
		defer logFileHandle.Close()

		cmd.Stdout = logFileHandle
		cmd.Stderr = logFileHandle

		if err := cmd.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
		} else {
			jsonResponse(w, Response{Success: true, Data: "Core restarted"}, 200)
		}
		return
	}

	var cmd *exec.Cmd
	switch req.Action {
	case "start":
		cmd = exec.Command("xkeen", "-start")
	case "stop":
		cmd = exec.Command("xkeen", "-stop")
	case "restart":
		cmd = exec.Command("xkeen", "-restart")
	default:
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
		return
	}

	logFile := "/opt/var/log/xray/error.log"
	os.Truncate(logFile, 0)

	logFileHandle, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		jsonResponse(w, Response{Success: false, Error: "Cannot open log file"}, 500)
		return
	}
	defer logFileHandle.Close()

	cmd.Stdout = logFileHandle
	cmd.Stderr = logFileHandle

	if err := cmd.Run(); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Command failed"}, 500)
	} else {
		jsonResponse(w, Response{Success: true, Data: "Command executed"}, 200)
	}
}

func coreHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		cores := []string{}
		if _, err := os.Stat("/opt/sbin/xray"); err == nil {
			cores = append(cores, "xray")
		}
		if _, err := os.Stat("/opt/sbin/mihomo"); err == nil {
			cores = append(cores, "mihomo")
		}

		currentCore := detectClientType().Name

		jsonResponse(w, map[string]interface{}{
			"success":     true,
			"cores":       cores,
			"currentCore": currentCore,
		}, 200)

	case "POST":
		body, err := io.ReadAll(r.Body)
		if err != nil {
			jsonResponse(w, Response{Success: false, Error: "Cannot read request body"}, 400)
			return
		}

		var req struct {
			Core string `json:"core"`
		}

		if err := json.Unmarshal(body, &req); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
			return
		}

		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Недопустимое ядро"}, 400)
			return
		}

		currentCore := detectClientType().Name

		logFile := "/opt/var/log/xray/error.log"
		if currentCore == "xray" && req.Core == "mihomo" {
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

		cmd1.Stdout = logFileHandle
		cmd1.Stderr = logFileHandle
		cmd2.Stdout = logFileHandle
		cmd2.Stderr = logFileHandle

		if err := cmd1.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка смены ядра"}, 500)
			return
		}

		if err := cmd2.Run(); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка запуска ядра"}, 500)
			return
		}

		jsonResponse(w, Response{Success: true, Data: "Ядро изменено и запущено"}, 200)

	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}

func main() {
	currentClient = detectClientType()
	log.Printf("Detected client: %s, config dir: %s", currentClient.Name, currentClient.ConfigDir)

	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/cgi/status", statusHandler)
		mux.HandleFunc("/cgi/logs", logsHandler)
		mux.HandleFunc("/cgi/configs", configsHandler)
		mux.HandleFunc("/cgi/control", controlHandler)
		mux.HandleFunc("/cgi/core", coreHandler)

		if err := fcgi.Serve(nil, mux); err != nil {
			log.Println("Error from fcgi.Serve:", err)
		}
	}()

	http.HandleFunc("/ws", websocketHandler)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
