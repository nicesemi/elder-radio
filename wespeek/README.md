# WeSpeek

[English](README.en.md) | [中文](README.md)

此项目是一个基于 Golang 的高并发语音聊天室项目，包含服务端、Web 客户端以及跨平台桌面客户端。

## 特性

*   **实时语音**: 基于 WebSocket/WebRTC 的低延迟语音通话，支持多人同时在线。
*   **多频道与分组**: 支持创建多个房间，并支持房间分组显示，方便管理。
*   **实时网络监控**: 
    *   支持查看客户端到服务器的往返延迟 (RTT)。
    *   实时显示上行/下行流量统计（包数量、字节数）。
    *   支持丢包率监测，帮助排查网络质量问题。
    *   管理员可查看用户 IP 地址。
*   **权限管理**: 基于 HMAC 的安全管理员权限系统，支持 Web 端生成和管理密钥。
*   **持久化存储**: 使用 SQLite 存储房间配置、聊天记录和管理员密钥。
*   **Docker 部署**: 提供 [docker-compose 配置文件](deploy/docker-compose.yml)，一键部署。

## 架构与设计

- **DDD 分层**:
  - `internal/domain`: 领域实体与仓库接口（entity、repository）。
  - `internal/service`: 领域服务（房间、聊天、管理员）。
  - `internal/store`: 基础设施层（SQLite 实现）。
  - `internal/server`: 应用层与会话管理、房间逻辑、广播与 WS 处理。
- **并发与通道**:
  - 使用 `chan interface{}` 作为客户端写队列（非阻塞 try-send），提升广播在慢客户端场景下的鲁棒性。
  - 音频链路使用独立的发送队列 `chan []byte`，并设置写超时保证 IO 不阻塞。
- **状态存储**:
  - 进程内使用 `sync.Map` 管理 rooms、clients、latencySubs 等。
  - 房间成员读写使用 `RWMutex` 控制并发。
- **静态资源**:
  - 默认通过 `web/` 目录提供前端静态资源。

## 部署服务端

### 使用 Docker Compose (推荐)

1.  确保已安装 Docker 和 Docker Compose。
2.  在项目deploy目录下运行：

    ```bash
    docker-compose up -d
    ```

3.  服务将在端口 `7000` 启动。

### 首次运行与管理员设置

首次运行时，程序会自动生成新的管理员设置链接，可以查看日志获取。

需要生成新的管理员密钥时，可以使用以下命令：

**Docker 环境:**

```bash
docker-compose run --rm wespeek -gen-admin
```

**本地直接运行:**

```bash
go run main.go -gen-admin
```

系统将输出一个设置链接，格式如下：

```
Admin Setup Link: /?setup_admin=xxxxxxxxxxxxxxxx
```

访问 `http://localhost:7000/?setup_admin=xxxxxxxxxxxxxxxx` (将 localhost 替换为您的服务器地址；非 localhost 地址时若需使用语音功能，需要 HTTPS，请自行配置 Nginx 反代[参考](deploy/nginx.conf)) 即可激活管理员权限。

## 运行客户端

### Web 客户端
直接访问服务端地址即可（默认 `http://localhost:7000`）。
在 Web 端右键点击用户列表中的用户，可以查看详细的连接信息（延迟、流量、丢包率等）。

## 配置

默认情况下，数据存储在 `./data` 目录（Docker）或当前目录（本地）。

可以通过环境变量配置监听地址：
*   `WSPEEK_ADDR`: 服务监听地址 (默认 `:7000`)

## 本地运行

```bash
go run main.go
```

默认监听 `:7000`，可通过 `WSPEEK_ADDR` 环境变量覆盖，例如：

```bash
WSPEEK_ADDR=0.0.0.0:7000 go run main.go
```

## 目录结构速览

- `internal/domain`: 领域模型与仓库接口
- `internal/service`: 领域服务实现
- `internal/store`: 存储实现
- `internal/server`: 房间、会话、广播、WS 处理
- `internal/api`: HTTP/WS API 入口
- `web`: 前端静态资源
- `deploy`: 部署配置示例
