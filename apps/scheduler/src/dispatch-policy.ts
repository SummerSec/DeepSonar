/**
 * Pure dispatch admission policy used by the DB-backed claim loop.
 *
 * Keeping this check free of postgres/config imports makes the concurrency
 * contract executable in a no-DB smoke test as well as in the dispatcher.
 */
export type DispatchBlockReason = "global" | "project" | "agent_cli";

export interface DispatchConcurrencyState {
  totalActive: number;
  projectActive: number;
  cliActive: number;
  globalLimit: number;
  projectLimit: number;
  cliLimit?: number;
}

export interface DispatchConcurrencyDecision {
  allowed: boolean;
  blockedBy?: DispatchBlockReason;
}

export function dispatchConcurrencyDecision(
  state: DispatchConcurrencyState,
): DispatchConcurrencyDecision {
  if (state.totalActive >= state.globalLimit) return { allowed: false, blockedBy: "global" };
  if (state.projectActive >= state.projectLimit) return { allowed: false, blockedBy: "project" };
  if (state.cliLimit !== undefined && state.cliActive >= state.cliLimit) {
    return { allowed: false, blockedBy: "agent_cli" };
  }
  return { allowed: true };
}

/** Parse a persisted/env limit while preserving an explicit zero pause value. */
export function parseNonNegativeLimit(value: unknown, fallback: number, max = 10_000): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}
