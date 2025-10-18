package bin

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var Upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
	HandshakeTimeout: 10 * time.Second,
}

func WebsocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	var (
		connMutex  sync.Mutex
		stateMutex sync.RWMutex
		logFile    string
		logPath    string
		lastSize   int64
	)

	writeJSON := func(v interface{}) error {
		connMutex.Lock()
		defer connMutex.Unlock()
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(v)
	}

	logFileQuery := r.URL.Query().Get("file")
	if logFileQuery == "" {
		logFileQuery = "error.log"
	}

	stateMutex.Lock()
	logFile = logFileQuery
	logPath = GetLogPath(logFile)
	lastSize = 0
	stateMutex.Unlock()

	logDir := "/opt/var/log/xray/"
	if _, err := os.Stat(logDir); os.IsNotExist(err) {
		os.MkdirAll(logDir, 0755)
	}

	sendInitialLogs := func() {
		stateMutex.RLock()
		localLogPath := logPath
		stateMutex.RUnlock()

		lines := GetLogLines(localLogPath)
		displayLines := lines
		if len(lines) > 1000 {
			displayLines = lines[len(lines)-1000:]
		}
		if err := writeJSON(map[string]interface{}{
			"type":         "initial",
			"allLines":     lines,
			"displayLines": displayLines,
		}); err != nil {
			return
		}

		stat, err := os.Stat(localLogPath)
		if err == nil {
			stateMutex.Lock()
			lastSize = stat.Size()
			stateMutex.Unlock()
		} else {
			stateMutex.Lock()
			lastSize = 0
			stateMutex.Unlock()
		}
	}

	filterLogs := func(query string) {
		stateMutex.RLock()
		localLogPath := logPath
		stateMutex.RUnlock()

		lines := GetLogLines(localLogPath)
		var matchedLines []string
		for _, line := range lines {
			if strings.Contains(line, query) {
				matchedLines = append(matchedLines, line)
			}
		}
		writeJSON(map[string]interface{}{"type": "filtered", "lines": matchedLines})
	}

	sendInitialLogs()

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				var msg WSMessage
				if err := conn.ReadJSON(&msg); err != nil {
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
					stateMutex.Lock()
					logFile = msg.File
					logPath = GetLogPath(logFile)
					lastSize = 0
					stateMutex.Unlock()
					sendInitialLogs()
				}
				conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			}
		}
	}()

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			stateMutex.RLock()
			localLogPath := logPath
			localLastSize := lastSize
			stateMutex.RUnlock()

			stat, err := os.Stat(localLogPath)
			if err != nil {
				writeJSON(map[string]string{"type": "clear"})
				stateMutex.Lock()
				lastSize = 0
				stateMutex.Unlock()
				continue
			}

			currentSize := stat.Size()
			if currentSize < localLastSize {
				LogCacheMutex.Lock()
				delete(LogCacheMap, localLogPath)
				LogCacheMutex.Unlock()
				writeJSON(map[string]string{"type": "clear"})
				stateMutex.Lock()
				lastSize = 0
				stateMutex.Unlock()
				sendInitialLogs()
				continue
			}
			if currentSize > localLastSize {
				LogCacheMutex.Lock()
				delete(LogCacheMap, localLogPath)
				LogCacheMutex.Unlock()

				file, err := os.Open(localLogPath)
				if err != nil {
					continue
				}
				file.Seek(localLastSize, 0)
				newData, _ := io.ReadAll(file)
				file.Close()

				if len(newData) > 0 {
					if err := writeJSON(map[string]string{
						"type":    "append",
						"content": AdjustTimezone(string(newData)),
					}); err != nil {
						return
					}
				}
				stateMutex.Lock()
				lastSize = currentSize
				stateMutex.Unlock()
			}
		case <-ctx.Done():
			return
		}
	}
}
