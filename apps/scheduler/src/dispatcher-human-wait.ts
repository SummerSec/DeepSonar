import type { SandboxRunner } from "@deepsonar/runtime-sandbox";
import { lockCanvasForConvergence } from "./core.js";
import { sql } from "./db.js";
import { settleEffect } from "./domains/job-attempt/application.js";
import { revokeOldRuntimeGrants } from "./domains/job-control/rerun.js";
import {
  humanWaitResourcesPresent,
  planHumanWaitSettlement,
  type HumanWaitReconcileSummary,
  type HumanWaitRunInput,
  type HumanWaitSettlementResult,
} from "./human-wait-settlement-plan.js";

export * from "./human-wait-settlement-plan.js";

/** DB-only close. The caller must already have proof that the sandbox disappeared. */
export async function settleConfirmedHumanWaitRun(
  db: typeof sql,
  input: HumanWaitRunInput,
): Promise<HumanWaitSettlementResult> {
  let result: HumanWaitSettlementResult = { outcome: "skipped", reason: "not evaluated" };
  await db.begin(async txRaw => {
    const tx = txRaw as unknown as typeof sql;
    const [locator] = await tx`SELECT canvas_id FROM jobs WHERE id=${input.jobId}`;
    const canvasLocked = !!locator && !!(await lockCanvasForConvergence(tx, locator.canvas_id));
    const [job] = await tx`SELECT status,canvas_id,sandbox_id FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
    const [attempt] = await tx`SELECT id,attempt_no,status,cancel_requested,sandbox_id FROM job_attempts
      WHERE job_id=${input.jobId} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
    const [human] = await tx`SELECT event_id FROM events WHERE job_id=${input.jobId}
      AND attempt_id=${input.attemptId} AND type='human' ORDER BY job_seq DESC LIMIT 1`;
    const effectId = attempt ? `agent_run:${Number(attempt.attempt_no)}` : "";
    const [effect] = await tx`SELECT status FROM job_attempt_effects WHERE job_id=${input.jobId}
      AND attempt_id=${input.attemptId} AND effect_id=${effectId} AND effect_kind='agent_run'
      AND resource_identity_json->>'sandbox_id'=${input.sandboxId} FOR UPDATE`;
    const plan = planHumanWaitSettlement({
      input, canvasLocked, locatorCanvasId: locator?.canvas_id, effectId,
      humanEventId: human?.event_id,
      job: job ? { status: String(job.status), canvas_id: job.canvas_id, sandbox_id: job.sandbox_id } : null,
      attempt: attempt ? {
        id: attempt.id, attempt_no: attempt.attempt_no, status: String(attempt.status),
        cancel_requested: attempt.cancel_requested, sandbox_id: attempt.sandbox_id,
      } : null,
      effect: effect ? { status: String(effect.status) } : null,
    });
    if (plan.action === "already-settled") { result = { outcome: "already-settled" }; return; }
    if (plan.action === "skip") { result = { outcome: "skipped", reason: plan.reason }; return; }
    await revokeOldRuntimeGrants(tx, input.jobId, "dispatcher-human-wait-cleanup");
    const settled = await settleEffect(tx, input.attemptId, plan.effectId, { status: "settled", outcome: {
      result: "applied_run_terminated", reconciled_by: "dispatcher-human-wait-cleanup",
      sandbox_id: input.sandboxId, human_event_id: plan.humanEventId, sandbox_destroyed: true,
      runtime_grants_revoked: true,
    } });
    if (!settled) throw new Error("HUMAN_WAIT_RUN_SETTLEMENT_CHANGED");
    // Keep the waiting Job/Attempt and all historical counters and usage unchanged.
    result = { outcome: "settled" };
  });
  return result;
}

/** Host-only close: a wait label or an interrupted Attempt is not proof that the run stopped. */
export async function destroyAndSettleHumanWaitRun(
  db: typeof sql,
  runner: Pick<SandboxRunner, "destroy">,
  input: HumanWaitRunInput,
): Promise<HumanWaitSettlementResult> {
  // OpenSandbox destroy also waits for disappearance. Failure must leave the effect unresolved.
  await runner.destroy({ sandboxId: input.sandboxId });
  return settleConfirmedHumanWaitRun(db, input);
}

/**
 * Replay after a crash between a successful destroy and the settlement commit.
 * Requiring provider-backed disappearance keeps the Job-wide unresolved-effect
 * gate intact: a run that is still in flight must never be replayed into settled.
 */
export async function replayHumanWaitRunSettlement(
  db: typeof sql,
  runner: Pick<SandboxRunner, "listResources">,
  input: HumanWaitRunInput,
): Promise<HumanWaitSettlementResult> {
  const resources = await runner.listResources({ jobId: input.jobId, attemptId: input.attemptId });
  if (humanWaitResourcesPresent(resources, input)) {
    return { outcome: "blocked", reason: "provider still lists resources for the waiting attempt" };
  }
  return settleConfirmedHumanWaitRun(db, input);
}

/**
 * Periodic compensation for the lost-commit window. Unlike the generic effect
 * reconciler, this deliberately scans active Attempts behind a waiting_human Job —
 * but only the exact `agent_run:<attempt_no>` effect with a durable human event,
 * and replay still requires provider-backed disappearance. Every other unknown
 * effect stays outside this path and keeps blocking admission.
 */
export async function reconcileHumanWaitRuns(
  db: typeof sql,
  runner: Pick<SandboxRunner, "listResources">,
  limit = 100,
): Promise<HumanWaitReconcileSummary> {
  const rows = await db`SELECT j.id::text AS job_id, a.id::text AS attempt_id, j.sandbox_id::text AS sandbox_id
    FROM jobs j
    JOIN LATERAL (SELECT id, attempt_no FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a ON true
    WHERE j.status='waiting_human' AND j.sandbox_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM events e WHERE e.job_id=j.id AND e.attempt_id=a.id AND e.type='human')
      AND EXISTS (SELECT 1 FROM job_attempt_effects x WHERE x.job_id=j.id AND x.attempt_id=a.id
        AND x.effect_id='agent_run:' || a.attempt_no AND x.effect_kind='agent_run'
        AND x.status='effect_pending' AND x.resource_identity_json->>'sandbox_id'=j.sandbox_id)
    LIMIT ${limit}`;
  const summary: HumanWaitReconcileSummary = {
    scanned: rows.length, settled: 0, alreadySettled: 0, skipped: 0, blocked: 0,
  };
  for (const row of rows) {
    const result = await replayHumanWaitRunSettlement(db, runner, {
      jobId: String(row.job_id), attemptId: String(row.attempt_id), sandboxId: String(row.sandbox_id),
    });
    if (result.outcome === "settled") summary.settled += 1;
    else if (result.outcome === "already-settled") summary.alreadySettled += 1;
    else if (result.outcome === "blocked") summary.blocked += 1;
    else summary.skipped += 1;
  }
  return summary;
}
