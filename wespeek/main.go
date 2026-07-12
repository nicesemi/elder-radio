package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/newton-miku/WeSpeek/internal/server"
	"github.com/newton-miku/WeSpeek/internal/store/local"
	"github.com/newton-miku/WeSpeek/internal/store/sqlite"
	"github.com/newton-miku/WeSpeek/internal/util"
)

func main() {
	genAdmin := flag.Bool("gen-admin", false, "Generate a random admin key and setup link")
	dbPath := flag.String("db", "wespeek.db", "Path to SQLite database file")
	flag.Parse()

	// Initialize database
	st, err := sqlite.New(*dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	// Initialize FileStore
	uploadDir := util.EnvOr("WSPEEK_UPLOAD_DIR", "data/uploads")
	fileStore := local.NewFileStore(uploadDir+"/img", "/uploads/img")

	// Create server with WebRTC support
	srv := server.New(st, fileStore, true, true)

	// Configure from environment
	if val := os.Getenv("WSPEEK_STORE_IMAGES"); val != "" {
		srv.StoreImagesAsFiles = val == "true"
	} else {
		srv.StoreImagesAsFiles = true
	}

	if val := os.Getenv("WSPEEK_ALLOW_UPLOAD"); val != "" {
		srv.AllowUploads = val == "true"
	} else {
		srv.AllowUploads = true
	}

	// Initialize server (loads rooms from SQLite, starts background loops)
	if err := srv.Init(); err != nil {
		log.Fatal(err)
	}
	srv.InitAdmin(*genAdmin)

	// Create HTTP mux
	mux := http.NewServeMux()

	// WebSocket handlers
	mux.HandleFunc("/ws", srv.WSHandler)
	// API handlers
	mux.HandleFunc("/api/rooms", srv.RoomsHandler)
	mux.HandleFunc("/api/rooms/", srv.RoomMembersHandler)
	mux.HandleFunc("/api/chat/public", srv.PublicChatHandler)
	mux.HandleFunc("/api/chat/room/", srv.RoomChatHandler)
	mux.HandleFunc("/api/upload", srv.UploadHandler)
	mux.HandleFunc("/api/admin/challenge", srv.AdminChallengeHandler)
	mux.HandleFunc("/api/admin/move_user", srv.AdminMoveUserHandler)
	mux.HandleFunc("/api/admin/setup", srv.AdminSetupHandler)
	mux.HandleFunc("/api/admin/status", srv.AdminStatusHandler)
	mux.HandleFunc("/api/groups", srv.GroupsHandler)
	mux.HandleFunc("/api/groups/", srv.GroupsHandler)

	// Serve uploaded files
	mux.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadDir))))

	// Serve web frontend
	mux.Handle("/", http.FileServer(http.Dir("web")))

	// Start HTTP server
	addr := util.EnvOr("WSPEEK_ADDR", ":7000")
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           CORSMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Println("listening on", addr)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, X-Admin-Auth")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}
