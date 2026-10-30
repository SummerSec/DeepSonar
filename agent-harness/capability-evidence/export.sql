-- Run only against an authorized isolated research database. No model or domain writes.
-- psql "$TEST_DATABASE_URL" -X -qAt -v project_id='<UUID>' -f export.sql > export.json
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH selected_jobs AS (
  SELECT id, project_id, status,
    agent_snapshot_json->'project_knowledge_catalog' AS project_knowledge_catalog,
    agent_snapshot_json->'capability_pack' AS capability_pack
  FROM jobs WHERE project_id=:'project_id'::uuid ORDER BY id LIMIT 10001
), selected_attempts AS (
  SELECT id,job_id FROM job_attempts WHERE job_id IN (SELECT id FROM selected_jobs) ORDER BY id LIMIT 10001
), selected_versions AS (
  SELECT id,project_id,item_id,version,content_sha256,revoked_at
  FROM project_knowledge_versions WHERE project_id=:'project_id'::uuid ORDER BY id LIMIT 10001
), selected_usages AS (
  SELECT id,project_id,job_id,attempt_id,owner_project_id,version_id,selector,content_sha256,
    jsonb_build_object('outcome',feedback_json->'outcome',
      'evidence_refs',feedback_json->'evidence_refs') AS feedback_json
  FROM project_knowledge_usages WHERE project_id=:'project_id'::uuid
    AND owner_project_id=:'project_id'::uuid ORDER BY id LIMIT 10001
), selected_receipts AS (
  SELECT id,project_id,job_id,attempt_id,operation,state,
    jsonb_build_object('usage_ref',result_json->'usage_ref') AS result_json
  FROM project_knowledge_receipts WHERE project_id=:'project_id'::uuid
    AND operation='record_knowledge_feedback' ORDER BY id LIMIT 10001
)
SELECT jsonb_build_object('schema','deepsonar.capability-evidence-export/v1',
  'project_id',:'project_id'::uuid,'captured_at',transaction_timestamp(),
  'jobs',COALESCE((SELECT jsonb_agg(j) FROM selected_jobs j),'[]'::jsonb),
  'attempts',COALESCE((SELECT jsonb_agg(a) FROM selected_attempts a),'[]'::jsonb),
  'versions',COALESCE((SELECT jsonb_agg(v) FROM selected_versions v),'[]'::jsonb),
  'usages',COALESCE((SELECT jsonb_agg(u) FROM selected_usages u),'[]'::jsonb),
  'receipts',COALESCE((SELECT jsonb_agg(r) FROM selected_receipts r),'[]'::jsonb));
COMMIT;
