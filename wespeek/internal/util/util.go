package util

import (
	"crypto/rand"
	"math/big"
	"net"
	"os"
)

func EnvOr(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func RandString() string {
	return RandStringLen(10)
}

func RandStringLen(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		num, err := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		if err != nil {
			// Fallback to simple modulo if crypto/rand fails (unlikely)
			// But better to just use 0 or handle it.
			// Given this is a simple app, we'll just use the first char if error
			out[i] = letters[0]
			continue
		}
		out[i] = letters[num.Int64()]
	}
	return string(out)
}

// IsTrustedIP checks if the remote address is a trusted proxy (Loopback or Private IP).
func IsTrustedIP(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr // Fallback if no port
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}

	// Trusted if loopback or private
	return ip.IsLoopback() || ip.IsPrivate()
}
