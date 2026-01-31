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
	DebugLog("ConfigsHandler: method=%s", r.Method)
	switch r.Method {
	case http.MethodGet:
		getConfigs(w, r)
	case http.MethodPost:
		postConfigs(w, r)
	default:
		DebugLog("ConfigsHandler: method not allowed: %s", r.Method)
		http.Error(w, "405 Method Not Allowed", http.StatusMethodNotAllowed)
	}
}

func getConfigs(w http.ResponseWriter, r *http.Request) {
	ClientMutex.RLock()
	c := CurrentCore
	ClientMutex.RUnlock()

	if ct, ok := clientTypes[r.URL.Query().Get("core")]; ok { c = ct }
	DebugLog("getConfigs: using client=%s", c.Name)

	ext := c.ConfigExt
	if c.IsJSON { ext = "*.json" }

	patterns := []string{
		filepath.Join(c.ConfigDir, ext),
		filepath.Join(XkeenConf, "*.lst"),
	}

	var res []Config
	for _, p := range patterns {
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
	DebugLog("getConfigs: found %d configs", len(res))
	jsonResponse(w, ConfigsResponse{Success: true, Configs: res}, 200)
}

func postConfigs(w http.ResponseWriter, r *http.Request) {
	var req ActionRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		http.Error(w, "JSON error", 400)
		return
	}

	DebugLog("postConfigs: saving file=%s (%d bytes)", req.Filename, len(req.Content))

	ClientMutex.RLock()
	c := CurrentCore
	ClientMutex.RUnlock()

	name := filepath.Base(req.Filename)
	isLst := strings.HasSuffix(name, ".lst")
	path := filepath.Join(c.ConfigDir, name)

	if isLst {
		path = filepath.Join(XkeenConf, name)
		req.Content = strings.ReplaceAll(req.Content, "\r\n", "\n")
	} else {
		if c.IsJSON {
			if !strings.HasSuffix(path, ".json") { path += ".json" }
		} else {
			var y any
			if yaml.Unmarshal([]byte(req.Content), &y) != nil {
				http.Error(w, "Invalid YAML", 400)
				return
			}
		}
	}

	if req.Action == "save" {
		if os.WriteFile(path, []byte(req.Content), 0644) != nil {
			http.Error(w, "Write error", 500)
			return
		}
	} else {
		http.Error(w, "Unknown action", 400)
		return
	}
	jsonResponse(w, Response{Success: true}, 200)
}
