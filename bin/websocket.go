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
		log.Println("upgrade:", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn.SetReadDeadline(time.Now().Add(65 * time.Second))

	var (
		connMutex  sync.Mutex
		stateMutex sync.RWMutex
		logPath    string
		lastSize   int64
	)

	writeJSON := func(v interface{}) error {
		connMutex.Lock()
		defer connMutex.Unlock()
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(v)
	}

	stateMutex.Lock()
	logFile := r.URL.Query().Get("file")
	if logFile == "" {
		logFile = "error.log"
	}
	logPath = GetLogPath(logFile)
	stateMutex.Unlock()

	logDir := "/opt/var/log/xray/"
	if _, err := os.Stat(logDir); os.IsNotExist(err) {
		os.MkdirAll(logDir, 0755)
	}

	sendLogs := func() {
		stateMutex.RLock()
		lp := logPath
		stateMutex.RUnlock()

		lines := GetLogLines(lp)
		dl := lines
		if len(lines) > 1000 {
			dl = lines[len(lines)-1000:]
		}
		if err := writeJSON(map[string]interface{}{"type": "initial", "allLines": lines, "displayLines": dl}); err != nil {
			return
		}

		if stat, err := os.Stat(lp); err == nil {
			stateMutex.Lock()
			lastSize = stat.Size()
			stateMutex.Unlock()
		}
	}

	sendLogs()

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
				logPath = GetLogPath(msg.File)
				lastSize = 0
				stateMutex.Unlock()
				sendLogs()
			}
		}
	}()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stateMutex.RLock()
			lp := logPath
			lz := lastSize
			stateMutex.RUnlock()

			stat, err := os.Stat(lp)
			if err != nil || stat.Size() < lz {
				writeJSON(map[string]string{"type": "clear"})
				stateMutex.Lock()
				lastSize = 0
				stateMutex.Unlock()
				if err == nil {
					sendLogs()
				}
				continue
			}

			if stat.Size() > lz {
				file, err := os.Open(lp)
				if err != nil {
					continue
				}
				file.Seek(lz, 0)
				data, _ := io.ReadAll(file)
				file.Close()

				if len(data) > 0 {
					if err := writeJSON(map[string]string{"type": "append", "content": AdjustTimezone(string(data))}); err != nil {
						return
					}
					stateMutex.Lock()
					lastSize = stat.Size()
					stateMutex.Unlock()
				}
			}
		}
	}
}
