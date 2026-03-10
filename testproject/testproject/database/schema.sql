-- database/schema.sql — Application schema
-- PostgreSQL 15+

BEGIN;

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── Jobs table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type        VARCHAR(64)  NOT NULL,
    status      VARCHAR(32)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','completed','failed','cancelled')),
    priority    SMALLINT     NOT NULL DEFAULT 0,
    payload     JSONB        NOT NULL DEFAULT '{}',
    result      JSONB,
    error_msg   TEXT,
    retry_count SMALLINT     NOT NULL DEFAULT 0,
    max_retries SMALLINT     NOT NULL DEFAULT 3,
    worker_id   VARCHAR(64),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status_priority
    ON jobs (status, priority DESC, scheduled_at ASC)
    WHERE status = 'pending';

CREATE INDEX idx_jobs_type_status ON jobs (type, status);
CREATE INDEX idx_jobs_created_at  ON jobs (created_at DESC);
CREATE INDEX idx_jobs_payload_gin ON jobs USING GIN (payload jsonb_path_ops);

-- ── Workers table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workers (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    hostname     VARCHAR(255) NOT NULL,
    concurrency  SMALLINT     NOT NULL DEFAULT 1,
    status       VARCHAR(16)  NOT NULL DEFAULT 'idle'
                     CHECK (status IN ('idle','busy','offline')),
    last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Metrics snapshots ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metrics_snapshots (
    id           BIGSERIAL    PRIMARY KEY,
    worker_id    UUID         REFERENCES workers(id) ON DELETE CASCADE,
    snapshot     JSONB        NOT NULL,
    captured_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_metrics_worker_time ON metrics_snapshots (worker_id, captured_at DESC);

-- ── Trigger: auto-update updated_at ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Views ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW job_stats AS
SELECT
    type,
    status,
    COUNT(*) AS count,
    AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL) AS avg_duration_ms,
    MAX(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) FILTER (WHERE finished_at IS NOT NULL) AS max_duration_ms,
    MIN(created_at) AS oldest_created,
    MAX(created_at) AS newest_created
FROM jobs
GROUP BY type, status;

COMMIT;
