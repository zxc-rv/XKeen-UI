package main

import (
	"XKeen-UI/bin"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"runtime"
)

var version = "dev"

func main() {
	port := flag.String("p", "1000", "Port to listen on")
	showVer := flag.Bool("v", false, "Show version")
	debug := flag.Bool("d", false, "Enable debug logging")
	flag.BoolVar(showVer, "V", false, "Show version (alias)")
	flag.Parse()

	info := fmt.Sprintf("XKeen UI %s (%s %s/%s)", version, runtime.Version(), runtime.GOOS, runtime.GOARCH)

	if *showVer {
		fmt.Println(info)
		os.Exit(0)
	}
	fmt.Println(info)

	if *debug {
		log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
		bin.DebugMode = true
		log.Println("Debug mode enabled")
	}

	bin.InitAppConfig()

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir("/opt/share/www/XKeen-UI")))

	mux.HandleFunc("/api/control", bin.ControlHandler)
	mux.HandleFunc("/api/configs", bin.ConfigsHandler)
	mux.HandleFunc("/api/settings", bin.SettingsHandler)
	mux.HandleFunc("/api/update", bin.UpdateHandler)
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) { bin.VersionHandler(w, r, version) })
	mux.HandleFunc("/ws", bin.WebsocketHandler)

	addr := ":" + *port
	log.Printf("Listening on http://0.0.0.0%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[FATAL] %v", err)
	}
}