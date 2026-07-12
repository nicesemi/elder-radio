package repository

import "io"

type FileStore interface {
	// Save saves the content from reader to the store with the given filename.
	// Returns the public URL/path to the file and error if any.
	Save(filename string, r io.Reader) (string, error)

	// Delete removes the file with the given filename from the store.
	Delete(filename string) error
}
