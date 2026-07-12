package server

// sfu.go implements SFU functionality using our custom SFU wrapper.
// This provides pure WebRTC audio and screen sharing capabilities.

import (
	"encoding/json"
	"log"

	"github.com/pion/webrtc/v4"
)

type SFUParams struct {
	Type    string          `json:"type"` // offer, answer, candidate, trickle
	Payload json.RawMessage `json:"payload"`
	Track   string          `json:"track"` // "audio" or "video" (for screen sharing)
}

// handleSFUSignal handles SFU signaling messages from clients
func (s *Server) handleSFUSignal(c *Client, params json.RawMessage) {
	var p SFUParams
	if err := json.Unmarshal(params, &p); err != nil {
		log.Printf("SFU signal unmarshal error: %v", err)
		return
	}

	if c.peer == nil {
		return
	}

	switch p.Type {
	case "offer":
		s.handleSFUOffer(c, p.Payload, p.Track)
	case "answer":
		s.handleSFUAnswer(c, p.Payload)
	case "candidate":
		s.handleSFUCandidate(c, p.Payload)
	}
}

func (s *Server) handleSFUOffer(c *Client, payload json.RawMessage, trackType string) {
	peer := c.peer
	room := peer.room

	if room == nil {
		return
	}

	// Unmarshal the offer
	var offer webrtc.SessionDescription
	if err := json.Unmarshal(payload, &offer); err != nil {
		log.Printf("SFU offer unmarshal error: %v", err)
		return
	}

	// Get or create session
	session := s.sfu.GetSession(room.id)

	// Get or create peer in session
	sfuPeer := session.GetPeer(peer.uid)
	if sfuPeer == nil {
		var err error
		sfuPeer, err = session.NewPeer(peer.uid)
		if err != nil {
			log.Printf("SFU NewPeer error: %v", err)
			return
		}

		// Set up ICE candidate callback
		sfuPeer.OnICECandidate(func(candidate *webrtc.ICECandidate) {
			if candidate == nil {
				return
			}
			c := candidate.ToJSON()
			bytes, _ := json.Marshal(c)
			peer.send(struct {
				Method string     `json:"method"`
				Params SFUParams `json:"params"`
			}{
				Method: "sfu.signal",
				Params: SFUParams{
					Type:    "candidate",
					Payload: bytes,
				},
			})
		})

		// Set up track callback for forwarding
		sfuPeer.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
			log.Printf("SFU track received: %s from peer %s", track.Kind(), peer.uid)
			// In a full SFU implementation, we would forward this track to other peers
		})

		peer.sfuPeerID = peer.uid
	}

	// Set remote description
	if err := sfuPeer.SetRemoteDescription(offer); err != nil {
		log.Printf("SFU SetRemoteDescription error: %v", err)
		return
	}

	// Create answer
	answer, err := sfuPeer.CreateAnswer()
	if err != nil {
		log.Printf("SFU CreateAnswer error: %v", err)
		return
	}

	// Add appropriate track
	if trackType == "video" {
		// Screen sharing track
		videoTrack, err := sfuPeer.AddVideoTrack()
		if err != nil {
			log.Printf("SFU AddVideoTrack error: %v", err)
		} else {
			log.Printf("SFU video track added for peer %s", peer.uid)
			_ = videoTrack
		}
	} else {
		// Audio track
		audioTrack, err := sfuPeer.AddAudioTrack()
		if err != nil {
			log.Printf("SFU AddAudioTrack error: %v", err)
		} else {
			log.Printf("SFU audio track added for peer %s", peer.uid)
			_ = audioTrack
		}
	}

	// Send answer to client
	ansBytes, _ := json.Marshal(answer)
	peer.send(struct {
		Method string     `json:"method"`
		Params SFUParams `json:"params"`
	}{
		Method: "sfu.signal",
		Params: SFUParams{
			Type:    "answer",
			Payload: ansBytes,
		},
	})
}

func (s *Server) handleSFUAnswer(c *Client, payload json.RawMessage) {
	peer := c.peer
	if peer == nil || peer.sfuPeerID == "" {
		return
	}

	var answer webrtc.SessionDescription
	if err := json.Unmarshal(payload, &answer); err != nil {
		log.Printf("SFU answer unmarshal error: %v", err)
		return
	}

	// For subscribers, we need to handle the answer
	// In our SFU, subscribers receive offers from the server, not answers
	log.Printf("SFU answer received for peer %s (may be for renegotiation)", peer.uid)
}

func (s *Server) handleSFUCandidate(c *Client, payload json.RawMessage) {
	peer := c.peer
	if peer == nil {
		return
	}

	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal(payload, &candidate); err != nil {
		log.Printf("SFU candidate unmarshal error: %v", err)
		return
	}

	if peer.sfuPeerID != "" {
		session := s.sfu.GetSession(peer.room.id)
		if session != nil {
			sfuPeer := session.GetPeer(peer.uid)
			if sfuPeer != nil {
				if err := sfuPeer.AddICECandidate(candidate); err != nil {
					log.Printf("SFU AddICECandidate error: %v", err)
				}
			}
		}
	}
}

// cleanupSFU cleans up SFU resources when a peer leaves
func (s *Server) cleanupSFU(p *peer) {
	if p.room == nil {
		return
	}

	// Remove peer from SFU session
	session := s.sfu.GetSession(p.room.id)
	if session != nil && p.sfuPeerID != "" {
		session.RemovePeer(p.sfuPeerID)
		log.Printf("SFU peer %s cleanup completed", p.uid)
	}

	// Check if session is empty and can be removed
	peers := session.GetPeers()
	if len(peers) == 0 {
		s.sfu.RemoveSession(p.room.id)
	}
}
