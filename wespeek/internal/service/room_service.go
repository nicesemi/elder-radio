package service

import (
	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/domain/repository"
)

type RoomService struct {
	repo      repository.RoomRepository
	groupRepo repository.GroupRepository
}

func NewRoomService(repo repository.RoomRepository, groupRepo repository.GroupRepository) *RoomService {
	return &RoomService{
		repo:      repo,
		groupRepo: groupRepo,
	}
}

func (s *RoomService) GetRooms() ([]entity.Room, error) {
	return s.repo.GetRooms()
}

func (s *RoomService) SaveRoom(r entity.Room) error {
	return s.repo.SaveRoom(r)
}

func (s *RoomService) DeleteRoom(id string) error {
	return s.repo.DeleteRoom(id)
}

func (s *RoomService) GetGroups() ([]string, error) {
	return s.groupRepo.GetGroups()
}

func (s *RoomService) SaveGroup(name string) error {
	return s.groupRepo.SaveGroup(name)
}

func (s *RoomService) DeleteGroup(name string) error {
	return s.groupRepo.DeleteGroup(name)
}
