package sfu

// IONSFU provides a simplified SFU interface based on ion-sfu design patterns.
// This provides pure WebRTC SFU functionality for audio and screen sharing.

import (
	"log"
	"sync"

	"github.com/pion/webrtc/v4"
)

// IONSFU provides SFU-like functionality using pion/webrtc
type IONSFU struct {
	sessions sync.Map // map[string]*Session
}

// Config holds SFU configuration
type Config struct {
	ICEServers []webrtc.ICEServer
}

// NewIONSFU creates a new IONSFU instance
func NewIONSFU(config Config) *IONSFU {
	return &IONSFU{}
}

// Session represents a room/session in the SFU
type Session struct {
	id            string
	peers         sync.Map // map[string]*Peer
	config        Config
	router        *Router
	localTracks   map[string]*webrtc.TrackLocalStaticRTP // trackID -> track
	peersByTrack  map[string]string                      // trackID -> peerID (for routing)
}

// Router handles track routing between peers
type Router struct {
	session *Session
	mu      sync.Mutex
}

// Peer represents a participant in a session
type Peer struct {
	id            string
	pc            *webrtc.PeerConnection
	audioTrack    *webrtc.TrackLocalStaticRTP
	videoTrack    *webrtc.TrackLocalStaticRTP // For screen sharing
	session       *Session
	onICECandidate func(candidate *webrtc.ICECandidate)
	onTrack        func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver)
}

// GetSession gets or creates a session for the given room ID
func (s *IONSFU) GetSession(roomID string) *Session {
	if session, ok := s.sessions.Load(roomID); ok {
		return session.(*Session)
	}

	session := &Session{
		id:           roomID,
		peers:        sync.Map{},
		config:       Config{},
		router:       NewRouter(nil),
		localTracks:  make(map[string]*webrtc.TrackLocalStaticRTP),
		peersByTrack: make(map[string]string),
	}
	session.router.session = session
	s.sessions.Store(roomID, session)
	return session
}

// RemoveSession removes a session
func (s *IONSFU) RemoveSession(roomID string) {
	if session, ok := s.sessions.LoadAndDelete(roomID); ok {
		session.(*Session).Close()
	}
}

// Close closes the SFU and all sessions
func (s *IONSFU) Close() {
	s.sessions.Range(func(key, value any) bool {
		value.(*Session).Close()
		return true
	})
}

// GetStats returns SFU statistics
func (s *IONSFU) GetStats() SFUStats {
	var stats SFUStats
	stats.SessionCount = 0
	stats.PeerCount = 0
	s.sessions.Range(func(_, value any) bool {
		stats.SessionCount++
		session := value.(*Session)
		session.peers.Range(func(_, _ any) bool {
			stats.PeerCount++
			return true
		})
		return true
	})
	return stats
}

// SFUStats holds SFU statistics
type SFUStats struct {
	SessionCount int `json:"sessionCount"`
	PeerCount    int `json:"peerCount"`
}

// NewRouter creates a new router for a session
func NewRouter(session *Session) *Router {
	return &Router{session: session}
}

// AddReceiver adds a receiver for a track and returns a TrackLocal
func (r *Router) AddReceiver(track *webrtc.TrackRemote, peerID string) (*webrtc.TrackLocalStaticRTP, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Create a local track to receive the remote track
	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		track.Codec().RTPCodecCapability,
		track.ID(),
		track.StreamID(),
	)
	if err != nil {
		return nil, err
	}

	// Store the local track
	r.session.localTracks[track.ID()] = localTrack
	r.session.peersByTrack[track.ID()] = peerID

	// Start forwarding
	go r.forwardTrack(track, localTrack)

	return localTrack, nil
}

// forwardTrack forwards packets from remote track to local track
func (r *Router) forwardTrack(remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP) {
	for {
		packet, _, err := remote.ReadRTP()
		if err != nil {
			return
		}
		if err := local.WriteRTP(packet); err != nil {
			return
		}
	}
}

// Close closes the session and all peers
func (s *Session) Close() {
	s.peers.Range(func(key, value any) bool {
		value.(*Peer).Close()
		return true
	})
}

// NewPeer creates a new peer in the session
func (s *Session) NewPeer(peerID string) (*Peer, error) {
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		},
	}

	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return nil, err
	}

	peer := &Peer{
		id:      peerID,
		pc:      pc,
		session: s,
	}

	// Set up track callback
	peer.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("SFU: Track received %s from peer %s", track.Kind(), peerID)

		// Forward this track to all other peers
		s.forwardTrackToPeers(track, peerID)
	})

	s.peers.Store(peerID, peer)
	return peer, nil
}

// forwardTrackToPeers forwards a track to all peers except the sender
func (s *Session) forwardTrackToPeers(track *webrtc.TrackRemote, senderID string) {
	// Add receiver for this track
	_, err := s.router.AddReceiver(track, senderID)
	if err != nil {
		log.Printf("SFU: Failed to add receiver for track: %v", err)
		return
	}

	// Get the local track to forward
	localTrack := s.router.session.localTracks[track.ID()]
	if localTrack == nil {
		return
	}

	// Forward to all other peers
	s.peers.Range(func(key, value any) bool {
		peerID := key.(string)
		if peerID == senderID {
			return true
		}

		peer := value.(*Peer)
		// Add the track to this peer's connection
		_, err := peer.pc.AddTrack(localTrack)
		if err != nil {
			log.Printf("SFU: Failed to add track to peer %s: %v", peerID, err)
		} else {
			log.Printf("SFU: Forwarded track to peer %s", peerID)
			// Create offer for this peer to receive the track
			go func(p *Peer) {
				offer, err := p.pc.CreateOffer(nil)
				if err != nil {
					log.Printf("SFU: Failed to create offer for peer %s: %v", peerID, err)
					return
				}
				if err := p.pc.SetLocalDescription(offer); err != nil {
					log.Printf("SFU: Failed to set local description for peer %s: %v", peerID, err)
					return
				}
				// The offer will be sent to the client via signaling
			}(peer)
		}
		return true
	})
}

// GetPeer gets a peer by ID
func (s *Session) GetPeer(peerID string) *Peer {
	if peer, ok := s.peers.Load(peerID); ok {
		return peer.(*Peer)
	}
	return nil
}

// RemovePeer removes a peer from the session
func (s *Session) RemovePeer(peerID string) {
	if peer, ok := s.peers.LoadAndDelete(peerID); ok {
		peer.(*Peer).Close()
	}
}

// GetPeers returns all peers in the session
func (s *Session) GetPeers() []*Peer {
	var peers []*Peer
	s.peers.Range(func(_, value any) bool {
		peers = append(peers, value.(*Peer))
		return true
	})
	return peers
}

// Close closes the peer connection
func (p *Peer) Close() {
	if p.pc != nil {
		p.pc.Close()
	}
}

// GetPeerConnection returns the underlying PeerConnection
func (p *Peer) GetPeerConnection() *webrtc.PeerConnection {
	return p.pc
}

// SetRemoteDescription sets the remote description
func (p *Peer) SetRemoteDescription(desc webrtc.SessionDescription) error {
	return p.pc.SetRemoteDescription(desc)
}

// CreateAnswer creates an answer for an offer
func (p *Peer) CreateAnswer() (webrtc.SessionDescription, error) {
	return p.pc.CreateAnswer(nil)
}

// CreateOffer creates an offer
func (p *Peer) CreateOffer() (webrtc.SessionDescription, error) {
	return p.pc.CreateOffer(nil)
}

// AddICECandidate adds an ICE candidate
func (p *Peer) AddICECandidate(candidate webrtc.ICECandidateInit) error {
	return p.pc.AddICECandidate(candidate)
}

// OnICECandidate sets the callback for ICE candidates
func (p *Peer) OnICECandidate(callback func(candidate *webrtc.ICECandidate)) {
	p.pc.OnICECandidate(callback)
}

// AddAudioTrack adds an audio track to the peer
func (p *Peer) AddAudioTrack() (*webrtc.TrackLocalStaticRTP, error) {
	audioTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{
			MimeType:  "audio/opus",
			Channels:  2,
			ClockRate: 48000,
		},
		"audio",
		p.id,
	)
	if err != nil {
		return nil, err
	}

	p.audioTrack = audioTrack

	_, err = p.pc.AddTrack(audioTrack)
	if err != nil {
		return nil, err
	}

	return audioTrack, nil
}

// AddVideoTrack adds a video track for screen sharing
func (p *Peer) AddVideoTrack() (*webrtc.TrackLocalStaticRTP, error) {
	videoTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{
			MimeType:  "video/VP8",
			ClockRate: 90000,
		},
		"video",
		p.id,
	)
	if err != nil {
		return nil, err
	}

	p.videoTrack = videoTrack

	_, err = p.pc.AddTrack(videoTrack)
	if err != nil {
		return nil, err
	}

	return videoTrack, nil
}

// OnTrack sets the callback for incoming tracks
func (p *Peer) OnTrack(callback func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver)) {
	p.onTrack = callback
	p.pc.OnTrack(callback)
}

// GetAudioTrack returns the audio track
func (p *Peer) GetAudioTrack() *webrtc.TrackLocalStaticRTP {
	return p.audioTrack
}

// GetVideoTrack returns the video track
func (p *Peer) GetVideoTrack() *webrtc.TrackLocalStaticRTP {
	return p.videoTrack
}

// RemoveAudioTrack removes the audio track
func (p *Peer) RemoveAudioTrack() error {
	if p.audioTrack != nil {
		senders := p.pc.GetSenders()
		for _, sender := range senders {
			if sender.Track() == p.audioTrack {
				return sender.ReplaceTrack(nil)
			}
		}
	}
	return nil
}

// RemoveVideoTrack removes the video track
func (p *Peer) RemoveVideoTrack() error {
	if p.videoTrack != nil {
		senders := p.pc.GetSenders()
		for _, sender := range senders {
			if sender.Track() == p.videoTrack {
				return sender.ReplaceTrack(nil)
			}
		}
	}
	return nil
}

// SetAudioEnabled enables or disables audio
func (p *Peer) SetAudioEnabled(enabled bool) error {
	return nil
}

// SetVideoEnabled enables or disables video
func (p *Peer) SetVideoEnabled(enabled bool) error {
	return nil
}
