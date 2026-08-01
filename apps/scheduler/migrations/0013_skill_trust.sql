-- SKILL 工作包阶段一（§5.1）：Skill Source 信任/版本
-- 简化路线（文档 §172 认可）：先给 skill_sources 加 commit/hash/trust，
-- 完整内容继续冻结进 Job Snapshot；版本历史表（skill_revisions）留待有回滚需求再引入。

ALTER TABLE skill_sources
  ADD COLUMN IF NOT EXISTS trust_status text NOT NULL DEFAULT 'quarantined',
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_commit_sha text,
  ADD COLUMN IF NOT EXISTS last_content_hash text,
  ADD COLUMN IF NOT EXISTS synced_by text;

-- 存量源视为已信任并启用（它们已在生产使用；新建源默认 quarantined 待审批）
UPDATE skill_sources SET trust_status = 'trusted', enabled = true WHERE trust_status = 'quarantined';

ALTER TABLE skill_sources
  ADD CONSTRAINT skill_sources_trust_check CHECK (trust_status IN ('quarantined','trusted','disabled'));
