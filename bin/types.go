package bin

import (
    "encoding/json"
    "net/http"
    "sync"
    "time"
    "os"
    "strings"
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

type ClientType struct {
	Name      string
	ConfigDir string
	ConfigExt string
	IsJSON    bool
}

type LogCache struct {
	Content  string
	Lines    []string
	LastSize int64
	LastMod  time.Time
	LastRead time.Time
}

var clientTypes = map[string]ClientType{
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

var (
	CurrentClient ClientType
	ClientMutex   sync.RWMutex

	LogCacheMap   = make(map[string]*LogCache)
	LogCacheMutex = &sync.RWMutex{}
)

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

func DetectClientType() ClientType {
	initFiles := []string{"/opt/etc/init.d/S24xray", "/opt/etc/init.d/S99xkeen"}

	for _, initFile := range initFiles {
		if content, err := os.ReadFile(initFile); err == nil {
			if strings.Contains(string(content), "xkeen -xray") {
				return clientTypes["xray"]
			}
			if strings.Contains(string(content), "xkeen -mihomo") {
				return clientTypes["mihomo"]
			}
		}
	}
	return clientTypes["xray"]
}
