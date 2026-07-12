package service

import (
	"strings"

	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/domain/repository"
)

type ChatService struct {
	repo  repository.ChatRepository
	media *MediaService
}

func NewChatService(repo repository.ChatRepository, media *MediaService) *ChatService {
	return &ChatService{repo: repo, media: media}
}

func (s *ChatService) SetMediaService(media *MediaService) {
	s.media = media
}

func (s *ChatService) SaveMessage(msg entity.ChatMessage) (int64, error) {
	// Increment file reference if it's an image
	var fileUrl string
	isImage := strings.HasPrefix(msg.Text, "image:")
	if isImage {
		fileUrl = strings.TrimPrefix(msg.Text, "image:")
		if err := s.repo.IncFileRef(fileUrl); err != nil {
			// Log error but continue? Or fail?
			// If we fail here, the user sees error, which is good.
			return 0, err
		}
	}

	id, err := s.repo.SaveChatMessage(msg)
	if err != nil {
		// Rollback file ref
		if isImage {
			_, _ = s.repo.DecFileRef(fileUrl)
		}
		return 0, err
	}
	return id, err
}

func (s *ChatService) GetMessage(id int64) (entity.ChatMessage, error) {
	return s.repo.GetChatMessage(id)
}

func (s *ChatService) DeleteMessage(id int64) error {
	// Get message first to check if we need to delete file
	msg, err := s.repo.GetChatMessage(id)

	if err := s.repo.DeleteChatMessage(id); err != nil {
		return err
	}

	if err == nil && s.media != nil && strings.HasPrefix(msg.Text, "image:") {
		fileUrl := strings.TrimPrefix(msg.Text, "image:")
		count, _ := s.repo.DecFileRef(fileUrl)
		if count <= 0 {
			_ = s.media.DeleteFile(fileUrl)
		}
	}

	return nil
}

func (s *ChatService) GetChatHistory(roomID string, limit int) ([]entity.ChatMessage, error) {
	return s.repo.GetChatHistory(roomID, limit)
}

func (s *ChatService) GetPublicHistory() []entity.ChatMessage {
	msgs, _ := s.repo.GetChatHistory("", 50)
	if msgs == nil {
		return []entity.ChatMessage{}
	}
	return msgs
}

func (s *ChatService) GetRoomHistory(roomID string) []entity.ChatMessage {
	msgs, _ := s.repo.GetChatHistory(roomID, 50)
	if msgs == nil {
		return []entity.ChatMessage{}
	}
	return msgs
}

func (s *ChatService) CleanupOldMessages(days int) error {
	// First, get old messages to check for images
	msgs, err := s.repo.GetOldChatMessages(days)
	if err != nil {
		return err
	}

	if err := s.repo.DeleteOldChatMessages(days); err != nil {
		return err
	}

	// Update reference counts for deleted messages
	if s.media != nil {
		for _, m := range msgs {
			if strings.HasPrefix(m.Text, "image:") {
				fileUrl := strings.TrimPrefix(m.Text, "image:")
				count, _ := s.repo.DecFileRef(fileUrl)
				if count <= 0 {
					_ = s.media.DeleteFile(fileUrl)
				}
			}
		}
	}

	return nil
}
