-- DeepSonar schema migration 0015
--
-- Credential health/model evidence is scheduler-owned.  This migration also
-- reconstructs legacy public metadata through a small SQL projection so rows
-- written before the server allowlist cannot be echoed by a newer API.
-- The runner owns the transaction; do not add BEGIN/COMMIT here.

ALTER TABLE credentials
  ADD COLUMN last_tested_at timestamptz,
  ADD COLUMN health_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN health_error_category text,
  ADD COLUMN health_detail text,
  ADD COLUMN model_catalog_json jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN model_catalog_fetched_at timestamptz;

ALTER TABLE credentials
  ADD CONSTRAINT credentials_health_status_check
    CHECK (health_status IN ('unknown', 'ok', 'error')),
  ADD CONSTRAINT credentials_health_error_category_check
    CHECK (health_error_category IS NULL OR health_error_category IN (
      'configuration', 'authentication', 'authorization', 'rate_limited',
      'timeout', 'network', 'upstream', 'invalid_response', 'unknown'
    )),
  ADD CONSTRAINT credentials_health_detail_check
    CHECK (health_detail IS NULL OR (length(health_detail) <= 300 AND health_detail !~ '[[:cntrl:]]')),
  ADD CONSTRAINT credentials_model_catalog_check
    CHECK (jsonb_typeof(model_catalog_json) = 'array' AND jsonb_array_length(model_catalog_json) <= 200);

CREATE OR REPLACE FUNCTION deepsonar_sanitize_credential_metadata(
  p_kind text,
  p_provider text,
  p_metadata jsonb
) RETURNS jsonb AS $$
DECLARE
  source jsonb := CASE WHEN jsonb_typeof(p_metadata) = 'object' THEN p_metadata ELSE '{}'::jsonb END;
  output jsonb := '{}'::jsonb;
  base_url text;
  registry text;
  username text;
  model_ids jsonb := '[]'::jsonb;
  model_limits jsonb := '{}'::jsonb;
  allowed text[] := ARRAY[]::text[];
BEGIN
  IF p_kind = 'llm_provider' AND p_provider IN ('anthropic', 'kimi', 'openai', 'openrouter') THEN
    IF jsonb_typeof(source->'base_url') = 'string' THEN
      base_url := btrim(source->>'base_url');
      -- Keep only simple http(s) URLs with no userinfo/query/fragment.  Any
      -- malformed legacy value is dropped rather than copied elsewhere.
      IF base_url ~* '^https?://[^/?#@[:space:]]+(/[^?#[:cntrl:]]*)?$' THEN
        base_url := regexp_replace(base_url, '/+$', '');
        output := output || jsonb_build_object('base_url', base_url);
      END IF;
    END IF;

    IF jsonb_typeof(source->'allowed_model_ids') = 'array' THEN
      SELECT COALESCE(jsonb_agg(model_id ORDER BY model_id), '[]'::jsonb),
             COALESCE(array_agg(model_id ORDER BY model_id), ARRAY[]::text[])
      INTO model_ids, allowed
      FROM (
        SELECT DISTINCT btrim(value #>> '{}') AS model_id
        FROM jsonb_array_elements(source->'allowed_model_ids') AS values(value)
        WHERE jsonb_typeof(value) = 'string'
          AND length(btrim(value #>> '{}')) BETWEEN 1 AND 200
          AND btrim(value #>> '{}') !~ '[[:cntrl:]]'
        ORDER BY model_id
        LIMIT 200
      ) AS models;
      output := output || jsonb_build_object('allowed_model_ids', model_ids);
    END IF;

    IF cardinality(allowed) > 0 AND jsonb_typeof(source->'model_concurrency') = 'object' THEN
      SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
      INTO model_limits
      FROM jsonb_each(source->'model_concurrency') AS entries(key, value)
      WHERE key = ANY(allowed)
        AND jsonb_typeof(value) = 'number'
        AND value::text ~ '^([0-9]|[1-9][0-9]{1,2}|1000)$';
      IF model_limits <> '{}'::jsonb THEN
        output := output || jsonb_build_object('model_concurrency', model_limits);
      END IF;
    END IF;

    IF jsonb_typeof(source->'max_concurrent') = 'number'
       AND (source->>'max_concurrent') ~ '^([0-9]|[1-9][0-9]{1,2}|1000)$' THEN
      output := output || jsonb_build_object('max_concurrent', (source->>'max_concurrent')::int);
    END IF;
  ELSIF p_kind = 'oci_registry' THEN
    IF jsonb_typeof(source->'registry') = 'string' THEN
      registry := lower(btrim(source->>'registry'));
      IF registry !~ '://'
         AND registry !~ '[@?#[:space:]]'
         AND registry ~ '^[a-z0-9][a-z0-9._:-]*(/[a-z0-9._-]+)*$' THEN
        output := output || jsonb_build_object('registry', regexp_replace(registry, '/+$', ''));
      END IF;
    END IF;
    IF jsonb_typeof(source->'username') = 'string' THEN
      username := btrim(source->>'username');
      IF length(username) BETWEEN 1 AND 200 AND username !~ '[[:cntrl:]]' THEN
        output := output || jsonb_build_object('username', username);
      END IF;
    END IF;
  END IF;
  RETURN output;
END;
$$ LANGUAGE plpgsql;

UPDATE credentials
SET public_metadata_json = deepsonar_sanitize_credential_metadata(kind, provider, public_metadata_json),
    model_catalog_json = '[]'::jsonb,
    health_status = 'unknown',
    health_error_category = NULL,
    health_detail = NULL,
    last_tested_at = NULL,
    model_catalog_fetched_at = NULL;

DROP FUNCTION deepsonar_sanitize_credential_metadata(text, text, jsonb);
