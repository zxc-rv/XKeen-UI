package main

import (
	"log"
	"net/http"
	"net/http/fcgi"

	"XKeen-UI/bin"
)

func main() {
	client := bin.DetectClientType()
	bin.ClientMutex.Lock()
	bin.CurrentClient = client
	bin.ClientMutex.Unlock()
	log.Printf("Detected client: %s, config dir: %s", bin.CurrentClient.Name, bin.CurrentClient.ConfigDir)

	go bin.CleanupLogCache()

	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/cgi/status", bin.StatusHandler)
		mux.HandleFunc("/cgi/logs", bin.LogsHandler)
		mux.HandleFunc("/cgi/configs", bin.ConfigsHandler)
		mux.HandleFunc("/cgi/control", bin.ControlHandler)
		mux.HandleFunc("/cgi/core", bin.CoreHandler)
		if err := fcgi.Serve(nil, mux); err != nil {
			log.Println("Error from fcgi.Serve:", err)
		}
	}()

	http.HandleFunc("/ws", bin.WebsocketHandler)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
