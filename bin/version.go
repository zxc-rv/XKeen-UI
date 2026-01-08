package bin

import (
	"net/http"
)

func VersionHandler(w http.ResponseWriter, r *http.Request, version string) {
	jsonResponse(w, map[string]interface{}{
		"success": true,
		"version": version,
	}, 200)
}