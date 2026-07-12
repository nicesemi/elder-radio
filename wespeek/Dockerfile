# Stage 1: Build Flutter Web (optional - can be disabled if Flutter is not available)
FROM ghcr.io/cirruslabs/flutter:stable AS flutter-builder

# Configure Flutter mirrors for faster downloads
ENV FLUTTER_STORAGE_BASE_URL="https://storage.flutter-io.cn" \
    PUB_HOSTED_URL="https://pub.flutter-io.cn"

WORKDIR /app

# Copy pubspec and local packages first to cache dependencies
COPY flutter_client/pubspec.* ./
COPY flutter_client/packages/ ./packages/ 2>/dev/null || true

RUN flutter pub get || echo "Flutter pub get failed, continuing..."

# Copy the rest of the application
COPY flutter_client/ .

# Build web assets (will fail gracefully if Flutter is not available)
RUN flutter build web --release --base-href / 2>/dev/null && \
    mkdir -p /tmp/flutter-web-exists && \
    cp -r /app/build/web/* /tmp/flutter-web-exists/ || \
    echo "Flutter web build skipped"

# Stage 2: Build Go Server
FROM golang:alpine AS go-builder

WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./

# Set Go module download proxy
ENV GOPROXY="https://goproxy.io,direct"

# Download dependencies
RUN go mod download

# Copy source code
COPY internal/ internal/
COPY main.go .
COPY config.yaml .

# Copy Flutter web build if exists, otherwise create empty web directory
COPY flutter_client/build/web ./web

# If no web files were copied, ensure web directory exists
RUN ls -la ./web 2>/dev/null || mkdir -p web

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o wespeek main.go

# Stage 3: Final Image
FROM alpine:3.20 AS final

WORKDIR /app

# Copy binary from go-builder
COPY --from=go-builder /app/wespeek .

# Copy web directory structure
COPY --from=go-builder /app/web ./web

# Copy default config.yaml
COPY --from=go-builder /app/config.yaml .

# Expose ports
# 7000: HTTP/WebSocket API
# 3478: TURN (UDP/TCP)
EXPOSE 7000 3478

# Set environment variables
ENV WSPEEK_ADDR=:7000 \
    WSPEEK_STORE_IMAGES=true \
    WSPEEK_ALLOW_UPLOAD=true \
    WSPEEK_UPLOAD_DIR=/data/uploads \
    TZ=Asia/Shanghai

# No health check - minimal alpine image has no utilities
# Use 'docker logs wespeek' to check server status

# Run the application
ENTRYPOINT ["./wespeek", "-db", "/data/wespeek.db"]
