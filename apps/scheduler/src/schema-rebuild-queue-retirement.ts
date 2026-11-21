/** One-time copy projection. Retired queue tables are never runtime inputs. */
export function retiredQueueTargetProjection(sourceSchema: string): string {
  // The caller quotes the fixed staging schema with quoteIdent.
  return `CASE WHEN EXISTS (
    SELECT 1 FROM ${sourceSchema}.project_task_queue_items item
    JOIN ${sourceSchema}.project_task_queues queue ON queue.project_id = item.project_id
    WHERE item.canvas_id = source.id AND item.project_id = source.project_id
      AND item.state IN ('queued', 'active', 'yielded', 'failed', 'cancelled')
      AND queue.paused
  ) AND NOT EXISTS (
    SELECT 1 FROM ${sourceSchema}.jobs job
    WHERE job.canvas_id = source.id AND job.project_id = source.project_id
      AND job.status IN ('claimed', 'provisioning', 'running')
  ) AND COALESCE(source.target_json #>> '{execution_control,paused}', 'false') <> 'true'
  THEN source.target_json || jsonb_build_object('execution_control', jsonb_build_object(
    'paused', true, 'paused_at', now(), 'paused_by', NULL,
    'reason', 'queue_retirement_review_required'))
  ELSE source.target_json END`;
}
