package bin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

var (
	reXray   = regexp.MustCompile(`\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}`)
	reMihomo = regexp.MustCompile(`time="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)" level=(\w+) msg="(.+)"`)

	mihomoLevelMap = map[string]string{
		"debug":   "[DEBUG]",
		"info":    "[INFO]",
		"warning": "[WARN]",
		"error":   "[ERROR]",
		"fatal":   "[FATAL]",
	}

	xrayLevelReplacer = strings.NewReplacer(
		"[Debug]", "[DEBUG]",
		"[Info]", "[INFO]",
		"[Warning]", "[WARN]",
		"[Error]", "[ERROR]",
	)
)

func GetLogPath(logFile string) string {
	if logFile == "access.log" {
		return "/opt/var/log/xray/access.log"
	}
	return "/opt/var/log/xray/error.log"
}

func GetLogLines(logPath string) []string {
	stat, err := os.Stat(logPath)
	if err != nil {
		return []string{}
	}

	LogCacheMutex.Lock()
	defer LogCacheMutex.Unlock()

	if cache, exists := LogCacheMap[logPath]; exists && cache.LastSize == stat.Size() && cache.LastMod == stat.ModTime() {
		cache.LastRead = time.Now()
		return cache.Lines
	}

	content, err := os.ReadFile(logPath)
	if err != nil {
		return []string{}
	}

	adjusted := AdjustTimezone(string(content))
	lines := strings.Split(adjusted, "\n")
	filteredLines := make([]string, 0, len(lines))
	for _, line := range lines {
		if line = strings.TrimSpace(line); line != "" {
			filteredLines = append(filteredLines, line)
		}
	}

	LogCacheMap[logPath] = &LogCache{
		Content:  adjusted,
		Lines:    filteredLines,
		LastSize: stat.Size(),
		LastMod:  stat.ModTime(),
		LastRead: time.Now(),
	}

	return filteredLines
}

func OpenLogFile() (*os.File, error) {
	logFile := "/opt/var/log/xray/error.log"
	return os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
}

func AdjustTimezone(content string) string {
	content = reXray.ReplaceAllStringFunc(content, func(m string) string {
		t, err := time.Parse("2006/01/02 15:04:05", m)
		if err != nil {
			return m
		}
		return t.Add(3 * time.Hour).Format("2006/01/02 15:04:05")
	})

	content = reMihomo.ReplaceAllStringFunc(content, func(m string) string {
		p := reMihomo.FindStringSubmatch(m)
		if len(p) != 4 {
			return m
		}
		t, err := time.Parse(time.RFC3339Nano, p[1])
		if err != nil {
			return m
		}
		lvl := mihomoLevelMap[p[2]]
		if lvl == "" {
			lvl = "[INFO]"
		}
		b := make([]byte, 0, 64)
		b = t.Add(3 * time.Hour).AppendFormat(b, "2006/01/02 15:04:05.000000")
		b = append(b, ' ')
		b = append(b, lvl...)
		b = append(b, ' ')
		b = append(b, p[3]...)
		return string(b)
	})

	return xrayLevelReplacer.Replace(content)
}

func CleanupLogCache() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		LogCacheMutex.Lock()
		now := time.Now()
		for path, cache := range LogCacheMap {
			if now.Sub(cache.LastRead) > 10*time.Minute {
				delete(LogCacheMap, path)
			}
		}
		LogCacheMutex.Unlock()
	}
}

func LogsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		logFile := r.URL.Query().Get("file")
		logPath := GetLogPath(logFile)
		lines := GetLogLines(logPath)
		if lines == nil {
			jsonResponse(w, Response{Success: false, Error: fmt.Sprintf("Лог файл '%s' не найден", logFile)}, 404)
			return
		}
		jsonResponse(w, Response{Success: true, Data: strings.Join(lines, "\n")}, 200)
	case "POST":
		var req struct {
			Action string `json:"action"`
			File   string `json:"file"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
			return
		}
		if req.Action == "clear" {
			logPath := GetLogPath(req.File)
			LogCacheMutex.Lock()
			delete(LogCacheMap, logPath)
			LogCacheMutex.Unlock()
			if err := os.Truncate(logPath, 0); err != nil {
				jsonResponse(w, Response{Success: false, Error: "Ошибка очистки файла"}, 500)
				return
			}
			jsonResponse(w, Response{Success: true, Data: "Log cleared"}, 200)
			return
		}
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}