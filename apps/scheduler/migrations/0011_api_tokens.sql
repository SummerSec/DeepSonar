-- AUTH 工作包（§6.1）：平台 API Token
-- 只存哈希与前缀，明文仅创建/轮换时返回一次；吊销优先于删除。

CREATE TABLE IF NOT EXISTS api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  subject_type  text NOT NULL DEFAULT 'service_account',
  subject_id    text,
  -- 非空时该 token 仅限单项目（项目级 scope 在路由层校验）
  project_id    uuid REFERENCES projects(id),
  token_prefix  text NOT NULL UNIQUE,
  token_hash    text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz,
  last_used_at  timestamptz,
  last_ip       text,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text
);

CREATE INDEX IF NOT EXISTS api_tokens_prefix_idx ON api_tokens (token_prefix);
