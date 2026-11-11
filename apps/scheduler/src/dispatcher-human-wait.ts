import type { SandboxRunner } from "@deepsonar/runtime-sandbox";
import { lockCanvasForConvergence } from "./core.js";
import { sql } from "./db.js";
import { markAttemptInterrupted, settleEffect } from "./domains/job-attempt/application.js";
import { revokeOldRuntimeGrants } from "./domains/job-control/rerun.js";
import { pauseHumanExecutionClock } from "./domains/job-control/human-continuation-clock.js";

/** Preserve ordinary finally cleanup; a refused human-wait close is never a fallback authorization. */
export async function cleanupDispatcherSandbox(
  db: typeof sql,
  runner: Pick<SandboxRunner, "destroy">,
  input: { jobId: string; attemptId?: string | null; sandboxId: string },
): Promise<void> {
  const [job] = await db`SELECT status FROM jobs WHERE id=${input.jobId}`;
  if (job?.status === "waiting_human") {
    if (input.attemptId) await destroyAndSettleHumanWaitRun(db, runner, { ...input, attemptId: input.attemptId });
    return;
  }
  await runner.destroy({ sandboxId: input.sandboxId });
  if (input.attemptId) await pauseHumanExecutionClock(db,input.jobId,input.attemptId);
}

/** Host-only close: a wait label or an interrupted Attempt is not proof that the run stopped. */
export async function destroyAndSettleHumanWaitRun(
  db: typeof sql,
  runner: Pick<SandboxRunner, "destroy">,
  input: { jobId: string; attemptId: string; sandboxId: string },
): Promise<boolean> {
  return db.begin(async txRaw => {
    const tx = txRaw as unknown as typeof sql;
    const [locator] = await tx`SELECT canvas_id FROM jobs WHERE id=${input.jobId}`;
    if (!locator || !await lockCanvasForConvergence(tx, locator.canvas_id)) return false;
    const [job] = await tx`SELECT status,canvas_id,sandbox_id FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
    if (!job || job.canvas_id !== locator.canvas_id || job.status !== "waiting_human"
      || job.sandbox_id !== input.sandboxId) return false;
    const [attempt] = await tx`SELECT id,attempt_no,status,cancel_requested,sandbox_id FROM job_attempts
      WHERE job_id=${input.jobId} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
    if (!attempt || String(attempt.id) !== input.attemptId || attempt.status !== "active"
      || attempt.cancel_requested || attempt.sandbox_id !== input.sandboxId) return false;
    const [human] = await tx`SELECT event_id FROM events WHERE job_id=${input.jobId}
      AND attempt_id=${input.attemptId} AND type='human' ORDER BY job_seq DESC LIMIT 1`;
    if (!human) return false;
    const effectId = `agent_run:${Number(attempt.attempt_no)}`;
    const [effect] = await tx`SELECT id FROM job_attempt_effects WHERE job_id=${input.jobId}
      AND attempt_id=${input.attemptId} AND effect_id=${effectId} AND effect_kind='agent_run'
      AND status='effect_pending' AND resource_identity_json->>'sandbox_id'=${input.sandboxId} FOR UPDATE`;
    if (!effect) return false; // Never reinterpret an unknown, foreign or already settled effect.
    const [lease] = await tx`SELECT job_id,attempt_id FROM worker_sandbox_leases
      WHERE sandbox_id=${input.sandboxId} FOR UPDATE`;
    if (lease && ((lease.job_id !== null && lease.job_id !== input.jobId)
      || (lease.attempt_id !== null && lease.attempt_id !== input.attemptId))) return false;
    // Keep the original owner fenced through bounded destruction and settlement.
    // The worker registry retains this pending wait lease, so its release path
    // does not delete/lock the lease from another connection while we hold it.
    // A failed destroy or SQL commit rolls back all database changes, not the IO.
    await runner.destroy({ sandboxId: input.sandboxId });
    await revokeOldRuntimeGrants(tx, input.jobId, "dispatcher-human-wait-cleanup");
    const settled = await settleEffect(tx, input.attemptId, effectId, { status: "settled", outcome: {
      result: "applied_run_terminated", reconciled_by: "dispatcher-human-wait-cleanup",
      sandbox_id: input.sandboxId, human_event_id: String(human.event_id), sandbox_destroyed: true,
      runtime_grants_revoked: true,
    } });
    if (!settled) throw new Error("HUMAN_WAIT_RUN_SETTLEMENT_CHANGED");
    await pauseHumanExecutionClock(tx,input.jobId,input.attemptId);
    await tx`UPDATE human_requests SET resources_released_at=now(),process_exited_at=now(),
      checkpoint_status=CASE WHEN manifest_json IS NULL THEN 'blocked' WHEN checkpoint_status='preparing' THEN 'ready' ELSE checkpoint_status END,
      checkpoint_error_code=CASE WHEN manifest_json IS NULL THEN COALESCE(checkpoint_error_code,'HUMAN_CHECKPOINT_UNAVAILABLE') ELSE checkpoint_error_code END
      WHERE job_id=${input.jobId} AND attempt_id=${input.attemptId}`;
    await markAttemptInterrupted(tx,input.jobId,"human_wait_checkpoint_sealed");
    await tx`UPDATE jobs SET sandbox_id=NULL,lease_expires_at=NULL,heartbeat_at=NULL
      WHERE id=${input.jobId} AND status='waiting_human'`;
    // Ownership must outlive a failed settlement commit, then disappear atomically
    // with the run/grants. Never release a foreign Job/Attempt's lease.
    await tx`DELETE FROM worker_sandbox_leases WHERE sandbox_id=${input.sandboxId}
      AND (job_id IS NULL OR job_id=${input.jobId})
      AND (attempt_id IS NULL OR attempt_id=${input.attemptId})`;
    // The Job stays waiting; its interrupted Attempt and cumulative usage remain historical truth.
    return true;
  });
}

/** Existing Scheduler reconciliation, not a new service or Agent replay path. */
export async function reconcileHumanWaitRuns(db: typeof sql, runner: Pick<SandboxRunner, "destroy">, limit: number, afterJobId?: string) {
  const rows = await db`SELECT j.id::text AS job_id,a.id::text AS attempt_id,j.sandbox_id
    FROM jobs j JOIN LATERAL (SELECT id,attempt_no,status,cancel_requested,sandbox_id FROM job_attempts
      WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a ON true
    WHERE j.status='waiting_human' AND j.sandbox_id IS NOT NULL
      AND a.status='active' AND NOT a.cancel_requested AND a.sandbox_id=j.sandbox_id
      AND EXISTS (SELECT 1 FROM human_requests r WHERE r.job_id=j.id AND r.attempt_id=a.id
        AND (r.manifest_json IS NOT NULL OR r.checkpoint_status='blocked'
          OR r.created_at+interval '90 seconds'<now()))
      AND EXISTS (SELECT 1 FROM events e WHERE e.job_id=j.id AND e.attempt_id=a.id AND e.type='human')
      AND EXISTS (SELECT 1 FROM job_attempt_effects x WHERE x.job_id=j.id AND x.attempt_id=a.id
        AND x.effect_kind='agent_run' AND x.effect_id='agent_run:' || a.attempt_no
        AND x.status='effect_pending' AND x.resource_identity_json->>'sandbox_id'=j.sandbox_id)
      AND NOT EXISTS (SELECT 1 FROM worker_sandbox_leases l WHERE l.sandbox_id=j.sandbox_id
        AND ((l.job_id IS NOT NULL AND l.job_id<>j.id::text) OR (l.attempt_id IS NOT NULL AND l.attempt_id<>a.id::text)))
    ORDER BY (${afterJobId ?? null}::uuid IS NOT NULL AND j.id <= ${afterJobId ?? null}::uuid), j.id LIMIT ${limit}`;
  // Advance after attempted rows even when their owners fail. Wrap in the same
  // bounded query; this cursor is traversal only, never authority or settlement.
  const result = { scanned: rows.length, settled: 0, blocked: 0,
    nextJobId: rows.length ? String(rows[rows.length - 1]!.job_id) : undefined };
  for (const row of rows) {
    try {
      const settled = await destroyAndSettleHumanWaitRun(db, runner, {
        jobId: String(row.job_id), attemptId: String(row.attempt_id), sandboxId: String(row.sandbox_id),
      });
      if (settled) result.settled++; else result.blocked++;
    } catch {
      // An unavailable owner, failed destroy or failed commit is still unresolved.
      // Continue other Jobs and report the count; the next existing tick retries.
      result.blocked++;
    }
  }
  return result;
}
