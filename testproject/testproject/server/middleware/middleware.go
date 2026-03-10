// server/middleware/middleware.go — HTTP middleware chain
package middleware

import (
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

type Middleware func(http.Handler) http.Handler

// Chain composes multiple middlewares left-to-right.
func Chain(middlewares ...Middleware) Middleware {
	return func(next http.Handler) http.Handler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			next = middlewares[i](next)
		}
		return next
	}
}

// Logger logs method, path, status, and duration for every request.
func Logger() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rw := &responseWriter{ResponseWriter: w, status: 200}
			next.ServeHTTP(rw, r)
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, rw.status, time.Since(start))
		})
	}
}

// Recovery catches panics and returns 500.
func Recovery() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Printf("panic: %v\n%s", rec, debug.Stack())
					http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// CORSConfig holds CORS settings.
type CORSConfig struct {
	AllowedOrigins []string
	AllowedMethods []string
	AllowedHeaders []string
	MaxAge         int
}

// CORS adds CORS headers based on config.
func CORS(cfg CORSConfig) Middleware {
	allowedOrigins := make(map[string]struct{}, len(cfg.AllowedOrigins))
	for _, o := range cfg.AllowedOrigins {
		allowedOrigins[o] = struct{}{}
	}
	methods := strings.Join(cfg.AllowedMethods, ", ")
	headers := strings.Join(cfg.AllowedHeaders, ", ")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if _, ok := allowedOrigins[origin]; ok {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", methods)
				w.Header().Set("Access-Control-Allow-Headers", headers)
				w.Header().Set("Access-Control-Max-Age", fmt.Sprint(cfg.MaxAge))
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RateLimitConfig configures per-IP rate limiting.
type RateLimitConfig struct {
	Enabled            bool
	RequestsPerMinute  int
	Burst              int
}

// RateLimit implements a simple token-bucket rate limiter per client IP.
func RateLimit(cfg RateLimitConfig) Middleware {
	if !cfg.Enabled {
		return func(next http.Handler) http.Handler { return next }
	}

	type bucket struct {
		tokens float64
		lastAt time.Time
		mu     sync.Mutex
	}
	buckets := &sync.Map{}
	refillRate := float64(cfg.RequestsPerMinute) / 60.0

	getBucket := func(key string) *bucket {
		v, _ := buckets.LoadOrStore(key, &bucket{tokens: float64(cfg.Burst), lastAt: time.Now()})
		return v.(*bucket)
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			b := getBucket(ip)
			b.mu.Lock()
			now := time.Now()
			elapsed := now.Sub(b.lastAt).Seconds()
			b.tokens = min(float64(cfg.Burst), b.tokens+elapsed*refillRate)
			b.lastAt = now
			if b.tokens < 1 {
				b.mu.Unlock()
				http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
				return
			}
			b.tokens--
			b.mu.Unlock()
			next.ServeHTTP(w, r)
		})
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.Split(xff, ",")[0]
	}
	return r.RemoteAddr
}

func min(a, b float64) float64 {
	if a < b { return a }
	return b
}
