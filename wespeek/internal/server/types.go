package server

import (
	"encoding/json"
	"sync"
	"time"
)

type joinParams struct {
	SID    string `json:"sid"`
	UID    string `json:"uid"`
	Name   string `json:"name"`
	Webrtc bool   `json:"webrtc"`
}

type rpcMessage struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type peer struct {
	server         *Server
	uid            string
	name           string
	ip             string
	role           string // "user", "admin", "owner"
	room           *room
	joinTime       time.Time
	send           func(interface{})
	inputDisabled  bool
	outputDisabled bool
	latency        int64
	webrtc         bool
	grantedSecret  string // Secret granted to this peer (if any) during this session

	// ION-SFU
	sfuPeerID string // ion-sfu peer ID

	// Stats (atomic)
	bytesReceived   uint64
	packetsReceived uint64
	bytesSent       uint64
	packetsSent     uint64
	sentPacketsLost int64
}

type adminUserInfoResponse struct {
	UID   string     `json:"uid"`
	Name  string     `json:"name"`
	IP    string     `json:"ip,omitempty"`
	Room  string     `json:"room"`
	Stats *UserStats `json:"stats,omitempty"`
}

type UserStats struct {
	BytesReceived   uint64 `json:"bytesReceived"`
	PacketsReceived uint64 `json:"packetsReceived"`
	PacketsLost     int64  `json:"packetsLost"`

	BytesSent       uint64 `json:"bytesSent"`
	PacketsSent     uint64 `json:"packetsSent"`
	SentPacketsLost int64  `json:"sentPacketsLost"`

	Latency   int64 `json:"latency"`
	QueueSize int   `json:"queueSize"`
}

type ServerStats struct {
	PeerCount        int     `json:"peerCount"`
	RoomCount        int     `json:"roomCount"`
	AvgPing          float64 `json:"avgPing"`
	AvgQueueSize     float64 `json:"avgQueueSize"`
	TotalPacketsSent uint64  `json:"totalPacketsSent"`
	TotalPacketsLost int64   `json:"totalPacketsLost"`

	// Traffic Stats
	TotalBytesSent     uint64 `json:"totalBytesSent"`
	TotalBytesReceived uint64 `json:"totalBytesReceived"`

	// Room Details
	Rooms []RoomStats `json:"rooms"`

	// System Stats
	GoroutineCount   int    `json:"goroutineCount"`
	AllocMemory      uint64 `json:"allocMemory"`      // Bytes allocated and not yet freed
	TotalAllocMemory uint64 `json:"totalAllocMemory"` // Total bytes allocated (even if freed)
	SysMemory        uint64 `json:"sysMemory"`        // Total memory obtained from OS
	Uptime           int64  `json:"uptime"`           // Seconds
}

type RoomStats struct {
	ID            string  `json:"id"`
	Name          string  `json:"name,omitempty"`
	PeerCount     int     `json:"peerCount"`
	AvgPing       float64 `json:"avgPing"`
	BytesSent     uint64  `json:"bytesSent"`
	BytesReceived uint64  `json:"bytesReceived"`
}

type room struct {
	mu           sync.RWMutex
	id           string
	group        string
	description  string
	order        int
	audioCodec   string
	audioQuality int
	peers        map[string]*peer
	permanent    bool
	deleteTimer  *time.Timer
}

type memberInfo struct {
	UID            string `json:"uid"`
	Name           string `json:"name"`
	Role           string `json:"role"`
	InputDisabled  bool   `json:"inputDisabled"`
	OutputDisabled bool   `json:"outputDisabled"`
	Latency        int64  `json:"latency"`
	Webrtc         bool   `json:"webrtc"`
}

type ChatMessage struct {
	ID   int64  `json:"id"`
	UID  string `json:"uid"`
	Name string `json:"name"`
	Text string `json:"text"`
	Time int64  `json:"time"`
}

type RoomInfo struct {
	ID           string              `json:"id"`
	Group        string              `json:"group"`
	Description  string              `json:"description"`
	Order        int                 `json:"order"`
	AudioCodec   string              `json:"audioCodec"`
	AudioQuality int                 `json:"audioQuality"`
	Count        int                 `json:"count"`
	Members      []RoomMemberSummary `json:"members"`
	Permanent    bool                `json:"permanent"`
}

type RoomMemberSummary struct {
	UID            string `json:"uid"`
	Name           string `json:"name"`
	Role           string `json:"role"`
	InputDisabled  bool   `json:"inputDisabled"`
	OutputDisabled bool   `json:"outputDisabled"`
	Latency        int64  `json:"latency"`
	JoinTime       int64  `json:"joinTime"`
	Webrtc         bool   `json:"webrtc"`
}

type roomsUpdateParams struct {
	Rooms  []RoomInfo `json:"rooms"`
	Groups []string   `json:"groups"`
}
