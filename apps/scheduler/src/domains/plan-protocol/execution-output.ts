import { z } from "zod";
import type { EventIngestionTransaction } from "../event-ingestion/application.js";
import type { PlanDependencyOutput, PlanV2, TaskContext, TaskRow } from "./execution.js";
import { criterionEvidenceBudget, inspectCriterionEvidence, type EvidenceReadBudget } from "./criterion-evidence.js";
import { contentSha256 } from "./criterion-model.js";

/** Artifact extension naming the exact outputs of one immutable PlanTask.
 * This is an output association, never semantic completion authority. */
export const PlanTaskOutput = z.object({
  v: z.literal(2),
  objective_id: z.string().uuid(),
  objective_revision: z.string().regex(/^[1-9][0-9]{0,19}$/),
  task_id: z.string().min(1).max(64),
  task_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expected_outputs: z.array(z.string().min(1).max(500)).min(1).max(32)
    .refine((values) => new Set(values).size === values.length),
}).strict();

export async function successfulPlanTaskOutput(
  tx: EventIngestionTransaction,
  row: TaskRow,
  task: PlanV2["tasks"][number],
  context: TaskContext,
  budget: EvidenceReadBudget = criterionEvidenceBudget(),
): Promise<PlanDependencyOutput | null> {
  if (row.status !== "succeeded" || !row.attempt_id || row.attempt_status !== "succeeded") return null;
  const outputs = await tx`
    SELECT n.id::text AS node_id, a.id::text AS artifact_id, a.extensions_json,
           e.event_id::text AS event_id, e.payload_json
    FROM artifacts a
    JOIN canvas_nodes n ON n.id=a.node_id AND n.canvas_id=a.canvas_id
      AND n.body_json->>'artifact_id'=a.id::text
    JOIN events e ON e.job_id=a.job_id AND e.event_id=a.source_event_id
      AND e.attempt_id=${row.attempt_id}
      AND ((a.source_operation='emit_fact' AND e.type='fact' AND n.node_type='fact')
        OR (a.source_operation='emit_finding' AND e.type='finding' AND n.node_type='finding'))
    WHERE a.project_id=${row.project_id} AND a.canvas_id=${row.canvas_id}
      AND a.job_id=${row.id} AND a.status='submitted' AND a.superseded_at IS NULL
      AND n.verification_status IS DISTINCT FROM 'rejected'
      AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.artifact_id=a.id
        AND (f.verify_status IN ('false_positive','refuted') OR f.disposition IN ('rejected_fp','archived')))
    ORDER BY a.id LIMIT 33`;
  // No truncation may produce a positive answer. The bound also limits file IO.
  if (outputs.length > 32 || task.expected_outputs.length === 0) return null;
  const required = new Set(task.expected_outputs);
  const covered = new Set<string>();
  const accepted: Array<{ nodeId: string; artifactId: string; eventId: string; evidenceIds: string[] }> = [];
  for (const output of outputs) {
    const binding = PlanTaskOutput.safeParse(output.extensions_json?.["plan.output"]);
    const eventBinding = PlanTaskOutput.safeParse(output.payload_json?.artifact?.extensions?.["plan.output"]);
    if (!binding.success || !eventBinding.success || contentSha256(binding.data) !== contentSha256(eventBinding.data)) continue;
    if (binding.data.objective_id !== context.objective_id
      || binding.data.objective_revision !== context.objective_revision
      || binding.data.task_id !== task.id || binding.data.task_sha256 !== contentSha256(task)
      || binding.data.expected_outputs.some((name) => !required.has(name))) continue;
    const evidence = await tx<{ id: string; uri: string | null; sha256: string | null }[]>`
      SELECT id,uri,sha256 FROM artifact_evidence
      WHERE artifact_id=${output.artifact_id} ORDER BY ordinal,id LIMIT 9`;
    const retained = await inspectCriterionEvidence(row.id, row.attempt_id, evidence, budget);
    if (retained.reasons.length > 0) continue;
    binding.data.expected_outputs.forEach((name) => covered.add(name));
    accepted.push({ nodeId: String(output.node_id), artifactId: String(output.artifact_id),
      eventId: String(output.event_id), evidenceIds: retained.ids });
  }
  const evidenceIds = [...new Set(accepted.flatMap((output) => output.evidenceIds))];
  const eventIds = [...new Set(accepted.map((output) => output.eventId))];
  if (covered.size !== required.size || evidenceIds.length === 0 || evidenceIds.length > 64 || eventIds.length > 16) return null;
  return { task_id: task.id, job_id: row.id, attempt_id: row.attempt_id,
    event_ids: eventIds, node_ids: accepted.map((output) => output.nodeId),
    artifact_ids: accepted.map((output) => output.artifactId), evidence_ids: evidenceIds };
}
