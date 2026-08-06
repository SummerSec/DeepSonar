-- DeepSonar schema migration 0020
--
-- Persist the generic Finding protocol fields while keeping severity optional
-- for profiles that do not use a qualitative severity scale.  The runner owns
-- the transaction; do not add BEGIN/COMMIT here.

ALTER TABLE findings
  ADD COLUMN profile text NOT NULL DEFAULT 'security.vulnerability',
  ADD COLUMN category text,
  ADD COLUMN tags_json jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN evidence_refs_json jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN scoring_json jsonb NOT NULL DEFAULT '{}',
  ALTER COLUMN severity DROP NOT NULL;

ALTER TABLE findings
  DROP CONSTRAINT findings_severity_check;

ALTER TABLE findings
  ADD CONSTRAINT findings_severity_check
    CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical'));

CREATE INDEX findings_profile_category_idx
  ON findings (project_id, profile, category, verify_status);
