# WeSpeek

[English](README.en.md) | [中文](README.md)

A high-concurrency voice chat application written in Go, including the server and a Web client.

## Features

- Real-time voice: low-latency audio via WebSocket/WebRTC, multiple users per room
- Channels and groups: create multiple rooms and group them for better management
- Live network metrics:
  - RTT (round-trip latency) per client
  - Uplink/downlink traffic stats (packets, bytes)
  - Packet loss monitoring
  - Admin can view user IPs
- Access control: HMAC-based admin system with Web UI to generate and manage secrets
- Persistence: SQLite for room configuration, chat history, and admin secrets
- Docker deployment: one-command setup with [docker-compose](deploy/docker-compose.yml)

## Architecture

- DDD layers:
  - `internal/domain`: domain entities and repository interfaces
  - `internal/service`: domain services (rooms, chat, admin)
  - `internal/store`: infrastructure implementations (SQLite)
  - `internal/server`: application/WS layer: sessions, rooms, broadcast, handlers
- Concurrency and channels:
  - Client write queue `chan interface{}` with non-blocking try-send to avoid broadcast stalls
  - Audio path uses a dedicated `chan []byte` with write deadlines to prevent blocking I/O
- In-memory state:
  - `sync.Map` for rooms, clients, latency subscribers
  - `RWMutex` for room member access
- Static assets:
  - Served from the `web/` directory by default

## Deploy the Server

### Using Docker Compose (recommended)

1. Install Docker and Docker Compose
2. Run in the project deploy directory:

```bash
docker-compose up -d
```

3. The server listens on port `7000`

### First run and admin setup

On first run the application prints a one-time admin setup link.

Generate a new admin secret:

Docker:

```bash
docker-compose run --rm wespeek -gen-admin
```

Local:

```bash
go run main.go -gen-admin
```

You will see:

```
Admin Setup Link: /?setup_admin=xxxxxxxxxxxxxxxx
```

Open `http://localhost:7000/?setup_admin=xxxxxxxxxxxxxxxx`
Replace `localhost` with your server host.
For non-localhost deployments with audio, HTTPS is required; configure Nginx reverse proxy as needed ([deploy/nginx.conf](deploy/nginx.conf)).

## Run the Client

### Web client
Open the server URL (default `http://localhost:7000`).
Right-click a user in the Web client to view detailed connection stats (latency, traffic, packet loss).

## Configuration

- Data is stored in `./data` (Docker) or the current directory (local)
- Environment variables:
  - `WSPEEK_ADDR`: server listen address (default `:7000`)

## Local Run

```bash
go run main.go
```

Override listen address via environment:

```bash
WSPEEK_ADDR=0.0.0.0:7000 go run main.go
```

## Directory Overview

- `internal/domain`: domain models and repository interfaces
- `internal/service`: domain service implementations
- `internal/store`: SQLite storage implementation
- `internal/server`: rooms, sessions, broadcast, WS handlers
- `internal/api`: HTTP/WS API entry points
- `web`: static front-end assets
- `deploy`: Docker and Nginx configurations
