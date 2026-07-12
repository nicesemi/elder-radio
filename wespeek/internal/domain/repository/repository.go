package repository

import (
	"errors"

	"github.com/newton-miku/WeSpeek/internal/domain/entity"
)

var (
	ErrNotFound = errors.New("not found")
	ErrNotEmpty = errors.New("not empty")
)

type RoomRepository interface {
	GetRooms() ([]entity.Room, error)
	SaveRoom(room entity.Room) error
	DeleteRoom(id string) error
}

type GroupRepository interface {
	GetGroups() ([]string, error)
	SaveGroup(name string) error
	DeleteGroup(name string) error
}

type ChatRepository interface {
	SaveChatMessage(msg entity.ChatMessage) (int64, error)
	GetChatMessage(id int64) (entity.ChatMessage, error)
	GetChatHistory(roomID string, limit int) ([]entity.ChatMessage, error)
	GetOldChatMessages(retentionDays int) ([]entity.ChatMessage, error)
	DeleteOldChatMessages(retentionDays int) error
	DeleteChatMessage(id int64) error

	// File reference counting
	IncFileRef(path string) error
	DecFileRef(path string) (int64, error)
}

type AdminRepository interface {
	GetAdminSecrets() ([]entity.AdminIdentity, error)
	AddAdminSecret(secret, description string, role entity.AdminRole) error
	DeleteAdminSecret(secret string) error
}
