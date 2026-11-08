/**
 * #874 P0-3: periodic effect reconciliation inside the Scheduler.
 *
 * `runEffectReconcile` already settles what the evidence proves, but its only caller
 * was the host-side stdin CLI that gates platform upgrades. A Job stuck on an
 * `unknown` effect therefore had no path forward unless an operator remembered to run
 * an upgrade command — and nothing did, so completed work died at the Reaper.
 *
 * This loop is the runtime entry point. Semantics are unchanged: only `auto`
 * classifications are settled, `undecided` rows keep their `unknown` status, and
 * nothing is replayed. Each pass uses an `operation_id` prefixed with
 * `runtime-reconcile:` so runtime reconciliation stays distinguishable from the
 * upgrade-time CLI in the audit trail.
 */
import type { MigrationConnection } from "./migration-runner.js";
import { runEffectReconcile, type ReconcileResult } from "./domains/job-attempt/reconcile-effects-runner.js";

export const DEFAULT_EFFECT_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_EFFECT_RECONCILE_LIMIT = 500;

export type EffectReconcileLoopOptions = {
  db: MigrationConnection;
  intervalMs?: number;
  limit?: number;
  /** Monotonic operation sequence; tests inject their own. */
  nextOperationId?: () => string;
  onResult?: (result: ReconcileResult, operationId: string) => void;
  onError?: (error: unknown) => void;
  /** Existing host cleanup, retried without replaying Agent/model effects. */
  humanWaitReconcile?: () => Promise<unknown>;
};

export interface EffectReconcileLoop {
  /** Run one pass immediately; resolves with the result or null on error. */
  runOnce: () => Promise<ReconcileResult | null>;
  stop: () => void;
}

function sanitizedOperationId(sequence: number): string {
  // `operation_id` must match /^[A-Za-z0-9._:-]{1,128}$/.
  return `runtime-reconcile:${Date.now()}:${sequence}`;
}

export function startEffectReconcileLoop(options: EffectReconcileLoopOptions): EffectReconcileLoop {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_EFFECT_RECONCILE_INTERVAL_MS);
  const limit = options.limit ?? DEFAULT_EFFECT_RECONCILE_LIMIT;
  const nextOperationId = options.nextOperationId ?? (() => sanitizedOperationId(++sequence));
  let sequence = 0;
  let stopped = false;
  let running = false;

  const runOnce = async (): Promise<ReconcileResult | null> => {
    if (stopped || running) return null;
    running = true;
    const operationId = nextOperationId();
    try {
      let result: ReconcileResult | null = null;
      try {
        result = await runEffectReconcile(options.db, { action: "apply", operation_id: operationId, limit });
        options.onResult?.(result, operationId);
      } catch (error) {
        options.onError?.(error);
      }
      // Independent pass, even if generic effect reconciliation failed. It
      // uses exact-owner destroy, never an incomplete list as exit evidence.
      try { await options.humanWaitReconcile?.(); }
      catch (error) { options.onError?.(error); }
      return result;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
