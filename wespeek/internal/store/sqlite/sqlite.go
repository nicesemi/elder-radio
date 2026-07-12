package sqlite

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"github.com/newton-miku/WeSpeek/internal/domain/entity"
	"github.com/newton-miku/WeSpeek/internal/store"
)

type SqliteStore struct {
	db *sql.DB
}

func New(path string) (*SqliteStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, fmt.Errorf("failed to create db directory: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open db: %w", err)
	}

	s := &SqliteStore{db: db}
	if err := s.init(); err != nil {
		db.Close()
		return nil, err
	}

	return s, nil
}

func (s *SqliteStore) init() error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			group_name TEXT,
			sort_order INTEGER,
			permanent INTEGER,
			audio_codec TEXT,
			audio_quality INTEGER
		);`,
		`CREATE TABLE IF NOT EXISTS groups (
			name TEXT PRIMARY KEY
		);`,
		`CREATE TABLE IF NOT EXISTS admin_secrets (
			secret TEXT PRIMARY KEY,
			description TEXT,
			role TEXT DEFAULT 'admin',
			created_at INTEGER
		);`,
		`CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			room_id TEXT,
			uid TEXT,
			name TEXT,
			text TEXT,
			created_at INTEGER
		);`,
		`CREATE INDEX IF NOT EXISTS idx_chat_room_time ON chat_messages(room_id, created_at);`,
		`CREATE TABLE IF NOT EXISTS file_refs (
			path TEXT PRIMARY KEY,
			ref_count INTEGER DEFAULT 0,
			updated_at INTEGER
		);`,
	}

	for _, q := range queries {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("init query failed: %w", err)
		}
	}
	_, _ = s.db.Exec(`ALTER TABLE rooms ADD COLUMN audio_codec TEXT`)
	_, _ = s.db.Exec(`ALTER TABLE rooms ADD COLUMN audio_quality INTEGER`)
	_, _ = s.db.Exec(`ALTER TABLE admin_secrets ADD COLUMN role TEXT DEFAULT 'admin'`)
	return nil
}

func (s *SqliteStore) Close() error {
	return s.db.Close()
}

func (s *SqliteStore) GetRooms() ([]entity.Room, error) {
	rows, err := s.db.Query("SELECT id, group_name, sort_order, permanent, audio_codec, audio_quality FROM rooms")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var rooms []entity.Room
	for rows.Next() {
		var r entity.Room
		var perm int
		var codec sql.NullString
		var quality sql.NullInt64
		if err := rows.Scan(&r.ID, &r.Group, &r.Order, &perm, &codec, &quality); err != nil {
			return nil, err
		}
		r.Permanent = perm == 1
		if codec.Valid {
			r.AudioCodec = codec.String
		} else {
			r.AudioCodec = "opus"
		}
		if quality.Valid {
			r.AudioQuality = int(quality.Int64)
		} else {
			r.AudioQuality = 6
		}
		rooms = append(rooms, r)
	}
	return rooms, nil
}

func (s *SqliteStore) GetRoom(id string) (*entity.Room, error) {
	row := s.db.QueryRow("SELECT id, group_name, sort_order, permanent, audio_codec, audio_quality FROM rooms WHERE id = ?", id)
	var r entity.Room
	var perm int
	var codec sql.NullString
	var quality sql.NullInt64
	if err := row.Scan(&r.ID, &r.Group, &r.Order, &perm, &codec, &quality); err != nil {
		if err == sql.ErrNoRows {
			return nil, store.ErrNotFound
		}
		return nil, err
	}
	r.Permanent = perm == 1
	if codec.Valid {
		r.AudioCodec = codec.String
	} else {
		r.AudioCodec = "opus"
	}
	if quality.Valid {
		r.AudioQuality = int(quality.Int64)
	} else {
		r.AudioQuality = 6
	}
	return &r, nil
}

func (s *SqliteStore) SaveRoom(r entity.Room) error {
	perm := 0
	if r.Permanent {
		perm = 1
	}
	_, err := s.db.Exec(`
		INSERT INTO rooms (id, group_name, sort_order, permanent, audio_codec, audio_quality)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		group_name = excluded.group_name,
		sort_order = excluded.sort_order,
		permanent = excluded.permanent,
		audio_codec = excluded.audio_codec,
		audio_quality = excluded.audio_quality
	`, r.ID, r.Group, r.Order, perm, r.AudioCodec, r.AudioQuality)
	return err
}

func (s *SqliteStore) DeleteRoom(id string) error {
	_, err := s.db.Exec("DELETE FROM rooms WHERE id = ?", id)
	return err
}

func (s *SqliteStore) GetGroups() ([]string, error) {
	rows, err := s.db.Query("SELECT name FROM groups")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		groups = append(groups, name)
	}
	return groups, nil
}

func (s *SqliteStore) SaveGroup(name string) error {
	_, err := s.db.Exec("INSERT OR IGNORE INTO groups (name) VALUES (?)", name)
	return err
}

func (s *SqliteStore) DeleteGroup(name string) error {
	_, err := s.db.Exec("DELETE FROM groups WHERE name = ?", name)
	return err
}

func (s *SqliteStore) GetAdminSecrets() ([]entity.AdminIdentity, error) {
	rows, err := s.db.Query("SELECT secret, description, role, created_at FROM admin_secrets")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var secrets []entity.AdminIdentity
	for rows.Next() {
		var r entity.AdminIdentity
		var role sql.NullString
		if err := rows.Scan(&r.Secret, &r.Description, &role, &r.CreatedAt); err != nil {
			return nil, err
		}
		if role.Valid {
			r.Role = entity.AdminRole(role.String)
		} else {
			r.Role = entity.RoleAdmin // Default
		}
		secrets = append(secrets, r)
	}
	return secrets, nil
}

func (s *SqliteStore) AddAdminSecret(secret, description string, role entity.AdminRole) error {
	_, err := s.db.Exec("INSERT OR IGNORE INTO admin_secrets (secret, description, role, created_at) VALUES (?, ?, ?, strftime('%s', 'now'))", secret, description, role)
	return err
}

func (s *SqliteStore) DeleteAdminSecret(secret string) error {
	_, err := s.db.Exec("DELETE FROM admin_secrets WHERE secret = ?", secret)
	return err
}

func (s *SqliteStore) SaveChatMessage(msg entity.ChatMessage) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO chat_messages (room_id, uid, name, text, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, msg.RoomID, msg.UID, msg.Name, msg.Text, msg.CreatedAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *SqliteStore) GetChatMessage(id int64) (entity.ChatMessage, error) {
	var m entity.ChatMessage
	err := s.db.QueryRow(`
		SELECT id, room_id, uid, name, text, created_at
		FROM chat_messages
		WHERE id = ?
	`, id).Scan(&m.ID, &m.RoomID, &m.UID, &m.Name, &m.Text, &m.CreatedAt)
	if err != nil {
		return entity.ChatMessage{}, err
	}
	return m, nil
}

func (s *SqliteStore) GetChatHistory(roomID string, limit int) ([]entity.ChatMessage, error) {
	rows, err := s.db.Query(`
		SELECT id, room_id, uid, name, text, created_at
		FROM chat_messages
		WHERE room_id = ?
		ORDER BY created_at DESC
		LIMIT ?
	`, roomID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []entity.ChatMessage
	for rows.Next() {
		var m entity.ChatMessage
		if err := rows.Scan(&m.ID, &m.RoomID, &m.UID, &m.Name, &m.Text, &m.CreatedAt); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}

	// Reverse to return chronological order
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	return msgs, nil
}

func (s *SqliteStore) GetOldChatMessages(retentionDays int) ([]entity.ChatMessage, error) {
	cutoff := time.Now().AddDate(0, 0, -retentionDays).Unix()
	rows, err := s.db.Query(`
		SELECT id, room_id, uid, name, text, created_at
		FROM chat_messages
		WHERE created_at < ?
	`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []entity.ChatMessage
	for rows.Next() {
		var m entity.ChatMessage
		if err := rows.Scan(&m.ID, &m.RoomID, &m.UID, &m.Name, &m.Text, &m.CreatedAt); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, nil
}

func (s *SqliteStore) DeleteOldChatMessages(retentionDays int) error {
	cutoff := time.Now().AddDate(0, 0, -retentionDays).Unix()
	_, err := s.db.Exec("DELETE FROM chat_messages WHERE created_at < ?", cutoff)
	return err
}

func (s *SqliteStore) DeleteChatMessage(id int64) error {
	_, err := s.db.Exec("DELETE FROM chat_messages WHERE id = ?", id)
	return err
}

func (s *SqliteStore) IncFileRef(path string) error {
	_, err := s.db.Exec(`
		INSERT INTO file_refs (path, ref_count, updated_at)
		VALUES (?, 1, strftime('%s', 'now'))
		ON CONFLICT(path) DO UPDATE SET
		ref_count = ref_count + 1,
		updated_at = excluded.updated_at
	`, path)
	return err
}

func (s *SqliteStore) DecFileRef(path string) (int64, error) {
	// We do this in a transaction to ensure atomic read-modify-write if needed,
	// but single UPDATE with RETURNING is atomic in SQLite.
	// Note: RETURNING clause is available in newer SQLite versions (3.35.0+, 2021).
	// modernc.org/sqlite supports it.

	var newCount int64
	err := s.db.QueryRow(`
		UPDATE file_refs 
		SET ref_count = ref_count - 1, updated_at = strftime('%s', 'now')
		WHERE path = ?
		RETURNING ref_count
	`, path).Scan(&newCount)

	if err == sql.ErrNoRows {
		// Path not found, maybe legacy data or already deleted. Treat as 0.
		return 0, nil
	}
	if err != nil {
		return 0, err
	}

	if newCount <= 0 {
		_, _ = s.db.Exec("DELETE FROM file_refs WHERE path = ?", path)
		return 0, nil
	}

	return newCount, nil
}
