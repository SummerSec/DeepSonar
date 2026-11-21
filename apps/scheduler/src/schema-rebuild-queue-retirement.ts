/** Refuse incomplete source shapes before any table is moved, even with force. */
export function assertRetiredQueueSource(
  source: Map<string, { columns: Set<string> }>,
  target: Map<string, Set<string>>,
): void {
  if (target.has("project_task_queues") || ![...source.keys()].some(name => name.startsWith("project_task_queue"))) return;
  const required = {
    project_task_queues: ["project_id", "paused"],
    project_task_queue_items: ["project_id", "canvas_id", "state"],
    canvases: ["id", "project_id", "target_json"],
    jobs: ["project_id", "canvas_id", "status"],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!columns.every(column => source.get(table)?.columns.has(column))) {
      throw new Error(`RETIRED_QUEUE_SOURCE_INVALID: cannot preserve task stops from ${table}`);
    }
  }
}

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
