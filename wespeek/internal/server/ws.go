package server

import (
	"net"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
	"github.com/newton-miku/WeSpeek/internal/util"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func (s *Server) WSHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		http.Error(w, "upgrade failed", http.StatusBadRequest)
		return
	}

	id := util.RandString()
	ip := s.resolveIP(r)

	client := s.newClient(conn, id, ip)
	s.clients.Store(id, func(v interface{}) {
		select {
		case client.msgCh <- v:
		default:
		}
	})

	go client.writeLoop()
	client.readLoop()
}

func (s *Server) resolveIP(r *http.Request) string {
	var ip string
	// Only trust headers if the direct connection is from a trusted source
	if util.IsTrustedIP(r.RemoteAddr) {
		ip = r.Header.Get("X-Real-IP")
		if ip == "" {
			if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
				parts := strings.Split(fwd, ",")
				ip = strings.TrimSpace(parts[0])
			}
		}
	}

	if ip == "" {
		// Fallback to direct connection IP, strip port
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err == nil {
			ip = host
		} else {
			ip = r.RemoteAddr
		}
	}
	return ip
}
