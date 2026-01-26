package main

import (
	"XKeen-UI/bin"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
)

var version = "dev"

func main() {
	port := flag.String("p", "1000", "Port to listen on")
	showVersion := flag.Bool("v", false, "Show version")
	flag.BoolVar(showVersion, "V", false, "Show version")
	flag.Parse()

	if *showVersion {
		fmt.Printf("XKeen UI %s\n", version)
		os.Exit(0)
	}

	bin.InitAppConfig()
	go bin.CleanupLogCache()

	mux := http.NewServeMux()

	mux.HandleFunc("/cgi/status", bin.StatusHandler)
	mux.HandleFunc("/cgi/logs", bin.LogsHandler)
	mux.HandleFunc("/cgi/configs", bin.ConfigsHandler)
	mux.HandleFunc("/cgi/control", bin.ControlHandler)
	mux.HandleFunc("/cgi/settings", bin.SettingsHandler)
	mux.HandleFunc("/cgi/version", func(w http.ResponseWriter, r *http.Request) {
		bin.VersionHandler(w, r, version)
	})
	mux.HandleFunc("/ws", bin.WebsocketHandler)

	mux.Handle("/", http.FileServer(http.Dir("/opt/share/www/XKeen-UI")))

	addr := ":" + *port
	log.Printf("XKeen UI %s listening http://0.0.0.0%s", version, addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
