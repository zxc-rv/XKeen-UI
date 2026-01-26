
package bin

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const ErrorLogPath = "/opt/var/log/xray/error.log"
const AccessLogPath = "/opt/var/log/xray/access.log"

var (
	reXray         = regexp.MustCompile(`\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}`)
	reMihomo       = regexp.MustCompile(`time="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)" level=(\w+) msg="(.+)"`)
	ansiRegex      = regexp.MustCompile(`\x1b\[\d+m`)
	levelRegex     = regexp.MustCompile(`\[(DEBUG|INFO|WARN|ERROR|FATAL)\]`)
	levelWordRegex = regexp.MustCompile(`\b(DEBUG|INFO|WARN|ERROR|FATAL)\b`)

	mihomoLevelMap = map[string]string{
		"debug": "[DEBUG]", "info": "[INFO]", "warning": "[WARN]",
		"error": "[ERROR]", "fatal": "[FATAL]",
	}

	ansiReplacer = strings.NewReplacer(
		"\u001b[32m", `<span style="color: #00cc00;">`,
		"\u001b[92m", `<span style="color: #00cc00;">`,
		"\u001b[31m", `<span style="color: #ef4444;">`,
		"\u001b[91m", `<span style="color: #ef4444;">`,
		"\u001b[33m", `<span style="color: #f59e0b;">`,
		"\u001b[93m", `<span style="color: #f59e0b;">`,
		"\u001b[96m", `<span style="color: #8BCEF7;">`,
		"\u001b[0m", "</span>",
	)

	xrayLevelReplacer = strings.NewReplacer(
		"[Debug]", "[DEBUG]", "[Info]", "[INFO]",
		"[Warning]", "[WARN]", "[Error]", "[ERROR]",
	)
)

type Mutex struct{ ch chan struct{} }

func (m *Mutex) Lock() {
	if m.ch == nil {
		m.ch = make(chan struct{}, 1)
	}
	m.ch <- struct{}{}
}

func (m *Mutex) Unlock() { <-m.ch }

func formatLevel(level string) string {
	l := strings.ToLower(level)
	return fmt.Sprintf(`<span class="log-badge log-badge-%s" data-filter="%s">%s</span>`, l, level, level)
}

func adjustLineTimezone(line string, offset int) string {
	if offset == 0 {
		return xrayLevelReplacer.Replace(line)
	}

	d := time.Duration(offset) * time.Hour

	line = reXray.ReplaceAllStringFunc(line, func(m string) string {
		if t, err := time.Parse("2006/01/02 15:04:05", m); err == nil {
			return t.Add(d).Format("2006/01/02 15:04:05")
		}
		return m
	})

	line = reMihomo.ReplaceAllStringFunc(line, func(m string) string {
		p := reMihomo.FindStringSubmatch(m)
		if len(p) != 4 {
			return m
		}
		if t, err := time.Parse(time.RFC3339Nano, p[1]); err == nil {
			lvl := mihomoLevelMap[p[2]]
			if lvl == "" {
				lvl = "[INFO]"
			}
			return t.Add(d).Format("2006/01/02 15:04:05.000000") + " " + lvl + " " + p[3]
		}
		return m
	})

	return xrayLevelReplacer.Replace(line)
}

func AdjustTimezone(s string) string {
	AppSettingsMutex.RLock()
	offset := AppSettings.TimezoneOffset
	AppSettingsMutex.RUnlock()

	if offset == 0 {
		return xrayLevelReplacer.Replace(s)
	}

	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = adjustLineTimezone(lines[i], offset)
	}
	return strings.Join(lines, "\n")
}

func parseLogLine(line string) string {
	if line == "" {
		return ""
	}

	content := ansiReplacer.Replace(line)
	content = ansiRegex.ReplaceAllString(content, "")

	hasBadge := false
	content = levelRegex.ReplaceAllStringFunc(content, func(m string) string {
		hasBadge = true
		return formatLevel(strings.Trim(m, "[]"))
	})

	if !hasBadge {
		content = levelWordRegex.ReplaceAllStringFunc(content, func(m string) string {
			return formatLevel(m)
		})
	}

	var b strings.Builder
	b.Grow(len(content) + 32)
	b.WriteString(`<div class="log-line">`)
	b.WriteString(content)
	b.WriteString(`</div>`)
	return b.String()
}

func GetLogLines(logPath string) []string {
	stat, err := os.Stat(logPath)
	if err != nil {
		return []string{}
	}

	LogCacheMutex.Lock()
	cache := LogCacheMap[logPath]
	if cache == nil {
		cache = &LogCache{}
		LogCacheMap[logPath] = cache
	}
	LogCacheMutex.Unlock()

	if cache.LastSize == stat.Size() && cache.LastMod.Equal(stat.ModTime()) {
		cache.LastRead = time.Now()
		return cache.Lines
	}

	f, err := os.Open(logPath)
	if err != nil {
		return []string{}
	}
	defer f.Close()

	if stat.Size() < cache.LastOffset {
		cache.LastOffset = 0
		cache.Lines = nil
	}

	f.Seek(cache.LastOffset, 0)

	AppSettingsMutex.RLock()
	offset := AppSettings.TimezoneOffset
	AppSettingsMutex.RUnlock()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := adjustLineTimezone(scanner.Text(), offset)
		html := parseLogLine(line)
		if html != "" {
			cache.Lines = append(cache.Lines, html)
		}
	}

	pos, _ := f.Seek(0, 1)

	if len(cache.Lines) > 5000 {
		cache.Lines = cache.Lines[len(cache.Lines)-5000:]
	}

	cache.LastOffset = pos
	cache.LastSize = stat.Size()
	cache.LastMod = stat.ModTime()
	cache.LastRead = time.Now()

	return cache.Lines
}

func OpenLogFile() (*os.File, error) {
	return os.OpenFile(ErrorLogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
}

func CleanupLogCache() {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for range t.C {
		LogCacheMutex.Lock()
		now := time.Now()
		for k, v := range LogCacheMap {
			if now.Sub(v.LastRead) > 10*time.Minute {
				delete(LogCacheMap, k)
			}
		}
		LogCacheMutex.Unlock()
	}
}

func LogsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		logPath := ErrorLogPath
		if r.URL.Query().Get("file") == "access.log" {
			logPath = AccessLogPath
		}
		lines := GetLogLines(logPath)
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
		defer r.Body.Close()
		if req.Action == "clear" {
			logPath := ErrorLogPath
			if req.File == "access.log" {
				logPath = AccessLogPath
			}
			LogCacheMutex.Lock()
			delete(LogCacheMap, logPath)
			LogCacheMutex.Unlock()
			os.Truncate(logPath, 0)
			jsonResponse(w, Response{Success: true, Data: "Log cleared"}, 200)
			return
		}
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}
