import type { RuntimeProcessObservation } from "@deepsonar/runtime-sandbox";
import { recordDurableSystemAudit } from "./audit.js";
import { sql } from "./db.js";
import { assertBoundedJson } from "./domains/job-attempt/model.js";
import { inc } from "./metrics.js";

export const PROCESS_OBSERVATION_SCHEMA = "deepsonar.runtime-process/v1";
const TERMINATIONS = ["process_exit", "transport_closed", "transport_error", "protocol_error", "host_kill", "connect_timeout", "create_error"];
const CALLERS = ["terminal_result", "pi_rpc_failure", "output_capture_failure", "runtime_exception", "transport_cleanup", "terminal_close", "unspecified_host"];
type Scope = { jobId: string; attemptId: string; sandboxId: string };

/** Host callback only. Free-form CLI diagnostic events never enter this writer. */
export async function recordRuntimeProcessEvidence(db: typeof sql, scope: Scope, observation: RuntimeProcessObservation): Promise<void> {
  const d = observation.diagnostic;
  if (d.source !== "opensandbox_pty" || !TERMINATIONS.includes(d.termination)
    || !["create", "connect", "stream"].includes(d.phase)
    || !Number.isSafeInteger(observation.process_sequence) || observation.process_sequence < 1 || observation.process_sequence > 64
    || (observation.process_id !== null && !/^[A-Za-z0-9_.:-]{1,256}$/u.test(observation.process_id))) {
    throw new Error("RUNTIME_PROCESS_OBSERVATION_INVALID");
  }
  // Persist fixed host facts. Provider close reasons, errors, URLs and commands stay out.
  const cleanup = observation.cleanup;
  if (cleanup && (!["confirmed", "http_error", "transport_error", "timeout"].includes(cleanup.outcome)
    || !Number.isFinite(Date.parse(cleanup.requested_at)) || !Number.isFinite(Date.parse(cleanup.completed_at))
    || (cleanup.http_status !== null && (!Number.isInteger(cleanup.http_status) || cleanup.http_status < 100 || cleanup.http_status > 599)))) {
    throw new Error("RUNTIME_PROCESS_CLEANUP_INVALID");
  }
  const diagnostic = { source: d.source, phase: d.phase, termination: d.termination,
    exit_code: d.exit_frame?.valid === true && Number.isSafeInteger(d.exit_frame.exit_code) ? d.exit_frame.exit_code : null,
    exit_observed_after_termination: d.exit_frame?.observed_after_termination ?? null,
    websocket_close_code: Number.isInteger(d.websocket_close?.code) ? d.websocket_close!.code : null,
    host_kill_requested: d.host_kill_requested === true,
    host_kill_caller: CALLERS.includes(d.host_kill_caller ?? "") ? d.host_kill_caller : null,
    close_requested: d.close_requested === true,
    cleanup: cleanup ? { outcome: cleanup.outcome, http_status: cleanup.http_status,
      requested_at: cleanup.requested_at, completed_at: cleanup.completed_at } : null };
  const recorded = await db.begin(async tx => {
    const [job] = await tx`SELECT project_id,sandbox_id FROM jobs WHERE id=${scope.jobId} FOR UPDATE`;
    const [attempt] = await tx`SELECT id,sandbox_id,attempt_no FROM job_attempts
      WHERE id=${scope.attemptId} AND job_id=${scope.jobId} FOR UPDATE`;
    if (!job || !attempt || attempt.sandbox_id !== scope.sandboxId) throw new Error("RUNTIME_PROCESS_OWNER_MISMATCH");
    const [effect] = await tx`SELECT id,effect_id,intent_json FROM job_attempt_effects
      WHERE job_id=${scope.jobId} AND attempt_id=${scope.attemptId} AND effect_kind='agent_run'
        AND effect_id=${`agent_run:${Number(attempt.attempt_no)}`}
        AND resource_identity_json->>'sandbox_id'=${scope.sandboxId} FOR UPDATE`;
    if (!effect) throw new Error("RUNTIME_PROCESS_EFFECT_MISMATCH");
    const intent = effect.intent_json as Record<string, unknown>;
    const refs = Array.isArray(intent.host_process_audits) ? intent.host_process_audits as Array<{ sequence: number; process_id: string | null; audit_id: string }> : [];
    const previous = refs.find(ref => ref.sequence === observation.process_sequence);
    if (previous) {
      if (previous.process_id !== observation.process_id) throw new Error("RUNTIME_PROCESS_ID_CHANGED");
      return false;
    }
    if (refs.length >= 64) throw new Error("RUNTIME_PROCESS_OBSERVATION_LIMIT");
    const after = { schema: PROCESS_OBSERVATION_SCHEMA, job_id: scope.jobId, attempt_id: scope.attemptId,
      sandbox_id: scope.sandboxId, effect_id: effect.effect_id, process_sequence: observation.process_sequence,
      process_id: observation.process_id, observed_at: new Date().toISOString(), ...diagnostic };
    assertBoundedJson(after, "runtime process evidence", 4096);
    const id = await recordDurableSystemAudit({ action: "job.runtime_process", projectId: String(job.project_id),
      resourceType: "job", resourceId: scope.jobId, after }, tx as unknown as typeof sql);
    await tx`UPDATE job_attempt_effects SET intent_json=intent_json || ${tx.json({ host_process_audits:
      [...refs, { sequence: observation.process_sequence, process_id: observation.process_id, audit_id: id }] } as never)},
      updated_at=clock_timestamp() WHERE id=${effect.id}`;
    return true;
  });
  if (recorded) inc("deepsonar_runtime_process_terminations_total", { termination: d.termination,
    caller: diagnostic.host_kill_caller ?? "none", cleanup: cleanup?.outcome ?? "unobserved" });
}

/** Read exact audit references through the owning effect, never scan untrusted stream text. */
export async function readRuntimeProcessEvidence(db: typeof sql, jobId: string, projectId: string) {
  return db`SELECT l.id::text AS audit_id,l.at AS observed_at,l.after_json AS observation,
    cleanup.after_json AS sandbox_cleanup
    FROM job_attempt_effects e JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.intent_json->'host_process_audits')='array'
        THEN e.intent_json->'host_process_audits' ELSE '[]'::jsonb END) ref ON true
    JOIN audit_logs l ON l.id::text=ref->>'audit_id'
    LEFT JOIN audit_logs cleanup ON cleanup.id::text=e.intent_json->>'host_cleanup_audit_id'
      AND cleanup.actor_type='system' AND cleanup.actor_id='scheduler' AND cleanup.action='job.runtime_cleanup'
      AND cleanup.project_id=${projectId} AND cleanup.resource_type='job' AND cleanup.resource_id=${jobId}
      AND cleanup.after_json->>'schema'='deepsonar.runtime-cleanup/v1'
      AND cleanup.after_json->>'job_id'=e.job_id::text AND cleanup.after_json->>'attempt_id'=e.attempt_id::text
      AND cleanup.after_json->>'effect_id'=e.effect_id AND cleanup.after_json->>'sandbox_id'=e.resource_identity_json->>'sandbox_id'
    WHERE e.job_id=${jobId} AND e.effect_kind='agent_run'
      AND l.project_id=${projectId} AND l.resource_type='job' AND l.resource_id=${jobId}
      AND l.actor_type='system' AND l.actor_id='scheduler' AND l.action='job.runtime_process'
      AND l.after_json->>'schema'=${PROCESS_OBSERVATION_SCHEMA}
      AND l.after_json->>'job_id'=e.job_id::text
      AND l.after_json->>'attempt_id'=e.attempt_id::text AND l.after_json->>'effect_id'=e.effect_id
      AND l.after_json->>'sandbox_id'=e.resource_identity_json->>'sandbox_id'
      AND l.after_json->>'process_sequence'=ref->>'sequence'
      AND l.after_json->'process_id'=ref->'process_id'
    ORDER BY l.id DESC LIMIT 64`;
}
