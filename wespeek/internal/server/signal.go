package server

import (
	"encoding/json"
	"log"
)

type SignalParams struct {
	Target  string          `json:"target"` // Target UID
	Type    string          `json:"type"`   // offer, answer, candidate
	Payload json.RawMessage `json:"payload"`
}

func (s *Server) handleSignal(c *Client, params json.RawMessage) {
	var p SignalParams
	if err := json.Unmarshal(params, &p); err != nil {
		log.Printf("signal unmarshal error: %v", err)
		return
	}

	if p.Target == "sfu" {
		s.handleSFUSignal(c, params)
		return
	}

	if c.peer == nil || c.peer.room == nil {
		return
	}

	// Relay to target
	c.peer.room.mu.RLock()
	targetPeer, ok := c.peer.room.peers[p.Target]
	c.peer.room.mu.RUnlock()

	if ok && targetPeer.send != nil {
		targetPeer.send(struct {
			Method string `json:"method"`
			Params struct {
				Sender  string          `json:"sender"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			} `json:"params"`
		}{
			Method: "signal",
			Params: struct {
				Sender  string          `json:"sender"`
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}{
				Sender:  c.peer.uid,
				Type:    p.Type,
				Payload: p.Payload,
			},
		})
	}
}
