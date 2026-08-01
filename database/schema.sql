-- DeepFlowHunter PostgreSQL baseline schema
--
-- 仅用于全新空数据库；结构变更直接更新本基线并重建数据库。
-- 本文件不使用 psql 的 \i/\ir 元命令，可由 psql、云数据库 SQL 控制台或
-- 其他支持 PostgreSQL 多语句脚本的客户端执行。

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE schema_meta (
  id text PRIMARY KEY DEFAULT 'global',
  version int NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_meta_id_check CHECK (id = 'global')
);
INSERT INTO schema_meta (id, version) VALUES ('global', 2);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plane_project_id text UNIQUE,
  canvas_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  config_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT projects_status_check CHECK (status IN ('active', 'archived'))
);

CREATE TABLE canvases (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  project_id uuid NOT NULL REFERENCES projects(id),
  plane_issue_id text,
  title text NOT NULL,
  target_json jsonb NOT NULL DEFAULT '{}',
  trigger_source text,
  trigger_event_id text,
  trigger_payload_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX canvases_issue_uniq
  ON canvases (plane_issue_id) WHERE plane_issue_id IS NOT NULL;
CREATE UNIQUE INDEX canvases_trigger_uniq
  ON canvases (project_id, trigger_source, trigger_event_id)
  WHERE trigger_event_id IS NOT NULL;
CREATE INDEX canvases_project_idx ON canvases (project_id, created_at DESC);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  canvas_id text REFERENCES canvases(id),
  plane_issue_id text,
  parent_job_id uuid REFERENCES jobs(id),
  finding_id uuid,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  priority int NOT NULL DEFAULT 0,
  payload_json jsonb NOT NULL DEFAULT '{}',
  agent_snapshot_json jsonb NOT NULL,
  sandbox_id text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  claimed_at timestamptz,
  timeout_sec int NOT NULL DEFAULT 3600,
  followup_depth int NOT NULL DEFAULT 0,
  ingress_key text,
  transcript_uri text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_check CHECK (
    status IN (
      'pending', 'claimed', 'provisioning', 'running', 'waiting_human',
      'succeeded', 'failed', 'timeout', 'cancelled', 'orphan'
    )
  ),
  CONSTRAINT jobs_priority_check CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT jobs_timeout_check CHECK (timeout_sec > 0),
  CONSTRAINT jobs_followup_depth_check CHECK (followup_depth >= 0)
);
CREATE UNIQUE INDEX jobs_active_issue_uniq ON jobs (plane_issue_id)
  WHERE status IN ('claimed', 'provisioning', 'running');
CREATE UNIQUE INDEX jobs_ingress_key_uniq ON jobs (project_id, ingress_key)
  WHERE ingress_key IS NOT NULL;
CREATE INDEX jobs_list_idx ON jobs (project_id, status, created_at DESC);
CREATE INDEX jobs_pending_idx ON jobs (status, priority DESC, created_at)
  WHERE status = 'pending';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_canvas_idx ON jobs (canvas_id);

CREATE TABLE event_dedup (
  event_id text PRIMARY KEY,
  job_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  event_id text NOT NULL,
  job_seq int NOT NULL,
  type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_job_seq_uniq UNIQUE (job_id, job_seq),
  CONSTRAINT events_job_event_uniq UNIQUE (job_id, event_id)
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
  CONSTRAINT findings_project_id_fingerprint_key UNIQUE (project_id, fingerprint),
  CONSTRAINT findings_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT findings_verify_status_check CHECK (
    verify_status IN ('pending', 'verifying', 'confirmed', 'false_positive', 'needs_human')
  )
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
CREATE UNIQUE INDEX canvas_nodes_root_uniq
  ON canvas_nodes (canvas_id) WHERE node_type = 'root';

CREATE TABLE canvas_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id text NOT NULL,
  from_node_id uuid NOT NULL REFERENCES canvas_nodes(id),
  to_node_id uuid NOT NULL REFERENCES canvas_nodes(id),
  edge_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_edges_canvas_idx ON canvas_edges (canvas_id);

CREATE TABLE skill_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  repo_url text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  catalog_json jsonb NOT NULL DEFAULT '[]',
  trust_status text NOT NULL DEFAULT 'quarantined',
  enabled boolean NOT NULL DEFAULT false,
  last_commit_sha text,
  last_content_hash text,
  synced_by text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_sources_trust_check
    CHECK (trust_status IN ('quarantined', 'trusted', 'disabled'))
);

CREATE TABLE agent_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  builtin boolean NOT NULL DEFAULT false,
  kind text NOT NULL DEFAULT 'role',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE global_settings (
  id text PRIMARY KEY DEFAULT 'global',
  rules_json jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_settings_id_check CHECK (id = 'global')
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject_type text NOT NULL DEFAULT 'service_account',
  subject_id text,
  project_id uuid REFERENCES projects(id),
  token_prefix text NOT NULL UNIQUE,
  token_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  last_ip text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL,
  provider text NOT NULL,
  project_id uuid REFERENCES projects(id),
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  public_metadata_json jsonb NOT NULL DEFAULT '{}',
  fingerprint text NOT NULL,
  last4 text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_used_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT credentials_kind_check CHECK (kind IN ('llm_provider', 'plane', 'git')),
  CONSTRAINT credentials_status_check
    CHECK (status IN ('active', 'disabled', 'rotation_required'))
);

-- 角色运行配置（全局 project_id IS NULL + 项目级覆盖）
CREATE TABLE role_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  agent_cli text NOT NULL DEFAULT 'claude-code',
  model text,
  reasoning text,
  env_keys text[] NOT NULL DEFAULT '{}',
  env_vars_json jsonb NOT NULL DEFAULT '{}',
  modules_json jsonb NOT NULL DEFAULT '[]',
  skills_json jsonb NOT NULL DEFAULT '[]',
  commands_json jsonb NOT NULL DEFAULT '[]',
  mcps_json jsonb NOT NULL DEFAULT '[]',
  subagents_json jsonb NOT NULL DEFAULT '[]',
  instructions_markdown text,
  runtime_image_key text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_configs_reasoning_check
    CHECK (reasoning IS NULL OR reasoning IN ('low', 'medium', 'high', 'xhigh'))
);
CREATE UNIQUE INDEX role_configs_global_uniq
  ON role_configs (role_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX role_configs_project_uniq
  ON role_configs (project_id, role_id) WHERE project_id IS NOT NULL;

CREATE TABLE role_credentials (
  role_config_id uuid NOT NULL REFERENCES role_configs(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'llm',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_config_id, credential_id, purpose)
);

CREATE TABLE role_config_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_config_id uuid NOT NULL REFERENCES role_configs(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text NOT NULL,
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_config_id, path)
);

CREATE OR REPLACE FUNCTION dfh_notify_job_event() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'pending')
     OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
         AND NEW.status IN ('succeeded', 'failed', 'timeout', 'cancelled', 'orphan')) THEN
    PERFORM pg_notify('dfh_jobs', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_notify_event
  AFTER INSERT OR UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION dfh_notify_job_event();

INSERT INTO agent_roles (name, title, description, builtin, kind) VALUES
  ('explore', '探索', '围绕任务意图收集新的、可验证的事实与证据', true, 'role'),
  ('analyze', '分析', '关联已有事实，追踪数据流、评估影响并形成有证据的分析结论', true, 'role'),
  ('verify', '验证', '独立验证事实或 Finding，给出 confirmed、false_positive 或 needs_human 结论', true, 'role'),
  ('test', '测试', '按需搭建最小环境、设计测试或 PoC，记录复现条件与结果', true, 'role'),
  ('code', '代码', '在任务明确要求时修改代码，并提供变更与验证证据', true, 'role'),
  ('audit', '审计', '根据任务目标自行确定材料获取方式和审计范围，产出结构化 Finding', true, 'role'),
  ('hub_reason', '决策中枢', '读取任务画布并判断完成度；未完成时选择角色并编写完整 Worker prompt', true, 'hub'),
  ('noop', '空转', '只用于验证调度状态机，不启动真实 Agent', true, 'system')
ON CONFLICT (name) DO NOTHING;

INSERT INTO global_settings (id) VALUES ('global') ON CONFLICT DO NOTHING;

COMMIT;
