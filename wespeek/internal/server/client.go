package server

import (
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type Client struct {
	server       *Server
	conn         *websocket.Conn
	msgCh        chan interface{}
	peer         *peer
	id           string
	remoteIP     string
	lastPongTime int64
}

func (s *Server) newClient(conn *websocket.Conn, id, ip string) *Client {
	return &Client{
		server:       s,
		conn:         conn,
		msgCh:        make(chan interface{}, 256),
		id:           id,
		remoteIP:     ip,
		lastPongTime: time.Now().UnixNano(),
	}
}

func (c *Client) writeLoop() {
	pingTicker := time.NewTicker(3 * time.Second)
	defer pingTicker.Stop()
	defer c.conn.Close()

	for {
		select {
		case m, ok := <-c.msgCh:
			if !ok {
				return
			}
			switch v := m.(type) {
			case []byte:
				_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
				_ = c.conn.WriteMessage(websocket.BinaryMessage, v)
			default:
				_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
				_ = c.conn.WriteJSON(v)
			}
		case <-pingTicker.C:
			// Send ping with current timestamp
			now := time.Now().UnixNano()
			_ = c.conn.WriteControl(websocket.PingMessage, []byte(fmt.Sprintf("%d", now)), time.Now().Add(time.Second))

			// Send Application Level Ping (JSON) for clients that don't support Control Frames (e.g. some Web clients)
			_ = c.conn.SetWriteDeadline(time.Now().Add(time.Second))
			_ = c.conn.WriteJSON(struct {
				Method string `json:"method"`
				Params int64  `json:"params"`
			}{Method: "ping", Params: now})
		}
	}
}

func (c *Client) readLoop() {
	defer func() {
		if c.peer != nil {
			c.peer.close()
		}
		c.server.clients.Delete(c.id)
		c.server.latencySubs.Delete(c.id)
		close(c.msgCh)
		c.conn.Close()
	}()

	c.conn.SetPongHandler(func(appData string) error {
		atomic.StoreInt64(&c.lastPongTime, time.Now().UnixNano())
		if c.peer != nil {
			var sentTime int64
			fmt.Sscanf(appData, "%d", &sentTime)
			if sentTime > 0 {
				rtt := (time.Now().UnixNano() - sentTime) / 1e6 // ms
				atomic.StoreInt64(&c.peer.latency, rtt)
			}
		}
		return nil
	})

	for {
		mt, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}

		// In pure WebRTC mode, binary messages are not used for audio
		// All media is transmitted via WebRTC PeerConnection
		// We only accept JSON messages for signaling
		if mt == websocket.BinaryMessage {
			// Binary messages are not expected in pure WebRTC mode
			continue
		}

		var m rpcMessage
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}

		c.server.dispatchRPC(c, m)
	}
}
