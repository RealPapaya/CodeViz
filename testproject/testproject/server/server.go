// server/server.go — HTTP server implementation
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/testproject/config"
	"github.com/testproject/middleware"
	"github.com/testproject/store"
	"github.com/testproject/worker"
)

const (
	defaultReadTimeout  = 10 * time.Second
	defaultWriteTimeout = 30 * time.Second
	defaultIdleTimeout  = 120 * time.Second
	maxRequestBodyBytes = 4 << 20 // 4 MB
)

// Server wraps the HTTP server and its dependencies.
type Server struct {
	cfg    *config.Config
	db     *store.DB
	pool   *worker.Pool
	mux    *http.ServeMux
	httpSrv *http.Server
	port   int
}

// New creates a new Server instance.
func New(cfg *config.Config, db *store.DB, pool *worker.Pool) *Server {
	s := &Server{
		cfg:  cfg,
		db:   db,
		pool: pool,
		mux:  http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

func (s *Server) SetPort(port int) {
	s.port = port
}

func (s *Server) registerRoutes() {
	chain := middleware.Chain(
		middleware.Logger(),
		middleware.Recovery(),
		middleware.CORS(s.cfg.CORS),
		middleware.RateLimit(s.cfg.RateLimit),
	)

	s.mux.Handle("/api/v1/jobs", chain(http.HandlerFunc(s.handleJobs)))
	s.mux.Handle("/api/v1/jobs/", chain(http.HandlerFunc(s.handleJobByID)))
	s.mux.Handle("/api/v1/workers", chain(http.HandlerFunc(s.handleWorkerStatus)))
	s.mux.Handle("/health", http.HandlerFunc(s.handleHealth))
	s.mux.Handle("/ready", http.HandlerFunc(s.handleReady))
	s.mux.Handle("/metrics", http.HandlerFunc(s.handleMetrics))
}

func (s *Server) ListenAndServe() error {
	s.httpSrv = &http.Server{
		Addr:         fmt.Sprintf(":%d", s.port),
		Handler:      s.mux,
		ReadTimeout:  defaultReadTimeout,
		WriteTimeout: defaultWriteTimeout,
		IdleTimeout:  defaultIdleTimeout,
	}
	return s.httpSrv.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.httpSrv == nil {
		return nil
	}
	return s.httpSrv.Shutdown(ctx)
}

// ── Handlers ─────────────────────────────────────────────────────────────────

func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listJobs(w, r)
	case http.MethodPost:
		s.createJob(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.db.ListJobs(r.Context(), parseListParams(r))
	if err != nil {
		log.Printf("listJobs error: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to list jobs")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs, "count": len(jobs)})
}

func (s *Server) createJob(w http.ResponseWriter, r *http.Request) {
	body := io.LimitReader(r.Body, maxRequestBodyBytes)
	var payload map[string]any
	if err := json.NewDecoder(body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	job, err := s.db.CreateJob(r.Context(), payload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create job")
		return
	}
	s.pool.Submit(job)
	writeJSON(w, http.StatusCreated, map[string]any{"job": job})
}

func (s *Server) handleJobByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/jobs/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing job ID")
		return
	}
	job, err := s.db.GetJob(r.Context(), id)
	if err != nil {
		if store.IsNotFound(err) {
			writeError(w, http.StatusNotFound, "job not found")
		} else {
			writeError(w, http.StatusInternalServerError, "db error")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": job})
}

func (s *Server) handleWorkerStatus(w http.ResponseWriter, r *http.Request) {
	stats := s.pool.Stats()
	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if !s.db.Ping(r.Context()) {
		writeError(w, http.StatusServiceUnavailable, "database not ready")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	m := s.pool.Metrics()
	writeJSON(w, http.StatusOK, m)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON encode error: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func parseListParams(r *http.Request) store.ListParams {
	q := r.URL.Query()
	return store.ListParams{
		Limit:  parseIntParam(q.Get("limit"), 20),
		Offset: parseIntParam(q.Get("offset"), 0),
		Status: q.Get("status"),
	}
}

func parseIntParam(s string, def int) int {
	if s == "" {
		return def
	}
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return def
	}
	return n
}
