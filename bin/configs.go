package bin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v2"
)

func ConfigsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		getConfigs(w, r)
	case "POST":
		postConfigs(w, r)
	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}

func isValidYAML(content string) bool {
	var data interface{}
	return yaml.Unmarshal([]byte(content), &data) == nil
}

func getConfigs(w http.ResponseWriter, r *http.Request) {
	ClientMutex.RLock()
	client := CurrentClient
	ClientMutex.RUnlock()

	if _, err := os.Stat(client.ConfigDir); os.IsNotExist(err) {
		jsonResponse(w, ConfigsResponse{Success: false, Error: "Директория конфигов не найдена"}, 404)
		return
	}
	var configs []Config
	if client.IsJSON {
		files, err := filepath.Glob(filepath.Join(client.ConfigDir, client.ConfigExt))
		if err != nil {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "Ошибка чтения директории конфигов"}, 500)
			return
		}
		if len(files) == 0 {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "JSON конфиги не найдены"}, 404)
			return
		}
		for _, file := range files {
			content, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			filename := filepath.Base(file)
			configs = append(configs, Config{
				Name:     strings.TrimSuffix(filename, ".json"),
				Filename: filename,
				Content:  string(content),
			})
		}
	} else {
		configPath := filepath.Join(client.ConfigDir, client.ConfigExt)
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "YAML конфиг не найден"}, 404)
			return
		}
		content, err := os.ReadFile(configPath)
		if err != nil {
			jsonResponse(w, ConfigsResponse{Success: false, Error: "Ошибка чтения конфига"}, 500)
			return
		}
		configs = append(configs, Config{
			Name:     "config",
			Filename: client.ConfigExt,
			Content:  string(content),
		})
	}
	xkeenDir := "/opt/etc/xkeen"
	if _, err := os.Stat(xkeenDir); err == nil {
		lstFiles, _ := filepath.Glob(filepath.Join(xkeenDir, "*.lst"))
		for _, file := range lstFiles {
			content, err := os.ReadFile(file)
			if err != nil {
				continue
			}
			filename := filepath.Base(file)
			configs = append(configs, Config{
				Name:     strings.TrimSuffix(filename, ".lst"),
				Filename: filename,
				Content:  string(content),
			})
		}
	}
	jsonResponse(w, ConfigsResponse{Success: true, Configs: configs}, 200)
}

func postConfigs(w http.ResponseWriter, r *http.Request) {
	var req ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
		return
	}

	ClientMutex.RLock()
	client := CurrentClient
	ClientMutex.RUnlock()

	var filePath string
	filename := req.Filename

	if strings.HasSuffix(filename, ".lst") {
		filePath = filepath.Join("/opt/etc/xkeen", filename)
		req.Content = strings.ReplaceAll(req.Content, "\r\n", "\n")
	} else {
		if client.IsJSON {
			if !strings.HasSuffix(filename, ".json") {
				filename += ".json"
			}
		} else {
			if !isValidYAML(req.Content) {
				jsonResponse(w, Response{Success: false, Error: "Невалидный YAML"}, 400)
				return
			}
		}
		filePath = filepath.Join(client.ConfigDir, filename)
	}

	switch req.Action {
	case "save":
		if err := os.WriteFile(filePath, []byte(req.Content), 0644); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка записи файла"}, 500)
		} else {
			jsonResponse(w, Response{Success: true}, 200)
		}
	case "delete":
		if err := os.Remove(filePath); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Ошибка удаления файла"}, 500)
		} else {
			jsonResponse(w, Response{Success: true}, 200)
		}
	default:
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
	}
}