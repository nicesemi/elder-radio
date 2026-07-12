package service

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/newton-miku/WeSpeek/internal/domain/repository"
)

var (
	ErrUploadsDisabled    = errors.New("uploading not allowed")
	ErrFileTooLarge       = errors.New("file too large")
	ErrStoreNotConfigured = errors.New("file storage not configured")
)

// MediaService handles media-related business logic.
// It enforces upload policies (permissions, size limits) and delegates storage to the infrastructure layer.
type MediaService struct {
	fileStore    repository.FileStore
	allowUploads bool
	maxFileSize  int64
}

// NewMediaService creates a new instance of MediaService.
func NewMediaService(fileStore repository.FileStore, allowUploads bool) *MediaService {
	return &MediaService{
		fileStore:    fileStore,
		allowUploads: allowUploads,
		maxFileSize:  10 << 20, // 10MB default
	}
}

// SaveImage validates and saves a standard image file.
func (s *MediaService) SaveImage(filename string, r io.Reader) (string, error) {
	if !s.allowUploads {
		return "", ErrUploadsDisabled
	}
	if s.fileStore == nil {
		return "", ErrStoreNotConfigured
	}

	// Basic validation could be added here (e.g. check mime type)
	// For now we rely on the filename extension and the store implementation

	// Ensure filename has an extension
	if filepath.Ext(filename) == "" {
		filename += ".jpg"
	}

	return s.fileStore.Save(filename, r)
}

// SaveBase64Image decodes a Data URI and saves it as an image file.
// It handles parsing, decoding, validation, and storage.
func (s *MediaService) SaveBase64Image(data string) (string, error) {
	if !s.allowUploads {
		return "", ErrUploadsDisabled
	}
	if s.fileStore == nil {
		return "", ErrStoreNotConfigured
	}

	parts := strings.Split(data, ",")
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid data URI")
	}

	meta := parts[0]
	ext := ".jpg"
	if strings.Contains(meta, "png") {
		ext = ".png"
	} else if strings.Contains(meta, "gif") {
		ext = ".gif"
	} else if strings.Contains(meta, "webp") {
		ext = ".webp"
	}

	raw, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}

	if int64(len(raw)) > s.maxFileSize {
		return "", ErrFileTooLarge
	}

	filename := "upload" + ext
	return s.fileStore.Save(filename, bytes.NewReader(raw))
}

// DeleteFile removes a file from storage.
func (s *MediaService) DeleteFile(url string) error {
	if s.fileStore == nil {
		return ErrStoreNotConfigured
	}
	return s.fileStore.Delete(url)
}

func (s *MediaService) IsUploadAllowed() bool {
	return s.allowUploads
}
