-- Issue #70 Slice C: persist the selected official registry channel and all
-- immutable per-channel references/evidence.  Legacy image_ref/resolved_ref
-- columns remain for compatibility; channel-aware consumers use the refs table.

ALTER TABLE global_settings
  ADD COLUMN runtime_registry_channel text NOT NULL DEFAULT 'github';
ALTER TABLE global_settings
  ADD CONSTRAINT global_settings_runtime_registry_channel_check
  CHECK (runtime_registry_channel IN ('github', 'dockerhub', 'aliyun-acr'));

-- A v2 catalog can legitimately have no GitHub projection.  Keep the legacy
-- columns for old readers, but permit them to be empty while the refs table is
-- authoritative for channel-aware selection.
ALTER TABLE runtime_image_versions
  ALTER COLUMN image_ref DROP NOT NULL;

CREATE TABLE runtime_image_version_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES runtime_image_versions(id) ON DELETE CASCADE,
  channel text NOT NULL,
  image_ref text NOT NULL,
  resolved_ref text NOT NULL,
  digest text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_image_version_refs_channel_check
    CHECK (channel IN ('github', 'dockerhub', 'aliyun-acr')),
  CONSTRAINT runtime_image_version_refs_image_ref_check
    CHECK (image_ref ~ '^[a-z0-9][a-z0-9.-]*/[^@[:space:]]+@sha256:[0-9a-f]{64}$'),
  CONSTRAINT runtime_image_version_refs_resolved_ref_check
    CHECK (resolved_ref ~ '(^sha256:[0-9a-f]{64}$|^[a-z0-9][a-z0-9.-]*/[^@[:space:]]+@sha256:[0-9a-f]{64}$)'),
  CONSTRAINT runtime_image_version_refs_digest_check
    CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT runtime_image_version_refs_image_digest_match_check
    CHECK (substring(image_ref from '@(sha256:[0-9a-f]{64})$') = digest),
  CONSTRAINT runtime_image_version_refs_resolved_digest_match_check
    CHECK (
      (resolved_ref ~ '^sha256:[0-9a-f]{64}$' AND resolved_ref = digest)
      OR substring(resolved_ref from '@(sha256:[0-9a-f]{64})$') = digest
    ),
  UNIQUE (version_id, channel)
);
CREATE INDEX runtime_image_version_refs_channel_digest_idx
  ON runtime_image_version_refs (channel, digest);

-- Backfill trusted official v1 rows into the channel table.  Only exact
-- server-owned host/namespace spellings are eligible; third-party/local rows
-- stay on the legacy runtime_image_versions path and are never reclassified as
-- an official channel.  v1 has no destination inspection evidence, so the
-- evidence object remains empty rather than claiming a synthetic inspection.
WITH legacy_refs AS (
  SELECT
    v.id AS version_id,
    CASE
      WHEN v.image_ref ~ '^ghcr\.io/summersec/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$' THEN 'github'
      WHEN v.image_ref ~ '^docker\.io/summersec/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$' THEN 'dockerhub'
      WHEN v.image_ref ~ '^crpi-6s5wwv0nhl6dq1l0\.cn-hangzhou\.personal\.cr\.aliyuncs\.com/summersec/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$' THEN 'aliyun-acr'
      ELSE NULL END AS channel,
    v.image_ref,
    v.image_ref AS resolved_ref,
    COALESCE(v.digest, substring(v.image_ref from '@(sha256:[0-9a-f]{64})$')) AS digest
  FROM runtime_image_versions v
  JOIN runtime_images i ON i.id = v.runtime_image_id
  WHERE i.official = true
    AND v.trust_status = 'trusted'
    AND v.image_ref IS NOT NULL
    AND COALESCE(v.digest, substring(v.image_ref from '@(sha256:[0-9a-f]{64})$'))
      = substring(v.image_ref from '@(sha256:[0-9a-f]{64})$')
)
INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json)
SELECT version_id, channel, image_ref, resolved_ref, digest, '{}'::jsonb
FROM legacy_refs
WHERE channel IS NOT NULL
  AND digest IS NOT NULL
  AND resolved_ref IS NOT NULL
ON CONFLICT (version_id, channel) DO NOTHING;
