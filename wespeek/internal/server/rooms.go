package server

import (
	"sort"
	"sync/atomic"
	"time"

	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/domain/repository"
	"github.com/newton-miku/WeSpeek/internal/store"
)

func (s *Server) GetRoomsSnapshot() []RoomInfo {
	var list []RoomInfo
	s.rooms.Range(func(_, value any) bool {
		rm := value.(*room)
		rm.mu.RLock()
		rmIDs := make([]RoomMemberSummary, 0, len(rm.peers))
		for uid, p := range rm.peers {
			rmIDs = append(rmIDs, RoomMemberSummary{
				UID:            uid,
				Name:           p.name,
				Role:           p.role,
				InputDisabled:  p.inputDisabled,
				OutputDisabled: p.outputDisabled,
				Latency:        atomic.LoadInt64(&p.latency),
				JoinTime:       p.joinTime.Unix(),
				Webrtc:         p.webrtc,
			})
		}
		rm.mu.RUnlock()
		sort.Slice(rmIDs, func(i, j int) bool {
			return rmIDs[i].Name < rmIDs[j].Name
		})
		list = append(list, RoomInfo{
			ID: rm.id, Members: rmIDs, Permanent: rm.permanent, Group: rm.group, Order: rm.order, Description: rm.description, AudioCodec: rm.audioCodec, AudioQuality: rm.audioQuality,
		})
		return true
	})
	return list
}

func (s *Server) broadcastAll(v interface{}) {
	s.clients.Range(func(_, value any) bool {
		value.(func(interface{}))(v)
		return true
	})
}

func (s *Server) CreateOrUpdateRoom(id string, permanent bool, group string, order int) error {
	if permanent {
		err := s.roomService.SaveRoom(entity.Room{
			ID:        id,
			Group:     group,
			Order:     order,
			Permanent: true,
		})
		if err != nil {
			return err
		}
	} else {
		_ = s.roomService.DeleteRoom(id)
	}

	v, ok := s.rooms.Load(id)
	if !ok {
		rm := &room{id: id, group: group, peers: map[string]*peer{}, permanent: permanent, order: order, audioCodec: "opus", audioQuality: 6}
		s.rooms.Store(id, rm)
		if !rm.permanent {
			s.scheduleRoomCleanup(rm)
		}
	} else {
		rm := v.(*room)
		rm.permanent = permanent
		rm.group = group
		rm.order = order
		if rm.audioCodec == "" {
			rm.audioCodec = "opus"
		}
		if rm.audioQuality == 0 {
			rm.audioQuality = 6
		}
		if rm.permanent {
			if rm.deleteTimer != nil {
				rm.deleteTimer.Stop()
				rm.deleteTimer = nil
			}
		} else if len(rm.peers) == 0 {
			s.scheduleRoomCleanup(rm)
		}
	}
	_ = s.roomService.SaveRoom(entity.Room{
		ID:           id,
		Group:        group,
		Order:        order,
		Permanent:    permanent,
		AudioCodec:   "opus",
		AudioQuality: 6,
	})
	s.broadcastRoomsUpdate()
	return nil
}

func (s *Server) DeleteRoom(id string) error {
	v, ok := s.rooms.Load(id)
	if !ok {
		return nil
	}
	rm := v.(*room)
	rm.mu.RLock()
	count := len(rm.peers)
	rm.mu.RUnlock()

	if count > 0 {
		return repository.ErrNotEmpty // Assuming ErrNotEmpty is in repository now, or create it
	}

	_ = s.roomService.DeleteRoom(id)

	rm.permanent = false
	s.rooms.Delete(id)
	s.broadcastRoomsUpdate()
	return nil
}

func (s *Server) GetRoomMembers(id string) ([]RoomMemberSummary, error) {
	v, ok := s.rooms.Load(id)
	if !ok {
		return nil, store.ErrNotFound
	}
	rm := v.(*room)
	rm.mu.RLock()
	ids := make([]RoomMemberSummary, 0, len(rm.peers))
	for uid, p := range rm.peers {
		ids = append(ids, RoomMemberSummary{
			UID:            uid,
			Name:           p.name,
			Role:           p.role,
			InputDisabled:  p.inputDisabled,
			OutputDisabled: p.outputDisabled,
			Latency:        atomic.LoadInt64(&p.latency),
		})
	}
	rm.mu.RUnlock()
	sort.Slice(ids, func(i, j int) bool {
		return ids[i].Name < ids[j].Name
	})
	return ids, nil
}

func (s *Server) broadcastRoomsUpdate() {
	out := struct {
		Method string            `json:"method"`
		Params roomsUpdateParams `json:"params"`
	}{Method: "rooms.update", Params: roomsUpdateParams{
		Rooms:  s.GetRoomsSnapshot(),
		Groups: s.GetGroupsSnapshot(),
	}}
	s.broadcastAll(out)
}

func (s *Server) broadcastRoomUpdate(rm *room) {
	rm.mu.RLock()
	members := make([]memberInfo, 0, len(rm.peers))
	for uid, p := range rm.peers {
		members = append(members, memberInfo{
			UID:            uid,
			Name:           p.name,
			Role:           p.role,
			InputDisabled:  p.inputDisabled,
			OutputDisabled: p.outputDisabled,
			Latency:        atomic.LoadInt64(&p.latency),
			Webrtc:         p.webrtc,
		})
	}
	rm.mu.RUnlock()
	sort.Slice(members, func(i, j int) bool {
		return members[i].Name < members[j].Name
	})
	out := struct {
		Method string `json:"method"`
		Params struct {
			ID      string       `json:"id"`
			Members []memberInfo `json:"members"`
		} `json:"params"`
	}{Method: "room.update", Params: struct {
		ID      string       `json:"id"`
		Members []memberInfo `json:"members"`
	}{ID: rm.id, Members: members}}
	s.broadcastAll(out)
}

func (s *Server) UpdateRoomAudio(id, codec string, quality int) error {
	v, ok := s.rooms.Load(id)
	if !ok {
		return store.ErrNotFound
	}
	rm := v.(*room)
	if codec != "" {
		rm.audioCodec = codec
	}
	if quality != 0 {
		rm.audioQuality = quality
	}
	_ = s.roomService.SaveRoom(entity.Room{
		ID:           rm.id,
		Group:        rm.group,
		Order:        rm.order,
		Permanent:    rm.permanent,
		AudioCodec:   rm.audioCodec,
		AudioQuality: rm.audioQuality,
	})
	s.broadcastRoomsUpdate()
	return nil
}

func (s *Server) getOrCreateRoom(id string) *room {
	if v, ok := s.rooms.Load(id); ok {
		return v.(*room)
	}
	rm := &room{id: id, peers: map[string]*peer{}}
	s.rooms.Store(id, rm)
	return rm
}

func (s *Server) scheduleRoomCleanup(rm *room) {
	if rm == nil || rm.permanent {
		return
	}
	if len(rm.peers) > 0 {
		return
	}
	if rm.deleteTimer != nil {
		return
	}
	base := 30 * time.Minute
	jitter := time.Duration((time.Now().UnixNano()%int64(11) - 5)) * time.Minute
	d := base + jitter
	if d < 5*time.Minute {
		d = 5 * time.Minute
	}
	rm.deleteTimer = time.AfterFunc(d, func() {
		// re-check before delete
		if rm.permanent {
			return
		}
		rm.mu.RLock()
		count := len(rm.peers)
		rm.mu.RUnlock()
		if count > 0 {
			return
		}
		s.rooms.Delete(rm.id)
		s.broadcastRoomsUpdate()
	})
}
