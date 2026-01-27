package bin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

func ConfigsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		getConfigs(w)
	} else if r.Method == "POST" {
		postConfigs(w, r)
	} else {
		jsonResponse(w, Response{Success: false, Error: "405"}, 405)
	}
}

func getConfigs(w http.ResponseWriter) {
	ClientMutex.RLock()
	client := CurrentClient
	ClientMutex.RUnlock()

	var patterns []string
	if client.IsJSON {
		patterns = append(patterns, filepath.Join(client.ConfigDir, "*.json"))
	} else {
		patterns = append(patterns, filepath.Join(client.ConfigDir, client.ConfigExt))
	}
	patterns = append(patterns, filepath.Join(XkeenConf, "*.lst"))

	var configs []Config
	for _, pat := range patterns {
		files, _ := filepath.Glob(pat)
		for _, f := range files {
			if content, err := os.ReadFile(f); err == nil {
				configs = append(configs, Config{
					Name:     strings.TrimSuffix(filepath.Base(f), filepath.Ext(f)),
					Filename: filepath.Base(f),
					Content:  string(content),
				})
			}
		}
	}
	jsonResponse(w, ConfigsResponse{Success: true, Configs: configs}, 200)
}

func postConfigs(w http.ResponseWriter, r *http.Request) {
	var req ActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonResponse(w, Response{Success: false, Error: "JSON error"}, 400)
		return
	}

	ClientMutex.RLock()
	client := CurrentClient
	ClientMutex.RUnlock()

	path := filepath.Join(client.ConfigDir, req.Filename)
	isLst := strings.HasSuffix(req.Filename, ".lst")

	if isLst {
		path = filepath.Join(XkeenConf, req.Filename)
		req.Content = strings.ReplaceAll(req.Content, "\r\n", "\n")
	} else if client.IsJSON {
		if !strings.HasSuffix(path, ".json") {
			path += ".json"
		}
	} else {
		var y interface{}
		if yaml.Unmarshal([]byte(req.Content), &y) != nil {
			jsonResponse(w, Response{Success: false, Error: "Invalid YAML"}, 400)
			return
		}
	}

	if req.Action == "delete" {
		if os.Remove(path) != nil {
			jsonResponse(w, Response{Success: false, Error: "Delete error"}, 500)
			return
		}
	} else if req.Action == "save" {
		if os.WriteFile(path, []byte(req.Content), 0644) != nil {
			jsonResponse(w, Response{Success: false, Error: "Write error"}, 500)
			return
		}
	} else {
		jsonResponse(w, Response{Success: false, Error: "Unknown action"}, 400)
		return
	}
	jsonResponse(w, Response{Success: true}, 200)
}
