package store

import (
	"github.com/newton-miku/WeSpeek/internal/domain/repository"
)

var ErrNotFound = repository.ErrNotFound
var ErrNotEmpty = repository.ErrNotEmpty

type Store interface {
	repository.RoomRepository
	repository.GroupRepository
	repository.AdminRepository
	repository.ChatRepository

	// Close
	Close() error
}
