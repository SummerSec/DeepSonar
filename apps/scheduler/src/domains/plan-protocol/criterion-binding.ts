import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { sql } from "../../db.js";
import { readPlanAudit } from "./application.js";
import { contentSha256, planCriteria, PLAN_BINDING_ACTION, StoredPlanCriterionBinding, type PlanCriterionBindingRequest } from "./criterion-model.js";
import { loadCriterionSource } from "./criterion-source.js";

export class CriterionBindingError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function listFactPlanBindings(db: typeof sql, projectId: string, factId: string) {
  const rows = await db`
    SELECT id::text AS audit_id, after_json FROM audit_logs
    WHERE project_id = ${projectId} AND resource_id = ${factId}
      AND action = ${PLAN_BINDING_ACTION} AND result = 'ok'
    ORDER BY id DESC LIMIT 33`;
  return { records: rows.slice(0, 32), truncated: rows.length > 32 };
}

/** Called inside the existing Fact verification transaction, with the Fact row locked. */
export async function attestPlanCriterion(
  db: typeof sql, req: FastifyRequest, canvasId: string, projectId: string, factId: string,
  request: PlanCriterionBindingRequest, verificationEpoch: string, rationale: string,
): Promise<void> {
  const [job] = await db`SELECT payload_json FROM jobs WHERE id = ${request.plan_job_id}
    AND canvas_id = ${canvasId} AND project_id = ${projectId} AND type <> 'report'`;
  const plan = readPlanAudit(job?.payload_json)?.raw;
  if (!plan || contentSha256(plan) !== request.plan_sha256) throw new CriterionBindingError("PLAN_BINDING_STALE_PLAN");
  const criterion = planCriteria(plan).find((item) => item.id === request.criterion_id);
  if (!criterion) throw new CriterionBindingError("PLAN_BINDING_INVALID_CRITERION");
  const source = await loadCriterionSource(db, canvasId, projectId, factId);
  if (!source?.eligible || !source.source.attempt_id || !source.source.event_id) throw new CriterionBindingError("PLAN_BINDING_SOURCE_UNAVAILABLE");
  if (source.source_sha256 !== request.expected_source_sha256) throw new CriterionBindingError("PLAN_BINDING_STALE_SOURCE");
  const [latest] = await db`SELECT after_json FROM audit_logs WHERE project_id = ${projectId}
    AND resource_id = ${factId} AND action = ${PLAN_BINDING_ACTION} AND result = 'ok'
    AND after_json->>'plan_job_id' = ${request.plan_job_id}
    AND after_json->>'criterion_id' = ${request.criterion_id}
    ORDER BY id DESC LIMIT 1`;
  const previous = StoredPlanCriterionBinding.safeParse(latest?.after_json);
  if (latest && !previous.success) throw new CriterionBindingError("PLAN_BINDING_INVALID_AUDIT");
  // A retry with the original expected id is accepted only if the complete decision is identical.
  if (previous.success && previous.data.plan_sha256 === request.plan_sha256
    && previous.data.expected_source_sha256 === request.expected_source_sha256
    && previous.data.assessment === request.assessment && previous.data.observation === request.observation
    && previous.data.verification_epoch === verificationEpoch && previous.data.rationale === rationale) return;
  if ((previous.success ? previous.data.binding_id : null) !== request.expected_binding_id) {
    throw new CriterionBindingError("PLAN_BINDING_REVISION_CONFLICT");
  }
  const { expected_binding_id: _expected, ...proposal } = request;
  const binding = StoredPlanCriterionBinding.parse({
    ...proposal, v: 1, authority: "operator_attestation", binding_id: randomUUID(), fact_id: factId,
    criterion_sha256: contentSha256(criterion), verification_epoch: verificationEpoch, rationale,
    source: { ...source.source, attempt_id: source.source.attempt_id, event_id: source.source.event_id },
  });
  // Mandatory append-only audit and Fact trust update commit together; failure rolls back both.
  await db`INSERT INTO audit_logs ${db({
    actor_type: req.actor?.type ?? "anonymous", actor_id: req.actor?.name ?? "anonymous",
    action: PLAN_BINDING_ACTION, project_id: projectId, resource_type: "canvas_fact", resource_id: factId,
    request_id: req.id, result: "ok",
    before_json: previous.success ? db.json({ binding_id: previous.data.binding_id }) : null,
    after_json: db.json(binding as never),
  })}`;
}
