package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/domain/repository"
	"github.com/newton-miku/WeSpeek/internal/util"
)

type AdminService struct {
	repo            repository.AdminRepository
	adminSecrets    sync.Map // map[string]entity.AdminIdentity
	adminChallenges sync.Map // map[string]int64 (nonce -> expiry)
	adminOTT        string
	adminMu         sync.Mutex
}

func NewAdminService(repo repository.AdminRepository) *AdminService {
	s := &AdminService{
		repo: repo,
	}
	// Load secrets
	secrets, _ := repo.GetAdminSecrets()
	for _, sec := range secrets {
		s.adminSecrets.Store(sec.Secret, sec)
	}
	return s
}

func (s *AdminService) CreateAdminChallenge() (string, int64) {
	nonce := util.RandString() + util.RandString()
	exp := time.Now().Add(30 * time.Minute).Unix()
	s.adminChallenges.Store(nonce, exp)
	return nonce, exp
}

func (s *AdminService) VerifyAdmin(nonce, macHex string) (bool, entity.AdminRole) {
	// 1. Check if it's a direct secret (backwards compatibility / simple auth)
	if val, ok := s.adminSecrets.Load(nonce); ok {
		return true, val.(entity.AdminIdentity).Role
	}

	// 2. Check OTT
	s.adminMu.Lock()
	ott := s.adminOTT
	s.adminMu.Unlock()
	if ott != "" && nonce == ott {
		return true, entity.RoleOwner
	}

	// 3. HMAC Verification
	v, ok := s.adminChallenges.Load(nonce)
	if !ok {
		return false, ""
	}
	exp := v.(int64)
	if time.Now().Unix() > exp {
		s.adminChallenges.Delete(nonce)
		return false, ""
	}

	var verifiedRole entity.AdminRole
	s.adminSecrets.Range(func(key, val interface{}) bool {
		secret := key.(string)
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(nonce))
		sum := mac.Sum(nil)
		if strings.EqualFold(hex.EncodeToString(sum), macHex) {
			verifiedRole = val.(entity.AdminIdentity).Role
			return false // stop iteration
		}
		return true
	})

	if verifiedRole != "" {
		// s.adminChallenges.Delete(nonce) // reuse allowed within window
		return true, verifiedRole
	}
	return false, ""
}

func (s *AdminService) CreateLoginSecret(desc string, role entity.AdminRole) (string, error) {
	secret := util.RandStringLen(32)
	id := entity.AdminIdentity{
		Secret:      secret,
		Description: desc,
		Role:        role,
		CreatedAt:   time.Now().Unix(),
	}
	s.adminSecrets.Store(secret, id)
	err := s.repo.AddAdminSecret(secret, desc, role)
	return secret, err
}

func (s *AdminService) RevokeLoginSecret(secret string) error {
	s.adminSecrets.Delete(secret)
	return s.repo.DeleteAdminSecret(secret)
}

func (s *AdminService) GetOTT() string {
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	return s.adminOTT
}

func (s *AdminService) GenerateOTT() string {
	s.adminMu.Lock()
	defer s.adminMu.Unlock()

	s.adminOTT = util.RandStringLen(16)
	// Clear after 10 minutes (Setup link validity)
	go func(ott string) {
		time.Sleep(10 * time.Minute)
		s.adminMu.Lock()
		if s.adminOTT == ott {
			s.adminOTT = ""
		}
		s.adminMu.Unlock()
	}(s.adminOTT)

	return s.adminOTT
}

func (s *AdminService) VerifyAdminSetup(token string) (string, error) {
	s.adminMu.Lock()
	defer s.adminMu.Unlock()

	if s.adminOTT == "" || token != s.adminOTT {
		return "", repository.ErrNotFound // Or standard error
	}

	// Generate a new unique secret for this user (Owner role)
	newSecret := util.RandStringLen(32)
	id := entity.AdminIdentity{
		Secret:      newSecret,
		Description: "Setup via Link",
		Role:        entity.RoleOwner,
		CreatedAt:   time.Now().Unix(),
	}
	// Store in DB
	if err := s.repo.AddAdminSecret(newSecret, id.Description, id.Role); err != nil {
		return "", err
	}
	// Update memory
	s.adminSecrets.Store(newSecret, id)

	// Invalidate the OTT
	s.adminOTT = ""

	return newSecret, nil
}

func (s *AdminService) HasSecrets() bool {
	has := false
	s.adminSecrets.Range(func(_, _ interface{}) bool {
		has = true
		return false
	})
	return has
}
