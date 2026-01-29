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
	coreParam := r.URL.Query().Get("core")
	DebugLog("getConfigs: coreParam=%s", coreParam)

	var c ClientType
	if coreParam != "" {
		if ct, ok := clientTypes[coreParam]; ok {
			c = ct
		} else {
			ClientMutex.RLock()
			c = CurrentClient
			ClientMutex.RUnlock()
		}
	} else {
		ClientMutex.RLock()
		c = CurrentClient
		ClientMutex.RUnlock()
	}
	DebugLog("getConfigs: using client=%s", c.Name)

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
	DebugLog("getConfigs: found %d configs", len(res))
	jsonResponse(w, ConfigsResponse{Success: true, Configs: res}, 200)
}

func postConfigs(w http.ResponseWriter, r *http.Request) {
	var req ActionRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		DebugLog("postConfigs: JSON decode error")
		http.Error(w, "JSON error", 400)
		return
	}
	DebugLog("postConfigs: action=%s filename=%s", req.Action, req.Filename)

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
			DebugLog("postConfigs: invalid YAML")
			http.Error(w, "Invalid YAML", 400)
			return
		}
	}

	switch req.Action {
	case "delete":
		DebugLog("postConfigs: deleting %s", path)
		if os.Remove(path) != nil {
			DebugLog("postConfigs: delete error for %s", path)
			http.Error(w, "Delete error", 500)
			return
		}
	case "save":
		DebugLog("postConfigs: saving %s (%d bytes)", path, len(req.Content))
		if os.WriteFile(path, []byte(req.Content), 0644) != nil {
			DebugLog("postConfigs: write error for %s", path)
			http.Error(w, "Write error", 500)
			return
		}
	default:
		DebugLog("postConfigs: unknown action %s", req.Action)
		http.Error(w, "Unknown action", 400)
		return
	}
	DebugLog("postConfigs: success")
	jsonResponse(w, Response{Success: true}, 200)
}