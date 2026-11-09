import type { ProvisionFailureDiagnostic } from "@deepsonar/runtime-sandbox";
import { recordDurableSystemAudit } from "./audit.js";
import { sql } from "./db.js";
import { assertBoundedJson, ATTEMPT_MAX_STATE_BYTES } from "./domains/job-attempt/model.js";

const SCHEMA = "deepsonar.provision-failure/v1";
const REF = "provision_failure_audit_id";
const STAGES = ["create", "runtime_contract", "shared_assets", "runtime_manual", "gateway"];
const READ_LIMIT = 32;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const auditId = (value: unknown): value is string => typeof value === "string"
  && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n;

/** Only fixed diagnostic fields cross the Job read plane; audit metadata is not forwarded. */
export function projectProvisionFailure(value: unknown): ProvisionFailureDiagnostic | null {
  const d = record(value), signals = record(d?.signals);
  if (!d || !signals || typeof d.stage !== "string" || !STAGES.includes(d.stage)
    || typeof d.session_observed !== "boolean" || typeof d.cancelled !== "boolean"
    || !(d.http_status === null || (typeof d.http_status === "number" && Number.isInteger(d.http_status) && d.http_status >= 100 && d.http_status <= 599))
    || ["execd_distribution_failed", "broken_pipe", "connection_reset", "timeout"].some(key => typeof signals[key] !== "boolean")) return null;
  return { stage: d.stage as ProvisionFailureDiagnostic["stage"], session_observed: d.session_observed,
    cancelled: d.cancelled, http_status: d.http_status as number | null,
    signals: { execd_distribution_failed: signals.execd_distribution_failed as boolean,
      broken_pipe: signals.broken_pipe as boolean, connection_reset: signals.connection_reset as boolean,
      timeout: signals.timeout as boolean } };
}

/** Awaited before cleanup. The immutable audit and first-reference publish together; no lifecycle/effect changes. */
export async function recordProvisionFailureEvidence(db: typeof sql, input: {
  jobId: string; projectId: string; attemptId: string; diagnostic: unknown;
}): Promise<string> {
  const diagnostic = projectProvisionFailure(input.diagnostic);
  if (!diagnostic) throw new Error("Invalid provision diagnostic");
  return db.begin(async tx => {
    const [job] = await tx`SELECT project_id FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
    if (!job || job.project_id !== input.projectId) throw new Error("Provision diagnostic Job scope mismatch");
    const [attempt] = await tx`SELECT state_json FROM job_attempts WHERE id=${input.attemptId} AND job_id=${input.jobId} FOR UPDATE`;
    const state = record(attempt?.state_json);
    if (!state || state.version !== 1 || state.job_id !== input.jobId || state.attempt_id !== input.attemptId) {
      throw new Error("Provision diagnostic Attempt scope mismatch");
    }
    const previous = state[REF];
    if (previous !== undefined) {
      if (!auditId(previous)) throw new Error("Invalid provision diagnostic reference");
      return previous;
    }
    const id = await recordDurableSystemAudit({ action: "job.provision_failed", projectId: input.projectId,
      resourceType: "job", resourceId: input.jobId, result: "error", errorCode: "SANDBOX_PROVISION_FAILED",
      after: { schema: SCHEMA, attempt_id: input.attemptId, ...diagnostic } }, tx as unknown as typeof sql);
    const next = { ...state, [REF]: id };
    assertBoundedJson(next, "attempt state", ATTEMPT_MAX_STATE_BYTES);
    await tx`UPDATE job_attempts SET state_json=${tx.json(next as never)}, updated_at=now()
      WHERE id=${input.attemptId} AND job_id=${input.jobId}`;
    return id;
  });
}

/** Primary-key lookups only, and every reference is rebound to the actual project/Job/Attempt. */
export async function readProvisionFailureEvidence(db: typeof sql, jobId: string, projectId: string,
  attempts: Array<Record<string, unknown>>) {
  const refs = new Map<string, string>();
  for (const attempt of attempts) {
    const ref = record(attempt.state_json)?.[REF];
    if (auditId(ref)) refs.set(ref, String(attempt.id));
    if (refs.size >= READ_LIMIT) break;
  }
  if (!refs.size) return [];
  const rows = await db`SELECT id, at, after_json FROM audit_logs
    WHERE id IN ${db([...refs.keys()])} AND actor_type='system' AND actor_id='scheduler'
      AND action='job.provision_failed' AND result='error' AND error_code='SANDBOX_PROVISION_FAILED'
      AND project_id=${projectId} AND resource_type='job' AND resource_id=${jobId}
    ORDER BY id DESC LIMIT ${READ_LIMIT}`;
  return rows.flatMap(row => {
    const payload = record(row.after_json), diagnostic = projectProvisionFailure(payload);
    const expectedAttempt = refs.get(String(row.id));
    if (!diagnostic || payload?.schema !== SCHEMA || payload.attempt_id !== expectedAttempt) return [];
    return [{ schema: SCHEMA, source: "scheduler_audit", audit_id: String(row.id),
      attempt_id: expectedAttempt, observed_at: row.at, evidence_scope: "structured_host_diagnostic", ...diagnostic }];
  });
}
