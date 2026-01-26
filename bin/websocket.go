package bin

import (
	"bufio"
	"context"
	"github.com/gorilla/websocket"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

var Upgrader = websocket.Upgrader{
	CheckOrigin:      func(r *http.Request) bool { return true },
	HandshakeTimeout: 10 * time.Second,
}

func WebsocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade:", err)
		return
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn.SetReadDeadline(time.Now().Add(120 * time.Second))
	var (
		connMutex  sync.Mutex
		stateMutex sync.RWMutex
		logPath    string
		lastOffset int64
	)
	writeJSON := func(v interface{}) error {
		connMutex.Lock()
		defer connMutex.Unlock()
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(v)
	}
	stateMutex.Lock()
	logPath = ErrorLogPath
	if r.URL.Query().Get("file") == "access.log" {
		logPath = AccessLogPath
	}
	lastOffset = 0
	stateMutex.Unlock()
	sendInitial := func() {
		stateMutex.RLock()
		lp := logPath
		stateMutex.RUnlock()
		lines := GetLogLines(lp)
		dl := lines
		if len(lines) > 1000 {
			dl = lines[len(lines)-1000:]
		}
		if err := writeJSON(map[string]interface{}{
			"type":         "initial",
			"allLines":     lines,
			"displayLines": dl,
		}); err != nil {
			return
		}
		if stat, err := os.Stat(lp); err == nil {
			stateMutex.Lock()
			lastOffset = stat.Size()
			stateMutex.Unlock()
		}
	}
	sendInitial()
	go func() {
		defer cancel()
		for {
			var msg struct {
				Type  string `json:"type"`
				Query string `json:"query"`
				File  string `json:"file"`
			}
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			conn.SetReadDeadline(time.Now().Add(120 * time.Second))
			switch msg.Type {
			case "filter":
				stateMutex.RLock()
				lp := logPath
				stateMutex.RUnlock()
				lines := GetLogLines(lp)
				q := strings.Split(msg.Query, "|")
				var matched []string
				for _, l := range lines {
					for _, k := range q {
						if k != "" && strings.Contains(l, k) {
							matched = append(matched, l)
							break
						}
					}
				}
				writeJSON(map[string]interface{}{"type": "filtered", "lines": matched})
			case "switchFile":
				stateMutex.Lock()
				logPath = ErrorLogPath
				if msg.File == "access.log" {
					logPath = AccessLogPath
				}
				lastOffset = 0
				stateMutex.Unlock()
				sendInitial()
			case "reload":
				LogCacheMutex.Lock()
				LogCacheMap = make(map[string]*LogCache)
				LogCacheMutex.Unlock()
				stateMutex.Lock()
				lastOffset = 0
				stateMutex.Unlock()
				sendInitial()
			}
		}
	}()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stateMutex.RLock()
			lp := logPath
			off := lastOffset
			stateMutex.RUnlock()
			stat, err := os.Stat(lp)
			if err != nil || stat.Size() < off {
				writeJSON(map[string]string{"type": "clear"})
				stateMutex.Lock()
				lastOffset = 0
				stateMutex.Unlock()
				if err == nil {
					sendInitial()
				}
				continue
			}
			if stat.Size() == off {
				continue
			}
			f, err := os.Open(lp)
			if err != nil {
				continue
			}
			f.Seek(off, 0)
			AppSettingsMutex.RLock()
			tz := AppSettings.TimezoneOffset
			AppSettingsMutex.RUnlock()
			scanner := bufio.NewScanner(f)
			var out []string
			for scanner.Scan() {
				line := adjustLineTimezone(scanner.Text(), tz)
				html := parseLogLine(line)
				if html != "" {
					out = append(out, html)
				}
			}
			pos, _ := f.Seek(0, 1)
			f.Close()
			if len(out) > 0 {
				if err := writeJSON(map[string]interface{}{
					"type":    "append",
					"content": strings.Join(out, "\n"),
				}); err != nil {
					return
				}
			}
			stateMutex.Lock()
			lastOffset = pos
			stateMutex.Unlock()
		}
	}
}
