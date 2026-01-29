package bin

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

func InitAppConfig() {
	GetNameClient()

	f, err := os.Open(AppConfigPath)
	if err != nil {
		log.Println("Config not found, creating default")
		SaveAppConfig()
		return
	}
	defer f.Close()

	log.Println("Reading config from", AppConfigPath)
	var cfg AppConfig
	if err := json.NewDecoder(f).Decode(&cfg); err != nil {
		log.Println("Failed to parse config, creating default")
		SaveAppConfig()
		return
	}
	AppSettingsMutex.Lock()
	AppSettings = cfg
	AppSettingsMutex.Unlock()
}

func SaveAppConfig() error {
	AppSettingsMutex.RLock()
	cfg := AppSettings
	AppSettingsMutex.RUnlock()

	f, err := os.Create(AppConfigPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(cfg)
}

func SettingsHandler(w http.ResponseWriter, r *http.Request) {
	DebugLog("SettingsHandler: method=%s", r.Method)
	if r.Method == "GET" {
		AppSettingsMutex.RLock()
		off := AppSettings.TimezoneOffset
		AppSettingsMutex.RUnlock()
		DebugLog("SettingsHandler GET: timezoneOffset=%d", off)
		jsonResponse(w, map[string]any{"success": true, "timezoneOffset": off}, 200)
		return
	}

	var req struct {
		TimezoneOffset int `json:"timezoneOffset"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		DebugLog("SettingsHandler: JSON decode error")
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
		return
	}

	if req.TimezoneOffset < -12 || req.TimezoneOffset > 14 {
		DebugLog("SettingsHandler: bad timezone %d", req.TimezoneOffset)
		jsonResponse(w, Response{Success: false, Error: "Bad timezone"}, 400)
		return
	}

	DebugLog("SettingsHandler: setting timezone to %d", req.TimezoneOffset)
	AppSettingsMutex.Lock()
	AppSettings.TimezoneOffset = req.TimezoneOffset
	AppSettingsMutex.Unlock()

	if err := SaveAppConfig(); err != nil {
		DebugLog("SettingsHandler: save error: %v", err)
		jsonResponse(w, Response{Success: false, Error: "Save error"}, 500)
		return
	}

	DebugLog("SettingsHandler: success")
	jsonResponse(w, Response{Success: true}, 200)
}