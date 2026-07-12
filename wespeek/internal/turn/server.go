package turn

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// Config holds TURN server configuration
type Config struct {
	Port        int
	Realm       string
	Secret      string
	AuthSecret  string
	ExternalIP  string  // External IP address for TURN (for Docker/NAT environments)
	ExternalHost string // External hostname/domain for TURN (for reverse proxy environments)
	MinPort     int
	MaxPort     int
}

// Server implements a built-in TURN server
type Server struct {
	config Config
	turn   *turn.Server
	mu     sync.Mutex
	wg     sync.WaitGroup
}

func NewServer(cfg Config) *Server {
	if cfg.Port == 0 {
		cfg.Port = 3478
	}
	if cfg.Realm == "" {
		cfg.Realm = "wespeak"
	}
	if cfg.MinPort == 0 {
		cfg.MinPort = 49160
	}
	if cfg.MaxPort == 0 {
		cfg.MaxPort = 49200
	}
	return &Server{config: cfg}
}

// getDefaultRouteIP returns the IP address used for default route
// This is typically the Docker gateway IP (e.g., 172.17.0.1)
func getDefaultRouteIP() net.IP {
	// Try to get default route via dialing a public address
	conn, err := net.Dial("udp", "8.8.8.8:53")
	if err != nil {
		log.Printf("Failed to get default route: %v", err)
		return nil
	}
	defer conn.Close()

	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP
}

func (s *Server) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Create UDP listener
	addr := fmt.Sprintf(":%d", s.config.Port)
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	// Auth handler
	var authHandler turn.AuthHandler
	if s.config.AuthSecret != "" {
		secret := s.config.AuthSecret
		authHandler = func(username string, _ string, _ net.Addr) ([]byte, bool) {
			mac := hmac.New(sha1.New, []byte(secret))
			mac.Write([]byte(username))
			return []byte(hex.EncodeToString(mac.Sum(nil))), true
		}
	} else if s.config.Secret != "" {
		secret := s.config.Secret
		authHandler = func(username, realm string, _ net.Addr) ([]byte, bool) {
			mac := hmac.New(sha1.New, []byte(secret))
			mac.Write([]byte(username + ":" + realm + ":" + secret))
			return []byte(hex.EncodeToString(mac.Sum(nil))), true
		}
	} else {
		log.Println("WARNING: TURN without auth!")
		authHandler = func(string, string, net.Addr) ([]byte, bool) {
			return []byte("password"), true
		}
	}

	// Create TURN server with PacketConnConfigs
	loggerFactory := logging.NewDefaultLoggerFactory()

	// Create relay address generator - use nil to let pion/turn auto-select
	// This works better in Docker environments
	var relayAddressGenerator turn.RelayAddressGenerator = nil

	s.turn, err = turn.NewServer(turn.ServerConfig{
		Realm:              s.config.Realm,
		AuthHandler:        authHandler,
		ChannelBindTimeout: time.Hour,
		LoggerFactory:      loggerFactory,
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn:            conn,
				RelayAddressGenerator: relayAddressGenerator,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("create TURN server: %w", err)
	}

	log.Printf("TURN started on %s", addr)
	return nil
}

func (s *Server) Stop() {
	s.mu.Lock()
	if s.turn != nil {
		s.turn.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Server) GetAddress() string {
	// Priority: ExternalHost > ExternalIP > auto-detected IP > localhost
	turnHost := s.config.ExternalHost
	if turnHost == "" {
		turnHost = s.config.ExternalIP
	}
	if turnHost == "" {
		if defaultIP := getDefaultRouteIP(); defaultIP != nil {
			turnHost = defaultIP.String()
		} else {
			turnHost = "127.0.0.1"
		}
	}
	return fmt.Sprintf("turn:%s:%d?transport=udp", turnHost, s.config.Port)
}

func (s *Server) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"running":  s.turn != nil,
		"port":     s.config.Port,
		"realm":    s.config.Realm,
		"has_auth": s.config.AuthSecret != "" || s.config.Secret != "",
	}
}

func GenerateRandomSecret() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return hex.EncodeToString(b), err
}
