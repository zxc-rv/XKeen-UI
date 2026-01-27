package bin

import (
	"encoding/json"
	"net/http"
	"os"
)

func InitAppConfig() {
	f, err := os.Open(AppConfigPath)
	if err != nil {
		SaveAppConfig()
		return
	}
	defer f.Close()

	var cfg AppConfig
	if err := json.NewDecoder(f).Decode(&cfg); err != nil {
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
	if r.Method == "GET" {
		AppSettingsMutex.RLock()
		off := AppSettings.TimezoneOffset
		AppSettingsMutex.RUnlock()
		jsonResponse(w, map[string]interface{}{"success": true, "timezoneOffset": off}, 200)
		return
	}

	var req struct {
		TimezoneOffset int `json:"timezoneOffset"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
		return
	}

	if req.TimezoneOffset < -12 || req.TimezoneOffset > 14 {
		jsonResponse(w, Response{Success: false, Error: "Bad timezone"}, 400)
		return
	}

	AppSettingsMutex.Lock()
	AppSettings.TimezoneOffset = req.TimezoneOffset
	AppSettingsMutex.Unlock()

	if err := SaveAppConfig(); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Save error"}, 500)
		return
	}

	jsonResponse(w, Response{Success: true}, 200)
}
