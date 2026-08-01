-- 0009: Job 状态机加固（PRODUCTION_HARDENING §8.5：CHECK 约束 + claimed_at）
-- 现有数据已核查全部符合以下枚举/范围，可直接加约束

-- provision 超时判定依据（claimed/provisioning 无 started_at，用 claimed_at 计时）
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
UPDATE jobs SET claimed_at = COALESCE(started_at, created_at) WHERE claimed_at IS NULL;

ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('pending','claimed','provisioning','running','waiting_human',
                    'succeeded','failed','timeout','cancelled','orphan'));
ALTER TABLE jobs ADD CONSTRAINT jobs_priority_check CHECK (priority BETWEEN -1000 AND 1000);
ALTER TABLE jobs ADD CONSTRAINT jobs_timeout_check CHECK (timeout_sec > 0);
ALTER TABLE jobs ADD CONSTRAINT jobs_followup_depth_check CHECK (followup_depth >= 0);

ALTER TABLE findings ADD CONSTRAINT findings_severity_check
  CHECK (severity IN ('low','medium','high','critical'));
ALTER TABLE findings ADD CONSTRAINT findings_verify_status_check
  CHECK (verify_status IN ('pending','verifying','confirmed','false_positive','needs_human'));

ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('active','archived'));

-- 事件幂等与局部序的 DB 兜底（应用层 event_dedup 为主，这里防并发竞态）
ALTER TABLE events ADD CONSTRAINT events_job_seq_uniq UNIQUE (job_id, job_seq);
ALTER TABLE events ADD CONSTRAINT events_job_event_uniq UNIQUE (job_id, event_id);
