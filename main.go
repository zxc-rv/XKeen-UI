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
)

const CONFIGS_DIR = "/opt/etc/xray/configs"

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
	re := regexp.MustCompile(`(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})`)

	return re.ReplaceAllStringFunc(content, func(match string) string {
		parts := re.FindStringSubmatch(match)
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

func getConfigs(w http.ResponseWriter, r *http.Request) {
	if _, err := os.Stat(CONFIGS_DIR); os.IsNotExist(err) {
		os.MkdirAll(CONFIGS_DIR, 0755)
	}

	var configs []Config

	files, err := filepath.Glob(filepath.Join(CONFIGS_DIR, "*.json"))
	if err != nil {
		jsonResponse(w, ConfigsResponse{Success: false, Error: "Cannot read configs directory"}, 500)
		return
	}

	if len(files) == 0 {
		defaultConfig := `{
  "log": {"loglevel": "warning"},
  "inbounds": [],
  "outbounds": []
}`
		configPath := filepath.Join(CONFIGS_DIR, "config.json")
		os.WriteFile(configPath, []byte(defaultConfig), 0644)
		configs = append(configs, Config{
			Name:     "config",
			Filename: "config.json",
			Content:  defaultConfig,
		})
	} else {
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
		if !strings.HasSuffix(filename, ".json") {
			filename += ".json"
		}

		filePath := filepath.Join(CONFIGS_DIR, filename)
		if err := os.WriteFile(filePath, []byte(req.Content), 0644); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка записи файла"}, 500)
		} else {
			jsonResponse(w, Response{Success: true}, 200)
		}

	case "delete":
		filename := req.Filename
		if !strings.HasSuffix(filename, ".json") {
			filename += ".json"
		}

		filePath := filepath.Join(CONFIGS_DIR, filename)
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

	var req ActionRequest
	if err := json.Unmarshal(body, &req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
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

func main() {
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/cgi/status", statusHandler)
		mux.HandleFunc("/cgi/logs", logsHandler)
		mux.HandleFunc("/cgi/configs", configsHandler)
		mux.HandleFunc("/cgi/control", controlHandler)

		if err := fcgi.Serve(nil, mux); err != nil {
			log.Println("Error from fcgi.Serve:", err)
		}
	}()

	http.HandleFunc("/ws", websocketHandler)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
