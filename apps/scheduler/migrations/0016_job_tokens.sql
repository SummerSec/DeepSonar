-- GW 工作包（§6.3）：短期 Job Token —— 沙箱不持有长期 Provider Key，
-- 改持单 Job、限模型、限额度的 DFH_JOB_TOKEN，经 Model Gateway 转发上游。
-- Job 终态（succeeded/failed/cancelled/timeout/orphan）后立即吊销；
-- 网关每次请求还会回查 job 状态，容器残留也无法继续调用模型。

CREATE TABLE IF NOT EXISTS job_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL,
  credential_id  uuid NOT NULL REFERENCES credentials(id),
  token_prefix   text NOT NULL UNIQUE,
  token_hash     text NOT NULL,
  allowed_models text[] NOT NULL DEFAULT '{}',   -- 空 = 不限
  max_requests   integer NOT NULL DEFAULT 500,
  max_tokens     integer,                        -- NULL = 不限（输入+输出合计）
  used_requests  integer NOT NULL DEFAULT 0,
  used_tokens    integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active',
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoke_reason  text,
  CONSTRAINT job_tokens_status_check CHECK (status IN ('active','revoked','exhausted','expired'))
);

CREATE INDEX IF NOT EXISTS job_tokens_job_idx ON job_tokens (job_id);
