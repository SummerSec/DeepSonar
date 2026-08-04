-- DeepSonar schema migration 0013
--
-- The Scheduler records every migration attempt in schema_migrations.  The
-- runner creates the table before entering the migration transaction so a
-- failed migration can still leave an auditable row after PostgreSQL rolls
-- the DDL back.  IF NOT EXISTS keeps the operation safe when the runner has
-- already prepared the ledger for that purpose.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id bigserial PRIMARY KEY,
  version int NOT NULL,
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL,
  error text,
  CONSTRAINT schema_migrations_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schema_migrations_result_check CHECK (result IN ('succeeded', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS schema_migrations_applied_version_uniq
  ON schema_migrations (version) WHERE result = 'succeeded';
CREATE INDEX IF NOT EXISTS schema_migrations_version_idx
  ON schema_migrations (version, applied_at DESC);
