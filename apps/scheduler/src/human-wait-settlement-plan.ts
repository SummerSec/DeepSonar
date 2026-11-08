/**
 * Pure decisions for the exact `agent_run` effect behind a waiting_human Job.
 * No runtime imports: this module must stay loadable in isolation so the
 * recovery gates can be behaviour-tested without a database or a sandbox host.
 */
import type { SandboxRunner } from "@deepsonar/runtime-sandbox";

type ListedResources = Awaited<ReturnType<SandboxRunner["listResources"]>>;

export interface HumanWaitRunInput {
  jobId: string;
  attemptId: string;
  sandboxId: string;
}

export type HumanWaitSettlementResult =
  | { outcome: "settled" }
  | { outcome: "already-settled" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "blocked"; reason: string };

export interface HumanWaitSettlementState {
  input: HumanWaitRunInput;
  canvasLocked: boolean;
  locatorCanvasId?: unknown;
  job?: { status: string; canvas_id: unknown; sandbox_id: unknown } | null;
  attempt?: {
    id: unknown; attempt_no: unknown; status: string;
    cancel_requested: unknown; sandbox_id: unknown;
  } | null;
  humanEventId?: unknown;
  effect?: { status: string } | null;
  effectId: string;
}

export type HumanWaitSettlementPlan =
  | { action: "settle"; effectId: string; humanEventId: string }
  | { action: "already-settled" }
  | { action: "skip"; reason: string };

/**
 * This never relaxes the Job-wide `status <> 'settled'` admission gate: an
 * unknown, foreign, cancelled or still-in-flight effect stays unresolved.
 */
export function planHumanWaitSettlement(state: HumanWaitSettlementState): HumanWaitSettlementPlan {
  const { input } = state;
  const skip = (reason: string): HumanWaitSettlementPlan => ({ action: "skip", reason });
  if (!state.canvasLocked) return skip("canvas convergence lock unavailable");
  const job = state.job;
  if (!job) return skip("job missing");
  if (String(job.canvas_id) !== String(state.locatorCanvasId)) return skip("canvas owner changed");
  if (job.status !== "waiting_human") return skip("job is not waiting_human");
  if (String(job.sandbox_id) !== input.sandboxId) return skip("job sandbox changed");
  const attempt = state.attempt;
  if (!attempt) return skip("attempt missing");
  if (String(attempt.id) !== input.attemptId) return skip("attempt owner changed");
  if (attempt.status !== "active" || attempt.cancel_requested) return skip("attempt not active or cancelled");
  if (String(attempt.sandbox_id) !== input.sandboxId) return skip("attempt sandbox changed");
  if (state.humanEventId == null) return skip("no durable human event");
  const effect = state.effect;
  if (!effect) return skip("no exact run effect");
  if (effect.status === "settled") return { action: "already-settled" };
  if (effect.status !== "effect_pending") return skip("run effect is unknown or foreign");
  return { action: "settle", effectId: state.effectId, humanEventId: String(state.humanEventId) };
}

/** Conservative: any surviving provider resource keeps the run effect unresolved. */
export function humanWaitResourcesPresent(resources: ListedResources, _input: HumanWaitRunInput): boolean {
  return resources.length > 0;
}

export interface HumanWaitReconcileSummary {
  scanned: number;
  settled: number;
  alreadySettled: number;
  skipped: number;
  blocked: number;
}
