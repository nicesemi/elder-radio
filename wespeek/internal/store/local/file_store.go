package local

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type LocalFileStore struct {
	basePath  string
	urlPrefix string
}

func NewFileStore(basePath, urlPrefix string) *LocalFileStore {
	return &LocalFileStore{
		basePath:  basePath,
		urlPrefix: urlPrefix,
	}
}

func (s *LocalFileStore) Save(filename string, r io.Reader) (string, error) {
	// Ensure directory exists
	if err := os.MkdirAll(s.basePath, 0755); err != nil {
		return "", err
	}

	// Read content to calculate hash
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}

	hash := sha256.Sum256(data)
	hashStr := hex.EncodeToString(hash[:])

	ext := filepath.Ext(filename)
	if ext == "" {
		ext = ".jpg"
	}

	// Generate unique name: hash.ext
	name := hashStr + ext
	dstPath := filepath.Join(s.basePath, name)

	// Check if file already exists (deduplication)
	if _, err := os.Stat(dstPath); err == nil {
		return s.urlPrefix + "/" + name, nil
	}

	dst, err := os.Create(dstPath)
	if err != nil {
		return "", err
	}
	defer dst.Close()

	if _, err := dst.Write(data); err != nil {
		return "", err
	}

	return s.urlPrefix + "/" + name, nil
}

func (s *LocalFileStore) Delete(filename string) error {
	// Filename here might be the full URL or just the name.
	// We assume it might be passed as the URL returned by Save.
	// We need to extract the base name.

	baseName := filepath.Base(filename)
	// Security check: ensure no path traversal
	if baseName == "." || baseName == ".." {
		return fmt.Errorf("invalid filename")
	}

	p := filepath.Join(s.basePath, baseName)
	return os.Remove(p)
}
