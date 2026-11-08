import type { SandboxRunner } from "@deepsonar/runtime-sandbox";
import { lockCanvasForConvergence } from "./core.js";
import { sql } from "./db.js";
import { settleEffect } from "./domains/job-attempt/application.js";

/** Host-only close: a wait label or an interrupted Attempt is not proof that the run stopped. */
export async function destroyAndSettleHumanWaitRun(
  db: typeof sql,
  runner: Pick<SandboxRunner, "destroy">,
  input: { jobId: string; attemptId: string; sandboxId: string },
): Promise<void> {
  // OpenSandbox destroy also waits for disappearance. Failure must leave the effect unresolved.
  await runner.destroy({ sandboxId: input.sandboxId });
  await db.begin(async txRaw => {
    const tx = txRaw as unknown as typeof sql;
    const [locator] = await tx`SELECT canvas_id FROM jobs WHERE id=${input.jobId}`;
    if (!locator || !await lockCanvasForConvergence(tx, locator.canvas_id)) return;
    const [job] = await tx`SELECT status,canvas_id,sandbox_id FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
    if (!job || job.canvas_id !== locator.canvas_id || job.status !== "waiting_human"
      || job.sandbox_id !== input.sandboxId) return;
    const [attempt] = await tx`SELECT id,attempt_no,status,cancel_requested,sandbox_id FROM job_attempts
      WHERE job_id=${input.jobId} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
    if (!attempt || String(attempt.id) !== input.attemptId || attempt.status !== "active"
      || attempt.cancel_requested || attempt.sandbox_id !== input.sandboxId) return;
    const [human] = await tx`SELECT event_id FROM events WHERE job_id=${input.jobId}
      AND attempt_id=${input.attemptId} AND type='human' ORDER BY job_seq DESC LIMIT 1`;
    if (!human) return;
    const effectId = `agent_run:${Number(attempt.attempt_no)}`;
    const [effect] = await tx`SELECT id FROM job_attempt_effects WHERE job_id=${input.jobId}
      AND attempt_id=${input.attemptId} AND effect_id=${effectId} AND effect_kind='agent_run'
      AND status='effect_pending' AND resource_identity_json->>'sandbox_id'=${input.sandboxId} FOR UPDATE`;
    if (!effect) return; // Never reinterpret an unknown, foreign or already settled effect.
    await settleEffect(tx, input.attemptId, effectId, { status: "settled", outcome: {
      result: "applied_run_terminated", reconciled_by: "dispatcher-human-wait-cleanup",
      sandbox_id: input.sandboxId, human_event_id: String(human.event_id), sandbox_destroyed: true,
    } });
    // Keep the waiting Job/Attempt and all Gateway usage unchanged until authorized recovery.
  });
}
