-- 0010: 所有任务统一由 hub_reason 接收；外部事件可幂等触发任务。

ALTER TABLE canvases ADD COLUMN IF NOT EXISTS trigger_source text;
ALTER TABLE canvases ADD COLUMN IF NOT EXISTS trigger_event_id text;
ALTER TABLE canvases ADD COLUMN IF NOT EXISTS trigger_payload_json jsonb NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS canvases_trigger_uniq
  ON canvases (project_id, trigger_source, trigger_event_id)
  WHERE trigger_event_id IS NOT NULL;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ingress_key text;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_ingress_key_uniq
  ON jobs (project_id, ingress_key)
  WHERE ingress_key IS NOT NULL;

-- audit_module 保留为历史兼容的系统模板；audit 是 Hub 可以实际派发的审计角色。
INSERT INTO agent_roles (name, title, description, prompt_template, builtin, kind)
SELECT
  'audit',
  '审计',
  '围绕 Hub 给出的意图执行白盒安全审计，产出结构化 Finding，并进入自动验证链路',
  prompt_template || E'\n\n当前意图：{{intent}}\n\n画布已有状态（YAML）：\n{{graph}}',
  true,
  'role'
FROM agent_roles
WHERE name = 'audit_module'
ON CONFLICT (name) DO NOTHING;
