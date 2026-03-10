// store/store.go — Database access layer
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("record not found")

// IsNotFound checks whether an error is a not-found sentinel.
func IsNotFound(err error) bool {
	return errors.Is(err, ErrNotFound)
}

type ListParams struct {
	Limit  int
	Offset int
	Status string
}

type Job struct {
	ID          string
	Type        string
	Status      string
	Priority    int
	Payload     map[string]any
	Result      map[string]any
	ErrorMsg    string
	RetryCount  int
	CreatedAt   time.Time
	UpdatedAt   time.Time
	StartedAt   *time.Time
	FinishedAt  *time.Time
}

// DB wraps a pgx connection pool.
type DB struct {
	pool *pgxpool.Pool
}

type DBConfig struct {
	Host     string
	Port     int
	Name     string
	User     string
	Password string
	MaxConns int32
}

// Connect opens a pgx pool and verifies the connection.
func Connect(cfg DBConfig) (*DB, error) {
	dsn := fmt.Sprintf(
		"host=%s port=%d dbname=%s user=%s password=%s pool_max_conns=%d sslmode=disable",
		cfg.Host, cfg.Port, cfg.Name, cfg.User, cfg.Password, cfg.MaxConns,
	)
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("db ping: %w", err)
	}
	return &DB{pool: pool}, nil
}

func (db *DB) Close() { db.pool.Close() }

func (db *DB) Ping(ctx context.Context) bool {
	return db.pool.Ping(ctx) == nil
}

// ListJobs fetches jobs with optional status filter.
func (db *DB) ListJobs(ctx context.Context, p ListParams) ([]Job, error) {
	query := `
		SELECT id, type, status, priority, payload, retry_count, created_at, updated_at
		FROM jobs
		WHERE ($1 = '' OR status = $1)
		ORDER BY priority DESC, created_at DESC
		LIMIT $2 OFFSET $3`

	rows, err := db.pool.Query(ctx, query, p.Status, p.Limit, p.Offset)
	if err != nil {
		return nil, fmt.Errorf("ListJobs query: %w", err)
	}
	defer rows.Close()

	var jobs []Job
	for rows.Next() {
		var j Job
		if err := rows.Scan(&j.ID, &j.Type, &j.Status, &j.Priority, &j.Payload, &j.RetryCount, &j.CreatedAt, &j.UpdatedAt); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

// GetJob fetches a single job by ID.
func (db *DB) GetJob(ctx context.Context, id string) (Job, error) {
	var j Job
	row := db.pool.QueryRow(ctx, `
		SELECT id, type, status, priority, payload, result, error_msg, retry_count, created_at, updated_at, started_at, finished_at
		FROM jobs WHERE id = $1`, id)
	err := row.Scan(&j.ID, &j.Type, &j.Status, &j.Priority, &j.Payload, &j.Result, &j.ErrorMsg, &j.RetryCount, &j.CreatedAt, &j.UpdatedAt, &j.StartedAt, &j.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, fmt.Errorf("GetJob: %w", err)
	}
	return j, nil
}

// CreateJob inserts a new job and returns the full record.
func (db *DB) CreateJob(ctx context.Context, payload map[string]any) (Job, error) {
	jobType, _ := payload["type"].(string)
	if jobType == "" {
		jobType = "default"
	}
	var j Job
	err := db.pool.QueryRow(ctx, `
		INSERT INTO jobs (type, payload) VALUES ($1, $2)
		RETURNING id, type, status, payload, created_at`, jobType, payload).
		Scan(&j.ID, &j.Type, &j.Status, &j.Payload, &j.CreatedAt)
	if err != nil {
		return Job{}, fmt.Errorf("CreateJob: %w", err)
	}
	return j, nil
}

// UpdateJobStatus transitions a job's status and records timing.
func (db *DB) UpdateJobStatus(ctx context.Context, id, status string, result map[string]any, errMsg string) error {
	_, err := db.pool.Exec(ctx, `
		UPDATE jobs SET status=$2, result=$3, error_msg=$4,
		  finished_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN NOW() ELSE finished_at END,
		  started_at  = CASE WHEN $2 = 'running' THEN NOW() ELSE started_at END
		WHERE id=$1`, id, status, result, errMsg)
	return err
}

// SaveResult stores the outcome of a processed job.
func (db *DB) SaveResult(ctx context.Context, jobID string, success bool, output map[string]any, errMsg string) error {
	status := "completed"
	if !success {
		status = "failed"
	}
	return db.UpdateJobStatus(ctx, jobID, status, output, errMsg)
}
