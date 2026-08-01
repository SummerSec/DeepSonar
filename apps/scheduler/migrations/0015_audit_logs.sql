-- EVD 工作包（§7.2）：append-only 审计日志
-- 记录认证失败、Token/Credential/Skill/Profile/项目/任务/Job 操作、Plane 绑定等管理动作。
-- 红线：Credential 明文、Authorization Header、Cookie、模型 API Key 永不写入。

CREATE TABLE IF NOT EXISTS audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL,          -- internal | api_token | bootstrap_admin | anonymous
  actor_id      text NOT NULL,          -- token 名 / admin / ip 摘要
  action        text NOT NULL,          -- 如 token.create / credential.rotate / job.cancel / auth.failed
  project_id    uuid,
  resource_type text,
  resource_id   text,
  request_id    text,
  ip            text,
  user_agent    text,
  before_json   jsonb,
  after_json    jsonb,
  result        text NOT NULL DEFAULT 'ok',   -- ok | denied | error
  error_code    text
);

CREATE INDEX IF NOT EXISTS audit_logs_at_idx ON audit_logs (at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_project_idx ON audit_logs (project_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, at DESC);

-- append-only：禁止 UPDATE / DELETE（超级用户绕过是运维通道，应用层角色一律被拒）
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs 是 append-only，不允许 %', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
