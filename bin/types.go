package bin

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

const (
	AppConfigPath = "/opt/share/www/XKeen-UI/config.json"
	XrayConf      = "/opt/etc/xray/configs"
	XrayAsset     = "/opt/etc/xray/dat"
	MihomoConf    = "/opt/etc/mihomo"
	XkeenConf     = "/opt/etc/xkeen"
	S24xray       = "/opt/etc/init.d/S24xray"
	S99xkeen      = "/opt/etc/init.d/S99xkeen"
	AccessLog     = "/opt/var/log/xray/access.log"
	ErrorLog      = "/opt/var/log/xray/error.log"
)

type AppConfig struct {
	TimezoneOffset int `json:"timezoneOffset"`
}

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
	Lines      []string
	LastSize   int64
	LastOffset int64
	LastMod    time.Time
	LastRead   time.Time
}

var clientTypes = map[string]ClientType{
	"xray":   {Name: "xray", ConfigDir: XrayConf, ConfigExt: "*.json", IsJSON: true},
	"mihomo": {Name: "mihomo", ConfigDir: MihomoConf, ConfigExt: "config.yaml", IsJSON: false},
}

var (
	CurrentClient    ClientType
	ClientMutex      sync.RWMutex
	LogCacheMap      = make(map[string]*LogCache)
	LogCacheMutex    sync.RWMutex
	AppSettings      = AppConfig{TimezoneOffset: 3}
	AppSettingsMutex sync.RWMutex
)

func jsonResponse(w http.ResponseWriter, data interface{}, status int) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}