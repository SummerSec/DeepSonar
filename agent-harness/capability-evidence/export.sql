-- Authorized research export only. Existing frozen catalog metadata is retained for hash verification.
-- Choice/feedback fields are an explicit whitelist; no target, reason, suggestion body or evidence text.
-- psql "$TEST_DATABASE_URL" -X -qAt -v project_id='<UUID>' -f export.sql > export.json
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH selected_jobs AS (
  SELECT id,project_id,status,
    agent_snapshot_json->'project_knowledge_catalog' AS project_knowledge_catalog,
    CASE WHEN agent_snapshot_json->'capability_pack' IS NOT NULL AND agent_snapshot_json->'capability_pack'<>'null'::jsonb
      THEN jsonb_build_object('id',agent_snapshot_json->'capability_pack'->'id',
        'version',agent_snapshot_json->'capability_pack'->'version','digest',agent_snapshot_json->'capability_pack'->'digest') END AS capability_pack
  FROM jobs WHERE project_id=:'project_id'::uuid ORDER BY id LIMIT 10001
), selected_attempts AS (
  SELECT id,job_id FROM job_attempts WHERE job_id IN (SELECT id FROM selected_jobs) ORDER BY id LIMIT 10001
), selected_versions AS (
  SELECT v.id,v.project_id,v.item_id,v.version,v.content_sha256,v.revoked_at,i.status AS item_status
  FROM project_knowledge_versions v JOIN project_knowledge_items i ON i.id=v.item_id AND i.project_id=v.project_id
  WHERE v.project_id=:'project_id'::uuid ORDER BY v.id LIMIT 10001
), selected_usages AS (
  SELECT id,project_id,job_id,attempt_id,owner_project_id,version_id,selector,content_sha256,
    CASE WHEN feedback_json->>'outcome' IN ('success','failure','inapplicable') THEN feedback_json->>'outcome' END AS declared_outcome,
    CASE WHEN jsonb_typeof(feedback_json->'evidence_refs')='array' THEN jsonb_array_length(feedback_json->'evidence_refs') END AS declared_evidence_count
  FROM project_knowledge_usages WHERE project_id=:'project_id'::uuid
    AND owner_project_id=:'project_id'::uuid ORDER BY id LIMIT 10001
), selected_receipts AS (
  SELECT r.id,r.project_id,r.job_id,r.attempt_id,r.operation,r.state,
    CASE WHEN e.id IS NOT NULL THEN r.event_id END AS event_id,e.job_seq AS event_seq,
    CASE WHEN r.operation='record_knowledge_feedback' THEN jsonb_build_object('usage_ref',r.result_json->'usage_ref')
    ELSE jsonb_build_object(
      'decision',r.result_json->'decision','selector',r.result_json->'selector','content_hash',r.result_json->'content_hash',
      'policy_version',r.result_json->'suggestion'->'policy_version',
      'context_hash',r.result_json->'suggestion'->'context_hash','catalog_hash',r.result_json->'suggestion'->'catalog_hash',
      'reason_present',jsonb_typeof(r.result_json->'reason')='string' AND length(r.result_json->>'reason')>0,
      'candidate',(SELECT jsonb_build_object('version_id',c->'version_id','version',c->'version',
          'selector',c->'selector','content_hash',c->'content_hash')
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(r.result_json->'suggestion'->'items')='array' THEN r.result_json->'suggestion'->'items' ELSE '[]'::jsonb END
          || CASE WHEN jsonb_typeof(r.result_json->'suggestion'->'diagnostics')='array' THEN r.result_json->'suggestion'->'diagnostics' ELSE '[]'::jsonb END) c
        WHERE r.result_json->>'decision' IN ('select','reject') AND c->>'selector'=r.result_json->>'selector'
          AND c->>'content_hash'=r.result_json->>'content_hash' LIMIT 1)) END AS result
  FROM project_knowledge_receipts r LEFT JOIN events e ON e.job_id=r.job_id AND e.attempt_id=r.attempt_id
    AND e.event_id=r.event_id::text AND e.type='knowledge' AND e.payload_json->>'operation'=r.operation
  WHERE r.project_id=:'project_id'::uuid AND r.operation IN ('record_knowledge_feedback','record_skill_choice')
  ORDER BY r.id LIMIT 10001
)
SELECT jsonb_build_object('schema','deepsonar.capability-evidence-export/v2',
  'project_id',:'project_id'::uuid,'captured_at',transaction_timestamp(),
  'jobs',COALESCE((SELECT jsonb_agg(j) FROM selected_jobs j),'[]'::jsonb),
  'attempts',COALESCE((SELECT jsonb_agg(a) FROM selected_attempts a),'[]'::jsonb),
  'versions',COALESCE((SELECT jsonb_agg(v) FROM selected_versions v),'[]'::jsonb),
  'usages',COALESCE((SELECT jsonb_agg(u) FROM selected_usages u),'[]'::jsonb),
  'receipts',COALESCE((SELECT jsonb_agg(r) FROM selected_receipts r),'[]'::jsonb));
COMMIT;
