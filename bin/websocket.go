package bin

import (
	"bufio"
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/websocket"
)

var Upgrader = websocket.Upgrader{
	CheckOrigin:      func(r *http.Request) bool { return true },
	HandshakeTimeout: 10 * time.Second,
}

var activeWSCount int32

func WebsocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade:", err)
		return
	}
	atomic.AddInt32(&activeWSCount, 1)
	DebugLog("WebsocketHandler: connection opened, active=%d", atomic.LoadInt32(&activeWSCount))
	defer func() {
		conn.Close()
		atomic.AddInt32(&activeWSCount, -1)
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var (
		mu         sync.Mutex
		logPath    = ErrorLog
		lastOffset int64
	)

	if r.URL.Query().Get("file") == "access.log" { logPath = AccessLog }

	writeJSON := func(v any) error {
		mu.Lock()
		defer mu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(v)
	}

	sendInitial := func() {
		lines, _ := GetLogs(logPath, "")
		writeJSON(map[string]any{"type": "initial", "lines": lines})
		if stat, err := os.Stat(logPath); err == nil { lastOffset = stat.Size() }
	}

	sendInitial()

	watcher, err := fsnotify.NewWatcher()
	if err != nil { return }
	defer watcher.Close()
	watcher.Add(logPath)

	go func() {
		defer cancel()
		for {
			var msg struct {
				Type, Query, File string
			}
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			switch msg.Type {
			case "filter":
				DebugLog("WebsocketHandler: filter query=%s", msg.Query)
				lines, _ := GetLogs(logPath, msg.Query)
				writeJSON(map[string]any{"type": "filtered", "lines": lines})

			case "switchFile":
				DebugLog("WebsocketHandler: switching to %s", msg.File)
				watcher.Remove(logPath)
				logPath = ErrorLog
				if msg.File == "access.log" { logPath = AccessLog }
				lastOffset = 0
				watcher.Add(logPath)
				sendInitial()

			case "reload":
				DebugLog("WebsocketHandler: reloading logs")
				lastOffset = 0
				sendInitial()

			case "clear":
				os.Truncate(logPath, 0)
				writeJSON(map[string]string{"type": "clear"})
			}
		}
	}()

	timer := time.NewTimer(0)
	if !timer.Stop() { <-timer.C }

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-watcher.Events:
			if !ok { return }
			if event.Op&fsnotify.Write == fsnotify.Write {
				timer.Reset(100 * time.Millisecond)
			}
		case <-timer.C:
			stat, err := os.Stat(logPath)
			if err != nil || stat.Size() < lastOffset {
				lastOffset = 0
				writeJSON(map[string]string{"type": "clear"})
				if err == nil { sendInitial() }
				continue
			}
			if stat.Size() == lastOffset { continue }

			f, _ := os.Open(logPath)
			f.Seek(lastOffset, 0)

			AppSettingsMutex.RLock()
			tz := AppSettings.TimezoneOffset
			AppSettingsMutex.RUnlock()

			scanner := bufio.NewScanner(f)
			var out []string
			for scanner.Scan() {
				if html := ProcessLogLine(scanner.Text(), tz); html != "" {
					out = append(out, html)
				}
			}
			lastOffset, _ = f.Seek(0, 1)
			f.Close()

			if len(out) > 0 {
				writeJSON(map[string]any{"type": "append", "content": strings.Join(out, "\n")})
			}
		case <-watcher.Errors:
			return
		}
	}
}