package server

import (
	"errors"
	"io"
	"log"
	"os"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/domain/repository"
	"github.com/newton-miku/WeSpeek/internal/service"
	"github.com/newton-miku/WeSpeek/internal/sfu"
	"github.com/newton-miku/WeSpeek/internal/store"
	"github.com/newton-miku/WeSpeek/internal/turn"
)

type Server struct {
	roomService  *service.RoomService
	chatService  *service.ChatService
	adminService *service.AdminService
	mediaService *service.MediaService
	fileStore    repository.FileStore

	// State
	rooms           sync.Map // map[string]*room
	clients         sync.Map // map[string]func(interface{})
	latencySubs     sync.Map // map[string]func(interface{})
	adminChallenges sync.Map
	groups          sync.Map // map[string]struct{}

	// SFU
	sfu *sfu.IONSFU

	// TURN
	turnServer *turn.Server

	// Config
	StoreImagesAsFiles bool
	AllowUploads       bool

	startTime time.Time
}

func (s *Server) GetServerStats() ServerStats {
	var stats ServerStats
	stats.Rooms = []RoomStats{}

	var totalPing int64
	var totalQueue int
	var pingCount int
	var queueCount int

	s.rooms.Range(func(key, value interface{}) bool {
		r := value.(*room)
		stats.RoomCount++

		rs := RoomStats{
			ID: r.id,
		}
		// If description is used as name
		rs.Name = r.description

		var roomTotalPing int64
		var roomPingCount int

		r.mu.RLock()
		rs.PeerCount = len(r.peers)
		for _, p := range r.peers {
			stats.PeerCount++

			// Ping
			l := atomic.LoadInt64(&p.latency)
			if l > 0 {
				totalPing += l
				pingCount++
				roomTotalPing += l
				roomPingCount++
			}

			// Traffic
			pSent := atomic.LoadUint64(&p.bytesSent)
			pRecv := atomic.LoadUint64(&p.bytesReceived)

			stats.TotalBytesSent += pSent
			stats.TotalBytesReceived += pRecv
			rs.BytesSent += pSent
			rs.BytesReceived += pRecv

			stats.TotalPacketsSent += atomic.LoadUint64(&p.packetsSent)
			stats.TotalPacketsLost += atomic.LoadInt64(&p.sentPacketsLost)
		}
		r.mu.RUnlock()

		if roomPingCount > 0 {
			rs.AvgPing = float64(roomTotalPing) / float64(roomPingCount)
		}
		stats.Rooms = append(stats.Rooms, rs)

		return true
	})

	if pingCount > 0 {
		stats.AvgPing = float64(totalPing) / float64(pingCount)
	}
	if queueCount > 0 {
		stats.AvgQueueSize = float64(totalQueue) / float64(queueCount)
	}

	// System Stats
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	stats.GoroutineCount = runtime.NumGoroutine()
	stats.AllocMemory = memStats.Alloc
	stats.TotalAllocMemory = memStats.TotalAlloc
	stats.SysMemory = memStats.Sys
	stats.Uptime = int64(time.Since(s.startTime).Seconds())

	return stats
}

func New(s store.Store, fs repository.FileStore, storeImagesAsFiles bool, allowUploads bool) *Server {
	ms := service.NewMediaService(fs, allowUploads)

	server := &Server{
		roomService:        service.NewRoomService(s, s),
		chatService:        service.NewChatService(s, ms),
		adminService:       service.NewAdminService(s),
		mediaService:       ms,
		fileStore:          fs,
		sfu:                sfu.NewIONSFU(sfu.Config{}),
		StoreImagesAsFiles: storeImagesAsFiles,
		AllowUploads:       allowUploads,
		startTime:          time.Now(),
	}

	// Initialize TURN server if enabled
	turnPort := 3478

	// Check environment variables
	if port := getEnvInt("TURN_SERVER_PORT", 0); port > 0 {
		turnPort = port
	}

	if getEnvBool("TURN_SERVER_ENABLED", true) {
		authSecret := getEnv("TURN_SERVER_SECRET", "")
		externalIP := getEnv("TURN_SERVER_EXTERNAL_IP", "")
		externalHost := getEnv("TURN_SERVER_HOST", "")

		server.turnServer = turn.NewServer(turn.Config{
			Port:        turnPort,
			Realm:       "wespeak",
			AuthSecret:  authSecret,
			ExternalIP:  externalIP,
			ExternalHost: externalHost,
			MinPort:     49160,
			MaxPort:     49200,
		})
	}

	return server
}

// getEnv gets an environment variable with default value
func getEnv(key, defaultValue string) string {
	value := os.Getenv(key)
	if value != "" {
		return value
	}
	return defaultValue
}

// getEnvInt gets an environment variable as int
func getEnvInt(key string, defaultValue int) int {
	value := os.Getenv(key)
	if value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}

// getEnvBool gets an environment variable as bool
func getEnvBool(key string, defaultValue bool) bool {
	value := os.Getenv(key)
	if value != "" {
		return value == "true" || value == "1" || value == "yes"
	}
	return defaultValue
}

func (s *Server) GetFileStore() repository.FileStore {
	return s.fileStore
}

func (s *Server) SaveImage(filename string, r io.Reader) (string, error) {
	if s.mediaService == nil {
		// Just in case Init wasn't called or something
		return "", errors.New("media service not initialized")
	}
	return s.mediaService.SaveImage(filename, r)
}

func (s *Server) Init() error {
	// Initialize MediaService
	s.mediaService = service.NewMediaService(s.fileStore, s.AllowUploads)
	if s.chatService != nil {
		s.chatService.SetMediaService(s.mediaService)
	}

	// Start TURN server if configured
	if s.turnServer != nil {
		if err := s.turnServer.Start(); err != nil {
			// Log warning but don't fail - TURN might be disabled
			log.Printf("Warning: Failed to start TURN server: %v", err)
		} else {
			log.Printf("TURN server started successfully")
		}
	}

	// Load rooms
	rooms, err := s.roomService.GetRooms()
	if err != nil {
		return err
	}

	// Create default rooms if none exist
	if len(rooms) == 0 {
		defaults := []entity.Room{
			{ID: "大厅", Permanent: true, Order: 0},
		}
		for _, r := range defaults {
			if err := s.roomService.SaveRoom(r); err != nil {
				return err
			}
		}
		// Reload rooms
		rooms, err = s.roomService.GetRooms()
		if err != nil {
			return err
		}
	}

	for _, r := range rooms {
		audioCodec := r.AudioCodec
		audioQuality := r.AudioQuality
		// Set defaults if not specified
		if audioCodec == "" {
			audioCodec = "opus"
		}
		if audioQuality == 0 {
			audioQuality = 6
		}
		s.rooms.Store(r.ID, &room{
			id:           r.ID,
			group:        r.Group,
			order:        r.Order,
			audioCodec:   audioCodec,
			audioQuality: audioQuality,
			permanent:    r.Permanent,
			peers:        make(map[string]*peer),
		})
	}

	// Load groups
	groups, err := s.roomService.GetGroups()
	if err != nil {
		return err
	}
	for _, g := range groups {
		s.groups.Store(g, struct{}{})
	}

	// Start cleanup loop
	go s.startCleanupLoop()

	// Start latency broadcast loop
	go s.startLatencyLoop()

	return nil
}

func (s *Server) startLatencyLoop() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		// Collect latencies
		latencies := make(map[string]int64)
		s.rooms.Range(func(_, value any) bool {
			rm := value.(*room)
			rm.mu.RLock()
			for uid, p := range rm.peers {
				l := atomic.LoadInt64(&p.latency)
				if l > 0 {
					latencies[uid] = l
				}
			}
			rm.mu.RUnlock()
			return true
		})

		if len(latencies) == 0 {
			continue
		}

		// Broadcast to subscribers
		out := struct {
			Method string           `json:"method"`
			Params map[string]int64 `json:"params"`
		}{
			Method: "latency.update",
			Params: latencies,
		}

		s.latencySubs.Range(func(key, value any) bool {
			if fn, ok := value.(func(interface{})); ok {
				fn(out)
			}
			return true
		})
	}
}

func (s *Server) startCleanupLoop() {
	// Initial cleanup
	_ = s.chatService.CleanupOldMessages(30)

	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		_ = s.chatService.CleanupOldMessages(30)
	}
}
