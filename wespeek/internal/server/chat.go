package server

import (
	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/store"
)

func (s *Server) GetPublicChatHistory() []ChatMessage {
	msgs, err := s.chatService.GetChatHistory("", 50)
	if err != nil {
		return []ChatMessage{}
	}
	var res []ChatMessage
	for _, m := range msgs {
		res = append(res, toServerChatMessage(m))
	}
	return res
}

func (s *Server) GetRoomChatHistory(id string) ([]ChatMessage, error) {
	if _, ok := s.rooms.Load(id); !ok {
		return nil, store.ErrNotFound
	}
	msgs, err := s.chatService.GetChatHistory(id, 50)
	if err != nil {
		return nil, err
	}
	var res []ChatMessage
	for _, m := range msgs {
		res = append(res, toServerChatMessage(m))
	}
	return res, nil
}

func toServerChatMessage(m entity.ChatMessage) ChatMessage {
	return ChatMessage{
		ID:   m.ID,
		UID:  m.UID,
		Name: m.Name,
		Text: m.Text,
		Time: m.CreatedAt,
	}
}
