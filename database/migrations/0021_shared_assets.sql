-- DeepSonar schema migration 0021
--
-- Shared assets keep immutable metadata and content-addressed blob references
-- in PostgreSQL. File bytes remain under BLOB_DIR/shared-assets.

CREATE TABLE shared_asset_blobs (
  content_sha256 text PRIMARY KEY,
  bytes bigint NOT NULL,
  content_type text NOT NULL,
  blob_uri text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shared_asset_blobs_sha_check CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shared_asset_blobs_bytes_check CHECK (bytes >= 0)
);

CREATE TABLE shared_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES findings(id) ON DELETE CASCADE,
  logical_key text NOT NULL,
  origin text NOT NULL,
  immutable boolean NOT NULL DEFAULT true,
  labels_json jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_by_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  current_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT shared_assets_scope_check CHECK (scope_type IN ('platform','project','finding')),
  CONSTRAINT shared_assets_origin_check CHECK (origin IN ('human','agent','system')),
  CONSTRAINT shared_assets_status_check CHECK (status IN ('active','archived','quarantined')),
  CONSTRAINT shared_assets_key_check CHECK (
    char_length(logical_key) BETWEEN 1 AND 240
    AND logical_key !~ '(^/|\\\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|[[:cntrl:]])'
  ),
  CONSTRAINT shared_assets_scope_owner_check CHECK (
    (scope_type = 'platform' AND project_id IS NULL AND finding_id IS NULL)
    OR (scope_type = 'project' AND project_id IS NOT NULL AND finding_id IS NULL)
    OR (scope_type = 'finding' AND project_id IS NOT NULL AND finding_id IS NOT NULL)
  ),
  CONSTRAINT shared_assets_version_check CHECK (current_version >= 1)
);
CREATE UNIQUE INDEX shared_assets_active_platform_key_uniq
  ON shared_assets (logical_key) WHERE scope_type = 'platform' AND status = 'active';
CREATE UNIQUE INDEX shared_assets_active_project_key_uniq
  ON shared_assets (project_id, logical_key) WHERE scope_type = 'project' AND status = 'active';
CREATE UNIQUE INDEX shared_assets_active_finding_key_uniq
  ON shared_assets (finding_id, logical_key) WHERE scope_type = 'finding' AND status = 'active';
CREATE INDEX shared_assets_project_idx ON shared_assets (project_id, status, created_at DESC);
CREATE INDEX shared_assets_finding_idx ON shared_assets (finding_id, status, created_at DESC);

CREATE FUNCTION shared_asset_finding_project_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope_type = 'finding' AND NOT EXISTS (
    SELECT 1 FROM findings f WHERE f.id = NEW.finding_id AND f.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'finding shared asset must belong to the same project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shared_asset_finding_project_guard_trigger
  BEFORE INSERT OR UPDATE OF scope_type, project_id, finding_id ON shared_assets
  FOR EACH ROW EXECUTE FUNCTION shared_asset_finding_project_guard();

CREATE TABLE shared_asset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Removing a project/Finding removes its logical asset history. CAS blobs
  -- remain independently retained because their FK below is still RESTRICT.
  asset_id uuid NOT NULL REFERENCES shared_assets(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content_sha256 text NOT NULL REFERENCES shared_asset_blobs(content_sha256) ON DELETE RESTRICT,
  bytes bigint NOT NULL,
  content_type text NOT NULL,
  origin text NOT NULL,
  created_by text,
  created_by_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shared_asset_versions_version_check CHECK (version >= 1),
  CONSTRAINT shared_asset_versions_bytes_check CHECK (bytes >= 0),
  CONSTRAINT shared_asset_versions_origin_check CHECK (origin IN ('human','agent','system')),
  UNIQUE (asset_id, version),
  UNIQUE (asset_id, content_sha256)
);
CREATE INDEX shared_asset_versions_blob_idx ON shared_asset_versions (content_sha256);

-- Agent writes are accepted only while the publishing execution still owns a
-- live lease. The row lock makes this check linearize with terminal/cancel
-- transitions, so a late sandbox callback cannot publish after termination.
CREATE FUNCTION shared_asset_agent_publish_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  job_status text;
  job_lease_expires_at timestamptz;
  job_sandbox_id text;
BEGIN
  IF NEW.origin = 'agent' THEN
    SELECT j.status, j.lease_expires_at, j.sandbox_id
      INTO job_status, job_lease_expires_at, job_sandbox_id
      FROM jobs j
     WHERE j.id = NEW.created_by_job_id
     FOR UPDATE;
    IF NOT FOUND
       OR job_status <> 'running'
       OR job_lease_expires_at IS NULL
       OR job_lease_expires_at <= clock_timestamp()
       OR job_sandbox_id IS NULL THEN
      RAISE EXCEPTION 'shared_asset_publish_job_not_running' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shared_asset_agent_publish_guard_trigger
  BEFORE INSERT ON shared_asset_versions
  FOR EACH ROW EXECUTE FUNCTION shared_asset_agent_publish_guard();

CREATE TABLE shared_asset_project_policies (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  platform_enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shared_asset_project_policies_revision_check CHECK (revision >= 1)
);

CREATE TABLE job_shared_asset_versions (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- Job snapshots disappear with their asset version; the immutable CAS blob
  -- is intentionally retained for content-addressed garbage collection.
  version_id uuid NOT NULL REFERENCES shared_asset_versions(id) ON DELETE CASCADE,
  mount_path text NOT NULL,
  content_sha256 text NOT NULL,
  PRIMARY KEY (job_id, version_id),
  CONSTRAINT job_shared_asset_versions_sha_check CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT job_shared_asset_versions_path_check CHECK (
    mount_path LIKE '/workspace/.deepsonar/shared/%'
    AND mount_path !~ '(^|/)\.\.(/|$)'
  )
);
CREATE INDEX job_shared_asset_versions_version_idx ON job_shared_asset_versions (version_id);
