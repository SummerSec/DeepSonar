-- DeepSonar schema migration 0017
--
-- Persistent fixed-window semantic-event counters.  One row per Job is kept
-- and locked by the ingestion transaction; the current window is reset in
-- place, so rate checks never scan the append-only events table.
-- The runner owns the transaction; do not add BEGIN/COMMIT here.

CREATE TABLE job_event_rate_limits (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  progress_count int NOT NULL DEFAULT 0,
  standard_count int NOT NULL DEFAULT 0,
  terminal_count int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_event_rate_limits_counts_check CHECK (
    progress_count >= 0 AND standard_count >= 0 AND terminal_count >= 0
  )
);
