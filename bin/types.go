package bin

import (
	"encoding/json"
	"log"
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
	Data    any `json:"data,omitempty"`
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

type ClientType struct {
	Name, ConfigDir, ConfigExt string
	IsJSON                     bool
}

type LogCache struct {
	Lines                []string
	LastSize, LastOffset int64
	LastMod, LastRead    time.Time
}

var (
	clientTypes = map[string]ClientType{
		"xray":   {Name: "xray", ConfigDir: XrayConf, ConfigExt: "*.json", IsJSON: true},
		"mihomo": {Name: "mihomo", ConfigDir: MihomoConf, ConfigExt: "config.yaml", IsJSON: false},
	}
	coreEnvs = map[string][]string{
		"xray":   {"XRAY_LOCATION_CONFDIR=" + XrayConf, "XRAY_LOCATION_ASSET=" + XrayAsset},
		"mihomo": {"CLASH_HOME_DIR=" + MihomoConf},
	}
	CurrentCore      ClientType
	ClientMutex      sync.RWMutex
	LogCacheMap      = make(map[string]*LogCache)
	LogCacheMutex    sync.RWMutex
	AppSettings      = AppConfig{TimezoneOffset: 3}
	AppSettingsMutex sync.RWMutex
	DebugMode        bool
)

func DebugLog(format string, v ...any) { if DebugMode { log.Printf("[DEBUG] "+format, v...) }}

func jsonResponse(w http.ResponseWriter, data any, status int) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}