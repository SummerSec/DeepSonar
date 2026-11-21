import type { Sql, TransactionSql } from "postgres";
import { TASK_KNOWLEDGE_SUGGESTION_OPERATION } from "@deepsonar/shared-types";

const nodeType = "knowledge_closeout";
const scanSize = 64;

function unprojectedCloseout(db: Sql | TransactionSql) {
  return db`
    canvas.status = 'active'
    AND root.node_type = 'root' AND root.status = 'succeeded'
    AND EXISTS (
      SELECT 1 FROM task_reports report
      JOIN jobs report_job ON report_job.id = report.report_job_id
        AND report_job.canvas_id = canvas.id AND report_job.project_id = canvas.project_id
        AND report_job.type = 'report' AND report_job.status = 'succeeded'
      WHERE report.canvas_id = canvas.id AND report.project_id = canvas.project_id
        AND report.status = 'succeeded' AND report.created_at >= root.created_at
    )
    AND EXISTS (
      SELECT 1 FROM jobs enrolled
      WHERE enrolled.canvas_id = canvas.id AND enrolled.project_id = canvas.project_id
        AND enrolled.created_at >= root.created_at AND enrolled.type NOT IN ('hub_reason','report')
        AND NOT EXISTS (SELECT 1 FROM project_knowledge_job_assignments a WHERE a.job_id = enrolled.id)
        AND (enrolled.agent_snapshot_json -> 'platform_tools') ? ${TASK_KNOWLEDGE_SUGGESTION_OPERATION}
    )
    AND NOT EXISTS (
      SELECT 1 FROM jobs live
      WHERE live.canvas_id = canvas.id AND live.status IN ('pending','claimed','provisioning','running','waiting_human')
    )
    AND NOT EXISTS (
      SELECT 1 FROM jobs job JOIN job_attempt_effects effect ON effect.job_id = job.id
      WHERE job.canvas_id = canvas.id AND (effect.status IN ('effect_pending','unknown')
        OR (effect.status = 'planned' AND effect.effect_kind = 'agent_run'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM canvas_nodes existing
      WHERE existing.canvas_id = canvas.id AND existing.node_type = ${nodeType}
        AND existing.body_json ->> 'root_node_id' = root.id::text
    )`;
}

export async function projectTaskKnowledgeCloseout(tx: TransactionSql, canvasId: string): Promise<boolean> {
  // Normal finalization and recovery serialize on the same Canvas row.
  // The Root UUID survives report regeneration and changes on a hard restart.
  const [locked] = await tx`SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
  if (!locked) return false;
  const [root] = await tx<{ id: string; project_id: string }[]>`
    SELECT root.id, canvas.project_id FROM canvases canvas
    JOIN canvas_nodes root ON root.canvas_id = canvas.id
    WHERE canvas.id = ${canvasId} AND ${unprojectedCloseout(tx)}`;
  if (!root) return false;

  // Select the latest Attempt before checking its status, so a superseded success cannot qualify.
  const results = await tx<{ result: string }[]>`
    SELECT DISTINCT receipt.result_json ->> 'result' AS result
    FROM jobs job
    JOIN LATERAL (
      SELECT id, status FROM job_attempts
      WHERE job_id = job.id ORDER BY attempt_no DESC LIMIT 1
    ) attempt ON attempt.status = 'succeeded'
    JOIN project_knowledge_receipts receipt ON receipt.job_id = job.id AND receipt.attempt_id = attempt.id
      AND receipt.project_id = job.project_id
    WHERE job.project_id = ${root.project_id} AND job.canvas_id = ${canvasId} AND job.status = 'succeeded'
      AND receipt.operation = ${TASK_KNOWLEDGE_SUGGESTION_OPERATION}
      AND receipt.result_json ->> 'root_node_id' = ${root.id}
      AND receipt.result_json ->> 'result' IN ('suggestions','no_new')`;
  const state = results.some(row => row.result === "suggestions") ? "suggestions_available"
    : results.some(row => row.result === "no_new") ? "no_new" : "not_submitted";
  const [node] = await tx<{ id: string }[]>`INSERT INTO canvas_nodes (canvas_id,node_type,title,body_json,x,y,status)
    VALUES (${canvasId},${nodeType},'知识沉淀',${tx.json({ root_node_id: root.id, state })},60,680,${state})
    RETURNING id`;
  if (!node) throw new Error("Task knowledge closeout node was not inserted");
  await tx`INSERT INTO canvas_edges (canvas_id,from_node_id,to_node_id,edge_type)
    VALUES (${canvasId},${root.id},${node.id},'child')`;
  return true;
}

export async function projectTaskKnowledgeCloseoutBestEffort(tx: TransactionSql, canvasId: string): Promise<void> {
  try {
    await tx.savepoint(nested => projectTaskKnowledgeCloseout(nested, canvasId));
  } catch {
    console.warn("[task-knowledge-closeout] projection deferred");
  }
}

export async function recoverTaskKnowledgeCloseouts(db: Sql, cursor: string | null = null): Promise<{
  nextCursor: string | null;
  projected: number;
}> {
  const candidates = await db<{ id: string; eligible: boolean }[]>`
    WITH scan AS MATERIALIZED (
      SELECT id, project_id, status FROM canvases
      WHERE ${cursor}::text IS NULL OR id > ${cursor}::text
      ORDER BY id LIMIT ${scanSize}
    )
    SELECT canvas.id, root.id IS NOT NULL AS eligible FROM scan canvas
    LEFT JOIN canvas_nodes root ON root.canvas_id = canvas.id AND ${unprojectedCloseout(db)}
    ORDER BY canvas.id`;
  let projected = 0;
  for (const candidate of candidates) {
    if (!candidate.eligible) continue;
    try {
      if (await db.begin(tx => projectTaskKnowledgeCloseout(tx, candidate.id))) projected++;
    } catch {
      console.warn("[task-knowledge-closeout] recovery deferred");
    }
  }
  return { projected, nextCursor: candidates.length === scanSize ? candidates.at(-1)!.id : null };
}
