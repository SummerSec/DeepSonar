import type { SandboxRunner } from "@deepsonar/runtime-sandbox";
import { recordDurableSystemAudit } from "./audit.js";
import { lockCanvasForConvergence } from "./core.js";
import { sql } from "./db.js";
import { revokeOldRuntimeGrants } from "./domains/job-control/rerun.js";
import { pauseHumanExecutionClock } from "./domains/job-control/human-continuation-clock.js";
import { readRuntimeProcessEvidence } from "./runtime-process-evidence.js";
import { inc } from "./metrics.js";
import { lockContinuationBudget } from "./domains/job-control/continuation-budget.js";

type Owner = { jobId: string; attemptId: string; sandboxId: string };
const TERMINAL = ["succeeded", "failed", "timeout", "cancelled", "orphan"];
export const PROCESS_DESTROY_TIMEOUT_MS = 25_000;

async function lockOwner(tx: typeof sql, owner: Owner) {
  const [locator] = await tx`SELECT canvas_id FROM jobs WHERE id=${owner.jobId}`;
  if (!locator || !await lockCanvasForConvergence(tx, locator.canvas_id)) return null;
  await lockContinuationBudget(tx, owner.jobId, false);
  const [job] = await tx`SELECT project_id,status,canvas_id,sandbox_id FROM jobs WHERE id=${owner.jobId} FOR UPDATE`;
  if (!job || job.canvas_id !== locator.canvas_id || !TERMINAL.includes(String(job.status))
    || job.sandbox_id !== owner.sandboxId) return null;
  const [attempt] = await tx`SELECT id,attempt_no,status,sandbox_id FROM job_attempts
    WHERE job_id=${owner.jobId} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
  if (!attempt || String(attempt.id) !== owner.attemptId || !TERMINAL.includes(String(attempt.status))
    || attempt.status !== job.status || attempt.sandbox_id !== owner.sandboxId) return null;
  const [effect] = await tx`SELECT id,effect_id,status,settlement_json,intent_json FROM job_attempt_effects
    WHERE job_id=${owner.jobId} AND attempt_id=${owner.attemptId} AND effect_kind='agent_run'
      AND effect_id=${`agent_run:${Number(attempt.attempt_no)}`}
      AND resource_identity_json->>'sandbox_id'=${owner.sandboxId} FOR UPDATE`;
  if (!effect) return null;
  const evidence = await readRuntimeProcessEvidence(tx, owner.jobId, String(job.project_id));
  const observation = evidence.find(row => row.observation.attempt_id === owner.attemptId
    && row.observation.effect_id === effect.effect_id && row.observation.sandbox_id === owner.sandboxId);
  if (!observation) return null;
  const [lease] = await tx`SELECT job_id,attempt_id FROM worker_sandbox_leases WHERE sandbox_id=${owner.sandboxId} FOR UPDATE`;
  if (lease && (lease.job_id !== owner.jobId || lease.attempt_id !== owner.attemptId)) return null;
  return { job, attempt, effect, observation };
}

/** New host observations only. A terminal label or a PTY DELETE alone cannot settle a run. */
export async function destroyObservedRuntime(db: typeof sql, runner: Pick<SandboxRunner, "destroy">, owner: Owner,
  timeoutMs = PROCESS_DESTROY_TIMEOUT_MS): Promise<boolean> {
  // Commit the fence before IO. Worker release and orphan cleanup retain this exact
  // owner even if destroy succeeds but the final SQL commit fails or times out.
  const prepared = await db.begin(async raw => {
    const tx = raw as unknown as typeof sql;
    const state = await lockOwner(tx, owner);
    if (!state) return false;
    await revokeOldRuntimeGrants(tx, owner.jobId, "runtime-process-cleanup");
    await tx`UPDATE job_attempt_effects SET intent_json=intent_json || ${tx.json({ host_cleanup: {
      schema: "deepsonar.runtime-cleanup/v1", sandbox_id: owner.sandboxId,
      attempt_id: owner.attemptId, observation_audit_id: String(state.observation.audit_id), state: "pending",
    } })},updated_at=clock_timestamp() WHERE id=${state.effect.id}`;
    return true;
  });
  if (!prepared) return false;
  return db.begin(async raw => {
    const tx = raw as unknown as typeof sql;
    const state = await lockOwner(tx, owner);
    if (!state) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome = "confirmed";
    try {
      await Promise.race([runner.destroy({ sandboxId: owner.sandboxId }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RUNTIME_DESTROY_TIMEOUT")), timeoutMs);
      })]);
    } catch (error) {
      outcome = error instanceof Error && error.message === "RUNTIME_DESTROY_TIMEOUT" ? "timeout" : "destroy_failed";
    } finally { if (timer) clearTimeout(timer); }
    const auditId = await recordDurableSystemAudit({ action: "job.runtime_cleanup", projectId: String(state.job.project_id),
      resourceType: "job", resourceId: owner.jobId, after: { schema: "deepsonar.runtime-cleanup/v1",
        job_id: owner.jobId, attempt_id: owner.attemptId, sandbox_id: owner.sandboxId,
        effect_id: state.effect.effect_id, observation_audit_id: String(state.observation.audit_id),
        outcome, observed_at: new Date().toISOString(), automatic_recovery: "not_delivered" } }, tx);
    await tx`UPDATE job_attempt_effects SET intent_json=intent_json || ${tx.json({ host_cleanup_audit_id: auditId })},
      updated_at=clock_timestamp() WHERE id=${state.effect.id}`;
    if (outcome !== "confirmed") { inc("deepsonar_sandbox_cleanup_failed_total"); return false; }
    // Close only the untouched terminal marker produced by this exact Attempt.
    // An independently unknown effect carries different evidence and stays unknown.
    await tx`UPDATE job_attempt_effects SET status='settled',settlement_json=${tx.json({
      result: "applied_run_terminated", reconciled_by: "runtime-process-cleanup", sandbox_destroyed: true,
      runtime_grants_revoked: true, cleanup_audit_id: auditId,
    })},settled_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=${state.effect.id} AND status='unknown'
        AND settlement_json=${tx.json({ job_status: String(state.attempt.status) })}`;
    await tx`UPDATE job_attempt_effects SET intent_json=jsonb_set(intent_json,'{host_cleanup,state}','"confirmed"'::jsonb),
      updated_at=clock_timestamp() WHERE id=${state.effect.id}`;
    await pauseHumanExecutionClock(tx, owner.jobId, owner.attemptId);
    await tx`UPDATE jobs SET sandbox_id=NULL WHERE id=${owner.jobId} AND sandbox_id=${owner.sandboxId}`;
    await tx`DELETE FROM worker_sandbox_leases WHERE sandbox_id=${owner.sandboxId}
      AND job_id=${owner.jobId} AND attempt_id=${owner.attemptId}`;
    return true;
  });
}

/** Existing reconciliation tick retries only newly recorded, exactly bound cleanup fences. */
export async function reconcileObservedRuntimeCleanup(db: typeof sql, runner: Pick<SandboxRunner, "destroy">, limit: number) {
  const rows = await db`SELECT e.job_id::text,e.attempt_id::text,e.resource_identity_json->>'sandbox_id' AS sandbox_id
    FROM job_attempt_effects e JOIN jobs j ON j.id=e.job_id
    WHERE e.effect_kind='agent_run' AND jsonb_array_length(COALESCE(e.intent_json->'host_process_audits','[]'::jsonb))>0
      AND j.status IN ('succeeded','failed','timeout','cancelled','orphan')
      AND j.sandbox_id=e.resource_identity_json->>'sandbox_id'
    ORDER BY e.updated_at,e.id LIMIT ${limit}`;
  for (const row of rows) {
    try { await destroyObservedRuntime(db, runner, { jobId: row.job_id, attemptId: row.attempt_id, sandboxId: row.sandbox_id }); }
    catch { /* durable fence survives unavailable DB/owner; next existing tick retries */ }
  }
}
