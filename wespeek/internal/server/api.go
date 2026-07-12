package server

import (
	"encoding/json"
	"net/http"

	"github.com/newton-miku/WeSpeek/internal/store"
)

// RoomsHandler handles room listing and creation
func (s *Server) RoomsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		list := s.GetRoomsSnapshot()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	case http.MethodPost:
		if !s.isAdmin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			ID           string  `json:"id"`
			Permanent    *bool   `json:"permanent"`
			Group        *string `json:"group"`
			Parent       *string `json:"parent"`
			Order        *int    `json:"order"`
			AudioCodec   *string `json:"audioCodec"`
			AudioQuality *int    `json:"audioQuality"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if (body.Group == nil || *body.Group == "") && body.Parent != nil && *body.Parent != "" {
			body.Group = body.Parent
		}

		metaProvided := body.Permanent != nil || body.Group != nil || body.Order != nil
		if metaProvided {
			permanent := false
			group := ""
			order := 0
			if body.Permanent != nil {
				permanent = *body.Permanent
			}
			if body.Group != nil {
				group = *body.Group
			}
			if body.Order != nil {
				order = *body.Order
			}
			if err := s.CreateOrUpdateRoom(body.ID, permanent, group, order); err != nil {
				http.Error(w, "failed to save room", http.StatusInternalServerError)
				return
			}
		}
		if body.AudioCodec != nil || body.AudioQuality != nil {
			codec := ""
			quality := 0
			if body.AudioCodec != nil {
				codec = *body.AudioCodec
			}
			if body.AudioQuality != nil {
				quality = *body.AudioQuality
			}
			_ = s.UpdateRoomAudio(body.ID, codec, quality)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// RoomMembersHandler handles room member listing
func (s *Server) RoomMembersHandler(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/api/rooms/"):]
	switch r.Method {
	case http.MethodGet:
		members, err := s.GetRoomMembers(id)
		type resp struct {
			ID      string           `json:"id"`
			Members []RoomMemberSummary `json:"members"`
		}
		w.Header().Set("Content-Type", "application/json")
		if err == store.ErrNotFound {
			_ = json.NewEncoder(w).Encode(resp{ID: id, Members: []RoomMemberSummary{}})
			return
		}
		_ = json.NewEncoder(w).Encode(resp{ID: id, Members: members})
	case http.MethodDelete:
		if !s.isAdmin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		err := s.DeleteRoom(id)
		if err == store.ErrNotEmpty {
			http.Error(w, "room not empty", http.StatusConflict)
			return
		}
		if err != nil {
			// Ignore other errors
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// GroupsHandler handles group listing and creation
func (s *Server) GroupsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.GetGroupsSnapshot())
	case http.MethodPost:
		if !s.isAdmin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		if err := s.CreateGroup(body.Name); err != nil {
			http.Error(w, "failed to save group", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if !s.isAdmin(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		name := r.URL.Path[len("/api/groups/"):]

		err := s.DeleteGroup(name)
		if err == store.ErrNotEmpty {
			http.Error(w, "group not empty", http.StatusConflict)
			return
		}
		if err != nil {
			http.Error(w, "failed to delete group", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// PublicChatHandler handles public chat history
func (s *Server) PublicChatHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.GetPublicChatHistory())
}

// RoomChatHandler handles room chat history
func (s *Server) RoomChatHandler(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/api/chat/room/"):]
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	history, err := s.GetRoomChatHistory(id)
	if err == store.ErrNotFound {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(history)
}

// UploadHandler handles file uploads
func (s *Server) UploadHandler(w http.ResponseWriter, r *http.Request) {
	if !s.AllowUploads {
		http.Error(w, "uploading not allowed", http.StatusForbidden)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit 10MB
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		http.Error(w, "file too large", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	url, err := s.SaveImage(header.Filename, file)
	if err != nil {
		if err.Error() == "uploading not allowed" {
			http.Error(w, "uploading not allowed", http.StatusForbidden)
		} else {
			http.Error(w, "server error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"url": url})
}

// AdminSetupHandler handles admin setup
func (s *Server) AdminSetupHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	secret, err := s.VerifyAdminSetup(body.Token)
	if err != nil {
		http.Error(w, "invalid token", http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Secret string `json:"secret"`
	}{Secret: secret})
}

// AdminChallengeHandler generates admin auth challenge
func (s *Server) AdminChallengeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	nonce, exp := s.CreateAdminChallenge()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Nonce string `json:"nonce"`
		Exp   int64  `json:"exp"`
	}{Nonce: nonce, Exp: exp})
}

// AdminMoveUserHandler moves user to another room
func (s *Server) AdminMoveUserHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.isAdmin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		UID    string `json:"uid"`
		RoomID string `json:"room_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.MoveUser(body.UID, body.RoomID); err != nil {
		if err == store.ErrNotFound {
			http.Error(w, "user or room not found", http.StatusNotFound)
			return
		}
		http.Error(w, "failed to move user", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AdminStatusHandler returns server status
func (s *Server) AdminStatusHandler(w http.ResponseWriter, r *http.Request) {
	if !s.isAdmin(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	stats := s.GetServerStats()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}
