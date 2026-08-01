-- DeepFlowHunter PostgreSQL baseline schema
--
-- 仅用于全新空数据库：直接建立 0013_skill_trust.sql 之后的最终结构。
-- 已有数据库必须继续由 apps/scheduler/migrations 增量升级。
-- 本文件不使用 psql 的 \i/\ir 元命令，可由 psql、云数据库 SQL 控制台或
-- 其他支持 PostgreSQL 多语句脚本的客户端执行。

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE _migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

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
  agent_snapshot_json jsonb,
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

CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  agent_cli text NOT NULL DEFAULT 'claude-code',
  model text,
  /** agentbox reasoning effort：low|medium|high|xhigh；NULL = provider 默认 */
  reasoning text,
  env_keys text[] NOT NULL DEFAULT '{}',
  skills_json jsonb NOT NULL DEFAULT '[]',
  commands_json jsonb NOT NULL DEFAULT '[]',
  mcps_json jsonb NOT NULL DEFAULT '[]',
  subagents_json jsonb NOT NULL DEFAULT '[]',
  modules_json jsonb NOT NULL DEFAULT '[]',
  prompt_suffix text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_profiles_reasoning_check
    CHECK (reasoning IS NULL OR reasoning IN ('low', 'medium', 'high', 'xhigh'))
);

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
  prompt_template text NOT NULL,
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

CREATE TABLE profile_credentials (
  profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'llm',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, credential_id, purpose)
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
  prompt_suffix text,
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

INSERT INTO agent_roles (name, title, description, prompt_template, builtin, kind) VALUES
(
  'explore', '探索',
  '通读 /workspace/src 代码，围绕意图收集新事实（疑似漏洞线索、关键数据流、危险调用点）',
  $prompt$你是探索 agent。代码在 /workspace/src。

当前意图：{{intent}}

画布已有内容（YAML，不要重复其中的事实）：
{{graph}}

要求：
1. 围绕意图阅读代码，收集与意图直接相关的新事实（疑似漏洞线索、关键数据流、危险调用点等）
2. 写 /workspace/fact.json：{"title":"事实标题（20 字内）","description":"事实描述（中文，300 字内，含具体文件:行号）"}
   - 只写增量事实，不要复述画布已有内容；事实要具体、可被后续验证
   - 必须是纯 JSON，不要用 markdown 代码围栏包裹
3. 完成后写 /workspace/done.json：{"summary":"探索过程总结（中文，100 字内）"}
4. 不要修改源代码$prompt$,
  true, 'role'
),
(
  'analyze', '分析',
  '对图中已有事实做归因与关联分析：数据流追踪、影响面评估、漏洞链推导，产出分析结论',
  $prompt$你是分析 agent。代码在 /workspace/src。

当前意图：{{intent}}

画布已有内容（YAML）：
{{graph}}

要求：
1. 针对意图做深入分析：追踪数据流（source → sink）、评估影响面、推导可能的漏洞链
2. 分析必须基于代码证据，给出具体文件:行号；不要复述画布已有事实
3. 写 /workspace/fact.json：{"title":"分析结论标题（20 字内）","description":"分析结论（中文，300 字内，含证据位置与推理链）"}
   - 必须是纯 JSON，不要用 markdown 代码围栏包裹
4. 完成后写 /workspace/done.json：{"summary":"分析过程总结（中文，100 字内）"}
5. 不要修改源代码$prompt$,
  true, 'role'
),
(
  'verify', '验证',
  '静态复核图中疑似漏洞事实是否真实成立、是否可利用，产出带证据的验证结论',
  $prompt$你是验证 agent。代码在 /workspace/src。

当前意图：{{intent}}

画布已有内容（YAML）：
{{graph}}

要求：
1. 静态复核意图指向的疑似漏洞：确认输入可控性、过滤/转义是否存在、利用路径是否可达
2. 结论必须明确：成立（含利用条件）/ 不成立（含原因）/ 无法确定（缺什么证据）
3. 写 /workspace/fact.json：{"title":"验证结论标题（20 字内）","description":"验证结论（中文，300 字内，明确成立/不成立/无法确定 + 证据文件:行号）"}
   - 必须是纯 JSON，不要用 markdown 代码围栏包裹
4. 完成后写 /workspace/done.json：{"summary":"验证过程总结（中文，100 字内）"}
5. 不要修改源代码$prompt$,
  true, 'role'
),
(
  'test', '测试',
  '在沙箱内编写并运行最小 PoC / 测试脚本，动态验证猜想，产出测试结果',
  $prompt$你是测试 agent。代码在 /workspace/src。

当前意图：{{intent}}

画布已有内容（YAML）：
{{graph}}

要求：
1. 围绕意图编写最小测试 / PoC 脚本（放 /workspace/poc/ 下），在沙箱内运行验证猜想
2. 只针对沙箱内代码与本地服务，不访问外网，不做破坏性操作
3. 写 /workspace/fact.json：{"title":"测试结果标题（20 字内）","description":"测试结果（中文，300 字内：跑了什么、输出是什么、证实/证伪了什么）"}
   - 必须是纯 JSON，不要用 markdown 代码围栏包裹
4. 完成后写 /workspace/done.json：{"summary":"测试过程总结（中文，100 字内）"}$prompt$,
  true, 'role'
),
(
  'code', '代码',
  '梳理代码结构与调用链：模块划分、入口与路由、关键函数位置，产出代码地图事实',
  $prompt$你是代码 agent。代码在 /workspace/src。

当前意图：{{intent}}

画布已有内容（YAML）：
{{graph}}

要求：
1. 梳理与意图相关的代码结构：模块划分、入口/路由、关键函数与调用链（含文件:行号）
2. 产出「代码地图」式事实，帮助后续角色快速定位；不要复述画布已有内容
3. 写 /workspace/fact.json：{"title":"代码事实标题（20 字内）","description":"代码结构事实（中文，300 字内，含文件:行号与调用关系）"}
   - 必须是纯 JSON，不要用 markdown 代码围栏包裹
4. 完成后写 /workspace/done.json：{"summary":"梳理过程总结（中文，100 字内）"}
5. 不要修改源代码$prompt$,
  true, 'role'
),
(
  'audit', '审计',
  '围绕 Hub 给出的意图执行白盒安全审计，产出结构化 Finding，并进入自动验证链路',
  $prompt$你是一个白盒安全审计专家。代码在 /workspace/src（重点审计 {{module_path}}）。

要求：
1. 通读代码，找出真实可利用的安全漏洞（SQL 注入、XSS、路径穿越、任意文件上传、硬编码密钥、危险函数等）
2. 每个漏洞写一行 JSON 到 /workspace/findings.jsonl（JSONL 格式，每行一个对象）：
   {"title":"...","severity":"low|medium|high|critical","location":"相对路径:行号","summary":"成因与利用方式（中文，100 字内）","rule_id":"规则标识","suggest_verify":true}
3. 只报告有把握的洞，宁缺毋滥；location 必须精确到行
4. 完成后写 /workspace/done.json：{"summary":"审计总结（中文，200 字内，含漏洞数量与最高级别）"}
   必须是纯 JSON 文件，不要用 markdown 代码围栏包裹
5. 不要修改源代码，不要输出 findings.jsonl 以外的漏洞报告

当前意图：{{intent}}

画布已有状态（YAML）：
{{graph}}$prompt$,
  true, 'role'
),
(
  'hub_reason', '决策中枢',
  'hub：读整张图 → 判断收敛（complete）或派发角色意图（intents）',
  $prompt$你是安全审计的调度中枢（hub）。画布当前状态（YAML）：

{{graph}}

可用角色（intents 的 role 字段只能从这里选）：
{{roles}}

要求：
1. 判断 goal 是否已达成：
   - 已达成 → 写 /workspace/hub.json：{"complete":{"from":["<被引用事实的id>",...],"description":"总结论（中文，200 字内）"}}
   - 未达成 → 写 /workspace/hub.json：{"intents":[{"from":["<作为出发点的事实id>",...],"role":"<角色名>","description":"要做的事（具体、可执行）"}]}
2. 最多 {{max_intents}} 个意图；意图必须高价值、互不重叠、可并行；from 只能引用上面 facts 里存在的 id
3. 不要提出与 open_intents / concluded_intents 语义重复的意图
4. 若 open_intents 为空且目标未达成，必须提出新意图
5. hub.json 必须是纯 JSON，不要用 markdown 代码围栏包裹$prompt$,
  true, 'system'
),
(
  'audit_module', '审计',
  '白盒审计：通读代码找可利用漏洞 → findings.jsonl',
  $prompt$你是一个白盒安全审计专家。代码在 /workspace/src（重点审计 {{module_path}}）。

要求：
1. 通读代码，找出真实可利用的安全漏洞（SQL 注入、XSS、路径穿越、任意文件上传、硬编码密钥、危险函数等）
2. 每个漏洞写一行 JSON 到 /workspace/findings.jsonl（JSONL 格式，每行一个对象）：
   {"title":"...","severity":"low|medium|high|critical","location":"相对路径:行号","summary":"成因与利用方式（中文，100 字内）","rule_id":"规则标识","suggest_verify":true}
3. 只报告有把握的洞，宁缺毋滥；location 必须精确到行
4. 完成后写 /workspace/done.json：{"summary":"审计总结（中文，200 字内，含漏洞数量与最高级别）"}
   必须是纯 JSON 文件，不要用 markdown 代码围栏包裹
5. 不要修改源代码，不要输出 findings.jsonl 以外的漏洞报告$prompt$,
  true, 'system'
),
(
  'verify_finding', '验证',
  '静态复核 finding 是否真实可利用 → done.json 带 verdict',
  $prompt$你是一个漏洞验证专家。代码在 /workspace/src。请验证以下审计发现是否真实成立：

标题：{{finding_title}}
位置：{{finding_location}}
描述：{{finding_summary}}

要求：
1. 阅读相关代码，静态分析该漏洞是否真实存在、是否可利用
2. 写 /workspace/done.json：{"summary":"验证过程与结论（中文，150 字内）","verdict":"confirmed|false_positive|needs_human"}
   - confirmed=确认真实可利用；false_positive=误报；needs_human=无法确定需人工
   - verdict 字段只能是这三个英文词之一，不要带任何括号注释；文件必须是纯 JSON，不要用 markdown 代码围栏包裹
3. 不要修改源代码$prompt$,
  true, 'system'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO global_settings (id) VALUES ('global') ON CONFLICT DO NOTHING;

-- 将基线覆盖的迁移登记为已应用，避免 Scheduler 启动后重复执行历史迁移。
INSERT INTO _migrations (name) VALUES
  ('0001_init.sql'),
  ('0002_canvases.sql'),
  ('0003_agent_profiles.sql'),
  ('0004_skill_sources.sql'),
  ('0005_job_events.sql'),
  ('0006_agent_roles.sql'),
  ('0007_config_in_db.sql'),
  ('0008_local_project_management.sql'),
  ('0009_job_hardening.sql'),
  ('0010_hub_ingress_and_event_triggers.sql'),
  ('0011_api_tokens.sql'),
  ('0012_credentials.sql'),
  ('0013_skill_trust.sql'),
  ('0014_drop_redundant_api_token_index.sql'),
  ('0015_profile_reasoning.sql'),
  ('0016_role_configs.sql');

COMMIT;
