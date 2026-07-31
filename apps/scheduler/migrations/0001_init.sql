-- 0001_init.sql — DeepFlowHunter MVP schema（ARCHITECTURE §6 / §6.2 / §6.3）
-- 演进纪律见 §17：类型字段一律 text；易变内容一律 jsonb；只加不删走 expand-migrate-contract

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE _migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plane_project_id text NOT NULL UNIQUE,
  canvas_id text NOT NULL,
  name text NOT NULL,
  config_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  plane_issue_id text,
  parent_job_id uuid REFERENCES jobs(id),
  finding_id uuid,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  priority int NOT NULL DEFAULT 0,
  payload_json jsonb NOT NULL DEFAULT '{}',
  sandbox_id text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  timeout_sec int NOT NULL DEFAULT 3600,
  followup_depth int NOT NULL DEFAULT 0,
  transcript_uri text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 防双跑：同一 Plane issue 只允许一个活动 job
CREATE UNIQUE INDEX jobs_active_issue_uniq ON jobs (plane_issue_id)
  WHERE status IN ('claimed','provisioning','running');
CREATE INDEX jobs_list_idx ON jobs (project_id, status, created_at DESC);
CREATE INDEX jobs_pending_idx ON jobs (status, priority DESC, created_at) WHERE status = 'pending';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';

-- 事件幂等：先撞此表，撞不上才是新事件（§6）
CREATE TABLE event_dedup (
  event_id text PRIMARY KEY,
  job_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

-- 语义事件表（原始流不进此表，见 §6.2 热冷分层）
-- id = 全局序，job_seq = 每 job 局部序（不信 created_at，§6 乱序对策）
CREATE TABLE events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  event_id text NOT NULL,
  job_seq int NOT NULL,
  type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_job_idx ON events (job_id, id);

CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  node_id uuid,
  fingerprint text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL,
  location text,
  summary text,
  suggest_verify boolean NOT NULL DEFAULT false,
  verify_status text NOT NULL DEFAULT 'pending',
  raw_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX findings_filter_idx ON findings (project_id, severity, verify_status);
CREATE INDEX findings_title_trgm ON findings USING gin (title gin_trgm_ops);
CREATE INDEX findings_location_trgm ON findings USING gin (location gin_trgm_ops);
CREATE INDEX findings_summary_trgm ON findings USING gin (summary gin_trgm_ops);

CREATE TABLE canvas_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id text NOT NULL,
  job_id uuid REFERENCES jobs(id),
  node_type text NOT NULL,
  title text NOT NULL,
  body_json jsonb NOT NULL DEFAULT '{}',
  x real NOT NULL DEFAULT 0,
  y real NOT NULL DEFAULT 0,
  w real NOT NULL DEFAULT 240,
  h real NOT NULL DEFAULT 120,
  status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_nodes_canvas_idx ON canvas_nodes (canvas_id);

CREATE TABLE canvas_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id text NOT NULL,
  from_node_id uuid NOT NULL REFERENCES canvas_nodes(id),
  to_node_id uuid NOT NULL REFERENCES canvas_nodes(id),
  edge_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_edges_canvas_idx ON canvas_edges (canvas_id);
