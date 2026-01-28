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
	switch r.Method {
	case http.MethodGet:
		getConfigs(w)
	case http.MethodPost:
		postConfigs(w, r)
	default:
		http.Error(w, "405 Method Not Allowed", http.StatusMethodNotAllowed)
	}
}

func getConfigs(w http.ResponseWriter) {
	ClientMutex.RLock()
	c := CurrentClient
	ClientMutex.RUnlock()

	var paths []string
	if c.IsJSON {
		paths = append(paths, filepath.Join(c.ConfigDir, "*.json"))
	} else {
		paths = append(paths, filepath.Join(c.ConfigDir, c.ConfigExt))
	}
	paths = append(paths, filepath.Join(XkeenConf, "*.lst"))

	var res []Config
	for _, p := range paths {
		m, _ := filepath.Glob(p)
		for _, f := range m {
			if d, err := os.ReadFile(f); err == nil {
				res = append(res, Config{
					Name:     strings.TrimSuffix(filepath.Base(f), filepath.Ext(f)),
					Filename: filepath.Base(f),
					Content:  string(d),
				})
			}
		}
	}
	jsonResponse(w, ConfigsResponse{Success: true, Configs: res}, 200)
}

func postConfigs(w http.ResponseWriter, r *http.Request) {
	var req ActionRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		http.Error(w, "JSON error", 400)
		return
	}

	ClientMutex.RLock()
	c := CurrentClient
	ClientMutex.RUnlock()

	name := filepath.Base(req.Filename)
	path := filepath.Join(c.ConfigDir, name)
	isLst := strings.HasSuffix(name, ".lst")

	if isLst {
		path = filepath.Join(XkeenConf, name)
		req.Content = strings.ReplaceAll(req.Content, "\r\n", "\n")
	} else if c.IsJSON {
		if !strings.HasSuffix(path, ".json") {
			path += ".json"
		}
	} else {
		var y any
		if yaml.Unmarshal([]byte(req.Content), &y) != nil {
			http.Error(w, "Invalid YAML", 400)
			return
		}
	}

	switch req.Action {
	case "delete":
		if os.Remove(path) != nil {
			http.Error(w, "Delete error", 500)
			return
		}
	case "save":
		if os.WriteFile(path, []byte(req.Content), 0644) != nil {
			http.Error(w, "Write error", 500)
			return
		}
	default:
		http.Error(w, "Unknown action", 400)
		return
	}
	jsonResponse(w, Response{Success: true}, 200)
}