package bin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"time"
	"strings"
)

var (
	reXray   = regexp.MustCompile(`(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})`)
	reMihomo = regexp.MustCompile(`time="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"`)
)

func GetLogPath(logFile string) string {
	switch logFile {
	case "error.log":
		return "/opt/var/log/xray/error.log"
	case "access.log":
		return "/opt/var/log/xray/access.log"
	default:
		return "/opt/var/log/xray/error.log"
	}
}

func OpenLogFile() (*os.File, error) {
	logFile := "/opt/var/log/xray/error.log"
	return os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
}

func GetLogLines(logPath string) []string {
	stat, err := os.Stat(logPath)
	if err != nil {
		return []string{}
	}

	LogCacheMutex.Lock()
	if cache, exists := LogCacheMap[logPath]; exists && cache.LastSize == stat.Size() && cache.LastMod == stat.ModTime() {
		newCache := *cache
		newCache.LastRead = time.Now()
		LogCacheMap[logPath] = &newCache
		lines := cache.Lines
		LogCacheMutex.Unlock()
		return lines
	}
	LogCacheMutex.Unlock()

	content, err := os.ReadFile(logPath)
	if err != nil {
		return []string{}
	}

	adjusted := AdjustTimezone(string(content))
	lines := strings.Split(adjusted, "\n")
	var filteredLines []string
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			filteredLines = append(filteredLines, line)
		}
	}

	newCache := &LogCache{
		Content:  adjusted,
		Lines:    filteredLines,
		LastSize: stat.Size(),
		LastMod:  stat.ModTime(),
		LastRead: time.Now(),
	}

	LogCacheMutex.Lock()
	LogCacheMap[logPath] = newCache
	LogCacheMutex.Unlock()

	return filteredLines
}

func AdjustTimezone(content string) string {
	content = reXray.ReplaceAllStringFunc(content, func(match string) string {
		t, err := time.Parse("2006/01/02 15:04:05", match)
		if err != nil {
			return match
		}
		return t.Add(3 * time.Hour).Format("2006/01/02 15:04:05")
	})

	content = reMihomo.ReplaceAllStringFunc(content, func(match string) string {
		parts := reMihomo.FindStringSubmatch(match)
		if len(parts) != 2 {
			return match
		}
		t, err := time.Parse(time.RFC3339Nano, parts[1])
		if err != nil {
			return match
		}
		return fmt.Sprintf(`time="%s"`, t.Add(3*time.Hour).Format(time.RFC3339Nano))
	})

	return content
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
		content := ""
		if _, err := os.Stat(logPath); err == nil {
			data, err := os.ReadFile(logPath)
			if err == nil {
				content = AdjustTimezone(string(data))
			} else {
				jsonResponse(w, Response{Success: false, Error: "Ошибка чтения файла"}, 500)
				return
			}
		} else {
			content = fmt.Sprintf("Лог файл '%s' не найден", logFile)
		}
		jsonResponse(w, Response{Success: true, Data: content}, 200)
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
