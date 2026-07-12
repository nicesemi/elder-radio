package entity

type AdminRole string

const (
	RoleOwner AdminRole = "owner"
	RoleAdmin AdminRole = "admin"
)

type AdminIdentity struct {
	Secret      string    `json:"secret"`
	Description string    `json:"description"`
	Role        AdminRole `json:"role"`
	CreatedAt   int64     `json:"created_at"`
}
