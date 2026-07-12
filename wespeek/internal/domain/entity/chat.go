package entity

type ChatMessage struct {
	ID        int64
	RoomID    string // Empty for public chat
	UID       string
	Name      string
	Text      string
	CreatedAt int64
}
