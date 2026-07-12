package server

import (
	"sync/atomic"

	"time"

	"github.com/newton-miku/WeSpeek/internal/util"
)

func (s *Server) newPeer(uid, name, ip string, rm *room, webrtc bool, send func(interface{})) *peer {
	me := &peer{
		server:   s,
		uid:      uid,
		name:     name,
		ip:       ip,
		role:     "user",
		room:     rm,
		webrtc:   webrtc,
		send:     send,
		joinTime: time.Now(),
	}

	rm.mu.Lock()
	rm.peers[uid] = me

	if rm.deleteTimer != nil {
		rm.deleteTimer.Stop()
		rm.deleteTimer = nil
	}
	rm.mu.Unlock()

	// Send joined confirmation with ICE config
	iceConfig := s.buildIceConfig()
	send(map[string]interface{}{
		"method": "joined",
		"params": map[string]interface{}{
			"roomId": rm.id,
			"uid":    uid,
			"ice":    iceConfig,
		},
	})

	s.broadcastRoomUpdate(rm)
	s.broadcastRoomsUpdate()

	return me
}

// buildIceConfig returns ICE server configuration for WebRTC
func (s *Server) buildIceConfig() map[string]interface{} {
	config := map[string]interface{}{
		"stun": []map[string]string{
			{"url": "stun:turn.cloudflare.com:3478"},
			{"url": "stun:stun.chat.bilibili.com:3478"},
			{"url": "stun:turn.cloud-rtc.com:80"},
			{"url": "stun:stun.douyucdn.cn:18000"},
		},
	}

	// Add TURN server if available
	if s.turnServer != nil {
		turnAddr := s.turnServer.GetAddress()
		config["turn"] = []map[string]string{
			{"url": turnAddr},
		}
		// Add username if using auth
		if s.turnServer.GetStats()["has_auth"].(bool) {
			// Dynamic credentials will be provided separately
		}
	}

	return config
}

func (p *peer) GetPeerStats() *UserStats {
	return &UserStats{
		BytesReceived:   atomic.LoadUint64(&p.bytesReceived),
		PacketsReceived: atomic.LoadUint64(&p.packetsReceived),
		BytesSent:       atomic.LoadUint64(&p.bytesSent),
		PacketsSent:     atomic.LoadUint64(&p.packetsSent),
		SentPacketsLost: atomic.LoadInt64(&p.sentPacketsLost),
		Latency:         atomic.LoadInt64(&p.latency),
		QueueSize:       0, // No queue in pure WebRTC mode
	}
}

func (p *peer) close() {
	p.server.cleanupSFU(p)

	p.room.mu.Lock()
	delete(p.room.peers, p.uid)
	p.room.mu.Unlock()

	p.server.broadcastRoomUpdate(p.room)
	p.server.broadcastRoomsUpdate()
	p.server.scheduleRoomCleanup(p.room)
}

func (s *Server) doRename(p *peer, want string) {
	rm := p.room
	old := p.uid
	if old == want {
		return
	}
	target := want

	rm.mu.Lock()
	if _, exists := rm.peers[target]; exists {
		target = want + "-" + util.RandString()[:4]
	}
	delete(rm.peers, old)
	rm.peers[target] = p
	rm.mu.Unlock()

	p.uid = target
	// No tracks to remap
	s.broadcastRoomUpdate(rm)
	s.broadcastRoomsUpdate()
}
