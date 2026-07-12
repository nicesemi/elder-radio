package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/util"
)

func (s *Server) dispatchRPC(c *Client, m rpcMessage) {
	switch m.Method {
	case "subscribe":
		s.handleSubscribe(c)
	case "join":
		s.handleJoin(c, m.Params)
	case "chat.public":
		s.handleChatPublic(c, m.Params)
	case "chat.room":
		s.handleChatRoom(c, m.Params)
	case "chat.revoke":
		s.handleChatRevoke(c, m.Params)
	case "rename":
		s.handleRename(c, m.Params)
	case "name":
		s.handleName(c, m.Params)
	case "io.set":
		s.handleIOSet(c, m.Params)
	case "leave":
		s.handleLeave(c)
	case "admin.get_user_info":
		s.handleAdminGetUserInfo(c, m.Params)
	case "admin.login":
		s.handleAdminLogin(c, m.Params)
	case "admin.delete_room":
		s.handleAdminDeleteRoom(c, m.Params)
	case "admin.update_room":
		s.handleAdminUpdateRoom(c, m.Params)
	case "admin.kick":
		s.handleAdminKick(c, m.Params)
	case "admin.mute":
		s.handleAdminMute(c, m.Params)
	case "admin.create_group":
		s.handleAdminCreateGroup(c, m.Params)
	case "admin.delete_group":
		s.handleAdminDeleteGroup(c, m.Params)
	case "admin.grant":
		s.handleAdminGrant(c, m.Params)
	case "admin.revoke":
		s.handleAdminRevoke(c, m.Params)
	case "latency.subscribe":
		s.handleLatencySubscribe(c)
	case "latency.unsubscribe":
		s.handleLatencyUnsubscribe(c)
	case "signal":
		s.handleSignal(c, m.Params)
	case "peer.update":
		s.handlePeerUpdate(c, m.Params)
	case "pong":
		s.handlePong(c, m.Params)
	}
}

func (s *Server) handlePong(c *Client, params json.RawMessage) {
	atomic.StoreInt64(&c.lastPongTime, time.Now().UnixNano())
	var sentTime int64
	if err := json.Unmarshal(params, &sentTime); err != nil {
		return
	}
	if sentTime > 0 && c.peer != nil {
		rtt := (time.Now().UnixNano() - sentTime) / 1e6 // ms
		atomic.StoreInt64(&c.peer.latency, rtt)
	}
}

type peerUpdateParams struct {
	Webrtc *bool `json:"webrtc"`
}

func (s *Server) handlePeerUpdate(c *Client, params json.RawMessage) {
	if c.peer == nil {
		return
	}
	var prm peerUpdateParams
	if err := json.Unmarshal(params, &prm); err != nil {
		return
	}

	changed := false
	if prm.Webrtc != nil {
		if c.peer.webrtc != *prm.Webrtc {
			c.peer.webrtc = *prm.Webrtc
			changed = true
		}
	}

	if changed {
		s.broadcastRoomUpdate(c.peer.room)
	}
}

func (s *Server) handleLatencySubscribe(c *Client) {
	s.latencySubs.Store(c.id, func(v interface{}) {
		select {
		case c.msgCh <- v:
		default:
		}
	})
}

func (s *Server) handleLatencyUnsubscribe(c *Client) {
	s.latencySubs.Delete(c.id)
}

func (s *Server) handleSubscribe(c *Client) {
	c.msgCh <- struct {
		Method string            `json:"method"`
		Params roomsUpdateParams `json:"params"`
	}{Method: "rooms.update", Params: roomsUpdateParams{
		Rooms:  s.GetRoomsSnapshot(),
		Groups: s.GetGroupsSnapshot(),
	}}

	// Get public chat history from DB
	publicHistory := s.GetPublicChatHistory()
	c.msgCh <- struct {
		Method string        `json:"method"`
		Params []ChatMessage `json:"params"`
	}{Method: "chat.public.history", Params: publicHistory}

	// Send server config
	c.msgCh <- struct {
		Method string `json:"method"`
		Params struct {
			AllowUploads bool `json:"allowUploads"`
		} `json:"params"`
	}{
		Method: "server.config",
		Params: struct {
			AllowUploads bool `json:"allowUploads"`
		}{AllowUploads: s.AllowUploads},
	}
}

func (s *Server) handleJoin(c *Client, params json.RawMessage) {
	var prm joinParams
	if err := json.Unmarshal(params, &prm); err != nil {
		return
	}

	// Ensure single channel membership: leave current room if any
	if c.peer != nil {
		c.peer.close()
	}

	rm := s.getOrCreateRoom(prm.SID)
	name := prm.Name
	if name == "" {
		name = prm.UID
	}

	// Use the IP resolved during connection
	ip := c.remoteIP

	// Create peer and link to client
	c.peer = s.newPeer(prm.UID, name, ip, rm, prm.Webrtc, func(v interface{}) {
		select {
		case c.msgCh <- v:
		default:
		}
	})

	roomHistory, _ := s.GetRoomChatHistory(rm.id)
	if roomHistory == nil {
		roomHistory = []ChatMessage{}
	}
	c.msgCh <- struct {
		Method string        `json:"method"`
		Params []ChatMessage `json:"params"`
	}{Method: "chat.room.history", Params: roomHistory}
}

func (s *Server) handleChatPublic(c *Client, params json.RawMessage) {
	var in struct {
		UID  string `json:"uid"`
		Name string `json:"name"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	name := in.Name
	if c.peer != nil {
		name = c.peer.name
	} else if name == "" {
		name = in.UID
	}
	if name == "" {
		return
	}

	text := in.Text
	if s.StoreImagesAsFiles && strings.HasPrefix(text, "data:image/") {
		if url, err := s.saveBase64Image(text); err == nil {
			text = "image:" + url
		}
	}

	msg := ChatMessage{
		UID:  in.UID,
		Name: name,
		Text: text,
		Time: time.Now().Unix(),
	}

	// Save to DB
	id, _ := s.chatService.SaveMessage(entity.ChatMessage{
		RoomID:    "",
		UID:       msg.UID,
		Name:      msg.Name,
		Text:      msg.Text,
		CreatedAt: msg.Time,
	})
	msg.ID = id

	// Broadcast
	s.clients.Range(func(key, value interface{}) bool {
		send := value.(func(interface{}))
		send(struct {
			Method string      `json:"method"`
			Params ChatMessage `json:"params"`
		}{Method: "chat.public", Params: msg})
		return true
	})
}

func (s *Server) handleChatRoom(c *Client, params json.RawMessage) {
	var in struct {
		UID  string `json:"uid"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	if c.peer == nil {
		return
	}

	text := in.Text
	if s.StoreImagesAsFiles && strings.HasPrefix(text, "data:image/") {
		if url, err := s.saveBase64Image(text); err == nil {
			text = "image:" + url
		}
	}

	msg := ChatMessage{
		UID:  c.peer.uid,
		Name: c.peer.name,
		Text: text,
		Time: time.Now().Unix(),
	}

	// Save to DB
	id, _ := s.chatService.SaveMessage(entity.ChatMessage{
		RoomID:    c.peer.room.id,
		UID:       msg.UID,
		Name:      msg.Name,
		Text:      msg.Text,
		CreatedAt: msg.Time,
	})
	msg.ID = id

	for _, peer := range c.peer.room.peers {
		peer.send(struct {
			Method string      `json:"method"`
			Params ChatMessage `json:"params"`
		}{Method: "chat.room", Params: msg})
	}
}

func (s *Server) handleRename(c *Client, params json.RawMessage) {
	var in struct {
		UID string `json:"uid"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	if c.peer == nil || in.UID == "" {
		return
	}
	s.doRename(c.peer, in.UID)
}

func (s *Server) handleName(c *Client, params json.RawMessage) {
	var in struct {
		UID  string `json:"uid"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	if c.peer == nil || in.UID == "" {
		return
	}
	c.peer.room.mu.Lock()
	c.peer.name = in.Name
	c.peer.room.mu.Unlock()
	s.broadcastRoomUpdate(c.peer.room)
	s.broadcastRoomsUpdate()
}

func (s *Server) handleAdminGrant(_ *Client, params json.RawMessage) {
	var in struct {
		Auth string `json:"auth"`
		UID  string `json:"uid"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	ok, role := s.VerifyAdmin(parts[0], parts[1])
	// Only Owner can grant admin
	if !ok || role != entity.RoleOwner {
		return
	}

	// Generate new secret (Admin role)
	secret, err := s.adminService.CreateLoginSecret("Granted to "+in.UID, entity.RoleAdmin)
	if err != nil {
		return
	}

	// Find target peer and send secret
	var targetPeer *peer
	s.rooms.Range(func(key, value interface{}) bool {
		r := value.(*room)
		r.mu.RLock()
		if p, ok := r.peers[in.UID]; ok {
			targetPeer = p
			r.mu.RUnlock()
			return false
		}
		r.mu.RUnlock()
		return true
	})

	if targetPeer != nil {
		targetPeer.grantedSecret = secret // Store for revocation
		targetPeer.role = string(entity.RoleAdmin)
		s.broadcastRoomUpdate(targetPeer.room)
		targetPeer.send(struct {
			Method string `json:"method"`
			Params struct {
				Secret string `json:"secret"`
				Role   string `json:"role"`
			} `json:"params"`
		}{
			Method: "admin.granted",
			Params: struct {
				Secret string `json:"secret"`
				Role   string `json:"role"`
			}{Secret: secret, Role: string(entity.RoleAdmin)},
		})
	}
}

func (s *Server) handleAdminRevoke(_ *Client, params json.RawMessage) {
	var in struct {
		Auth string `json:"auth"`
		UID  string `json:"uid"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	ok, role := s.VerifyAdmin(parts[0], parts[1])
	// Only Owner can revoke
	if !ok || role != entity.RoleOwner {
		return
	}

	// Find target peer
	var targetPeer *peer
	s.rooms.Range(func(key, value interface{}) bool {
		r := value.(*room)
		r.mu.RLock()
		if p, ok := r.peers[in.UID]; ok {
			targetPeer = p
			r.mu.RUnlock()
			return false
		}
		r.mu.RUnlock()
		return true
	})

	if targetPeer != nil {
		// Revoke the secret if we know it
		if targetPeer.grantedSecret != "" {
			_ = s.adminService.RevokeLoginSecret(targetPeer.grantedSecret)
			targetPeer.grantedSecret = ""
		}

		targetPeer.role = "user"
		s.broadcastRoomUpdate(targetPeer.room)

		// Also notify the user to clear their local storage
		targetPeer.send(struct {
			Method string `json:"method"`
		}{
			Method: "admin.revoked",
		})
	}
}

func (s *Server) handleChatRevoke(c *Client, params json.RawMessage) {
	var in struct {
		MsgID int64  `json:"msgId"`
		UID   string `json:"uid"`
		Auth  string `json:"auth"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}

	msg, err := s.chatService.GetMessage(in.MsgID)
	if err != nil {
		return
	}

	isAdmin := false
	if in.Auth != "" {
		parts := strings.Split(in.Auth, ":")
		if len(parts) == 2 {
			if ok, _ := s.VerifyAdmin(parts[0], parts[1]); ok {
				isAdmin = true
			}
		}
	}

	requestUID := in.UID
	if c.peer != nil {
		requestUID = c.peer.uid
	}
	if !isAdmin && requestUID == "" {
		return
	}

	isOwner := (msg.UID == requestUID)
	// 2 minutes limit
	isWithinTime := (time.Now().Unix() - msg.CreatedAt) <= 120

	if isAdmin || (isOwner && isWithinTime) {
		if err := s.chatService.DeleteMessage(in.MsgID); err == nil {
			// Construct revoke message
			out := struct {
				Method string `json:"method"`
				Params struct {
					MsgID int64 `json:"msgId"`
				} `json:"params"`
			}{
				Method: "chat.revoke",
				Params: struct {
					MsgID int64 `json:"msgId"`
				}{MsgID: in.MsgID},
			}

			// Broadcast
			if msg.RoomID == "" {
				s.clients.Range(func(key, value interface{}) bool {
					send := value.(func(interface{}))
					send(out)
					return true
				})
			} else {
				if r, ok := s.rooms.Load(msg.RoomID); ok {
					rm := r.(*room)
					rm.mu.RLock()
					for _, p := range rm.peers {
						p.send(out)
					}
					rm.mu.RUnlock()
				}
			}
		}
	}
}

func (s *Server) saveBase64Image(data string) (string, error) {
	if s.mediaService == nil {
		return "", fmt.Errorf("media service not initialized")
	}
	return s.mediaService.SaveBase64Image(data)
}

func (s *Server) handleIOSet(c *Client, params json.RawMessage) {
	var in struct {
		InputDisabled  *bool `json:"inputDisabled"`
		OutputDisabled *bool `json:"outputDisabled"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	if c.peer == nil {
		return
	}
	if in.InputDisabled != nil {
		c.peer.inputDisabled = *in.InputDisabled
	}
	if in.OutputDisabled != nil {
		c.peer.outputDisabled = *in.OutputDisabled
	}
	s.broadcastRoomUpdate(c.peer.room)
}

func (s *Server) handleLeave(c *Client) {
	if c.peer != nil {
		c.peer.close()
		c.peer = nil
	}
}

func (s *Server) handleAdminGetUserInfo(c *Client, params json.RawMessage) {
	var in struct {
		UID  string `json:"uid"`
		Auth string `json:"auth"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}

	// HMAC check
	isAdmin := false
	if in.Auth != "" {
		parts := strings.Split(in.Auth, ":")
		if len(parts) == 2 {
			isAdmin, _ = s.VerifyAdmin(parts[0], parts[1])
		}
	}

	var targetPeer *peer
	s.rooms.Range(func(key, value interface{}) bool {
		r := value.(*room)
		r.mu.RLock()
		if p, ok := r.peers[in.UID]; ok {
			targetPeer = p
			r.mu.RUnlock()
			return false
		}
		r.mu.RUnlock()
		return true
	})

	if targetPeer != nil {
		resp := adminUserInfoResponse{
			UID:   targetPeer.uid,
			Name:  targetPeer.name,
			Room:  targetPeer.room.id,
			Stats: targetPeer.GetPeerStats(),
		}
		if isAdmin {
			resp.IP = targetPeer.ip
		}

		c.msgCh <- struct {
			Method string                `json:"method"`
			Params adminUserInfoResponse `json:"params"`
		}{Method: "admin.user_info", Params: resp}
	}
}

func (s *Server) handleAdminLogin(c *Client, params json.RawMessage) {
	var in struct {
		Password string `json:"password"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	if in.Password == util.EnvOr("ADMIN_PASSWORD", "admin") {
		secret, err := s.adminService.CreateLoginSecret("admin login", entity.RoleOwner)
		if err != nil {
			return
		}

		if c.peer != nil {
			c.peer.role = string(entity.RoleOwner)
			s.broadcastRoomUpdate(c.peer.room)
		}

		c.msgCh <- struct {
			Method string `json:"method"`
			Params struct {
				Secret string `json:"secret"`
				Role   string `json:"role"`
			} `json:"params"`
		}{Method: "admin.login", Params: struct {
			Secret string `json:"secret"`
			Role   string `json:"role"`
		}{Secret: secret, Role: string(entity.RoleOwner)}}
	}
}

func (s *Server) handleAdminDeleteRoom(_ *Client, params json.RawMessage) {
	var in struct {
		Auth string `json:"auth"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	if ok, _ := s.VerifyAdmin(parts[0], parts[1]); !ok {
		return
	}

	if r, ok := s.rooms.Load(in.ID); ok {
		rm := r.(*room)
		rm.mu.Lock()
		for _, p := range rm.peers {
			p.room = nil // Detach
			// Notify user?
		}
		rm.mu.Unlock()
		s.rooms.Delete(in.ID)
		_ = s.roomService.DeleteRoom(in.ID)
		s.broadcastRoomsUpdate()
	}
}

func (s *Server) handleAdminUpdateRoom(_ *Client, params json.RawMessage) {
	var in struct {
		Auth         string  `json:"auth"`
		ID           string  `json:"id"`
		Permanent    *bool   `json:"permanent"`
		Order        *int    `json:"order"`
		AudioCodec   *string `json:"audioCodec"`
		AudioQuality *int    `json:"audioQuality"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	if ok, _ := s.VerifyAdmin(parts[0], parts[1]); !ok {
		return
	}

	if r, ok := s.rooms.Load(in.ID); ok {
		rm := r.(*room)
		if in.Permanent != nil {
			rm.permanent = *in.Permanent
		}
		if in.Order != nil {
			rm.order = *in.Order
		}
		if in.AudioCodec != nil && *in.AudioCodec != "" {
			rm.audioCodec = *in.AudioCodec
		}
		if in.AudioQuality != nil && *in.AudioQuality != 0 {
			rm.audioQuality = *in.AudioQuality
		}
		_ = s.roomService.SaveRoom(entity.Room{
			ID:           rm.id,
			Permanent:    rm.permanent,
			Order:        rm.order,
			Group:        rm.group,
			AudioCodec:   rm.audioCodec,
			AudioQuality: rm.audioQuality,
		})
		s.broadcastRoomsUpdate()
	}
}

func (s *Server) handleAdminKick(_ *Client, params json.RawMessage) {
	var in struct {
		Auth string `json:"auth"`
		UID  string `json:"uid"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	if ok, _ := s.VerifyAdmin(parts[0], parts[1]); !ok {
		return
	}

	// Find peer
	var targetPeer *peer
	s.rooms.Range(func(key, value interface{}) bool {
		r := value.(*room)
		r.mu.RLock()
		if p, ok := r.peers[in.UID]; ok {
			targetPeer = p
			r.mu.RUnlock()
			return false
		}
		r.mu.RUnlock()
		return true
	})

	if targetPeer != nil {
		targetPeer.close()
	}
}

func (s *Server) handleAdminMute(_ *Client, params json.RawMessage) {
	var in struct {
		Auth string `json:"auth"`
		UID  string `json:"uid"`
		Mute bool   `json:"mute"` // true=mute, false=unmute
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	if ok, _ := s.VerifyAdmin(parts[0], parts[1]); !ok {
		return
	}

	// Find peer
	var targetPeer *peer
	s.rooms.Range(func(key, value interface{}) bool {
		r := value.(*room)
		r.mu.RLock()
		if p, ok := r.peers[in.UID]; ok {
			targetPeer = p
			r.mu.RUnlock()
			return false
		}
		r.mu.RUnlock()
		return true
	})

	if targetPeer != nil {
		targetPeer.inputDisabled = in.Mute
		s.broadcastRoomUpdate(targetPeer.room)
	}
}

func (s *Server) handleAdminCreateGroup(_ *Client, params json.RawMessage) {
	var in struct {
		Auth string `json:"auth"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	if ok, _ := s.VerifyAdmin(parts[0], parts[1]); !ok {
		return
	}

	s.groups.Store(in.Name, struct{}{})
	_ = s.roomService.SaveGroup(in.Name)
	s.broadcastRoomsUpdate()
}

func (s *Server) handleAdminDeleteGroup(_ *Client, params json.RawMessage) {
	var in struct {
		Auth string `json:"auth"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return
	}
	parts := strings.Split(in.Auth, ":")
	if len(parts) != 2 {
		return
	}
	if ok, _ := s.VerifyAdmin(parts[0], parts[1]); !ok {
		return
	}

	s.groups.Delete(in.Name)
	_ = s.roomService.DeleteGroup(in.Name)
	// Also update rooms in this group to have no group?
	// Implementation choice: current logic doesn't strictly enforce foreign keys
	// But let's clear group from rooms for consistency
	s.rooms.Range(func(key, value interface{}) bool {
		r := value.(*room)
		if r.group == in.Name {
			r.group = ""
			_ = s.roomService.SaveRoom(entity.Room{
				ID:        r.id,
				Permanent: r.permanent,
				Order:     r.order,
				Group:     "",
			})
		}
		return true
	})

	s.broadcastRoomsUpdate()
}
