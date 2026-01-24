package bin

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

const AppConfigPath = "/opt/share/www/XKeen-UI/config.json"

func InitAppConfig() {
	data, err := os.ReadFile(AppConfigPath)
	if err != nil {
		log.Printf("Config file not found, creating with defaults")
		if err := SaveAppConfig(); err != nil {
			log.Printf("Failed to create config: %v", err)
		}
		return
	}
	var cfg AppConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		log.Printf("Failed to parse config, using defaults: %v", err)
		SaveAppConfig()
		return
	}
	AppSettingsMutex.Lock()
	AppSettings = cfg
	AppSettingsMutex.Unlock()
	log.Printf("Loaded timezone offset: %d", cfg.TimezoneOffset)
}

func SaveAppConfig() error {
	AppSettingsMutex.RLock()
	cfg := AppSettings
	AppSettingsMutex.RUnlock()

	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	if err := os.WriteFile(AppConfigPath, data, 0644); err != nil {
		return err
	}
	log.Printf("Saved timezone offset: %d", cfg.TimezoneOffset)
	return nil
}

func SettingsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		AppSettingsMutex.RLock()
		offset := AppSettings.TimezoneOffset
		AppSettingsMutex.RUnlock()
		jsonResponse(w, map[string]interface{}{"success": true, "timezoneOffset": offset}, 200)
	case "POST":
		var req struct {
			TimezoneOffset int `json:"timezoneOffset"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			log.Printf("Failed to decode JSON: %v", err)
			jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
			return
		}

		offset := req.TimezoneOffset
		if offset < -12 || offset > 14 {
			jsonResponse(w, Response{Success: false, Error: "Некорректный часовой пояс"}, 400)
			return
		}

		AppSettingsMutex.Lock()
		AppSettings.TimezoneOffset = offset
		AppSettingsMutex.Unlock()

		if err := SaveAppConfig(); err != nil {
			log.Printf("Failed to save config: %v", err)
			jsonResponse(w, Response{Success: false, Error: "Ошибка сохранения"}, 500)
			return
		}

		LogCacheMutex.Lock()
		LogCacheMap = make(map[string]*LogCache)
		LogCacheMutex.Unlock()

		jsonResponse(w, Response{Success: true, Data: "Настройки сохранены"}, 200)
	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}