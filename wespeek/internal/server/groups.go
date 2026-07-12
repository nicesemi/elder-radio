package server

import (
	"github.com/newton-miku/WeSpeek/internal/domain/repository"
)

func (s *Server) GetGroupsSnapshot() []string {
	var out []string
	// include explicit groups
	s.groups.Range(func(k, _ any) bool {
		out = append(out, k.(string))
		return true
	})
	// include implicit groups from rooms
	s.rooms.Range(func(_, v any) bool {
		rm := v.(*room)
		if rm.group != "" {
			out = append(out, rm.group)
		}
		return true
	})
	return uniqueStrings(out)
}

func (s *Server) CreateGroup(name string) error {
	if err := s.roomService.SaveGroup(name); err != nil {
		return err
	}
	s.groups.Store(name, struct{}{})
	return nil
}

func (s *Server) DeleteGroup(name string) error {
	// ensure no rooms under this group
	inUse := false
	s.rooms.Range(func(_, v any) bool {
		if v.(*room).group == name {
			inUse = true
			return false
		}
		return true
	})
	if inUse {
		return repository.ErrNotEmpty
	}

	if err := s.roomService.DeleteGroup(name); err != nil {
		return err
	}
	s.groups.Delete(name)
	return nil
}

func uniqueStrings(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
