import type { sql } from "./db.js";
import { readCompletionExecutionState } from "./domains/platform-api/completion-state.js";

export type PiRecoveryPermission = { allowed: boolean; reason?: string };
type ExecutionState = Awaited<ReturnType<typeof readCompletionExecutionState>>;
type LocalTerminal = { done: unknown; human: unknown; prepared: boolean };

/** Reuse the existing completion/repair authority; never grant new budgets or replay. */
export function piRecoveryPermission(state: ExecutionState, attemptId: string): PiRecoveryPermission {
  if (!attemptId.trim()) return { allowed: false, reason: "attempt_identity_missing" };
  if (!state) return { allowed: false, reason: "inactive" };
  if (state.accepted_terminal === "human") return { allowed: false, reason: "waiting_human" };
  if (state.accepted_terminal === "done") return { allowed: false, reason: "completion_accepted" };
  if (state.blocker === "effects_require_reconciliation") return { allowed: false, reason: "unknown_external_effect" };
  if (state.blocker === "repair_deadline_exhausted" || state.status === "timeout") return { allowed: false, reason: "timeout" };
  if (state.blocker === "repair_budget_exhausted") return { allowed: false, reason: "budget_exhausted" };
  if (state.status === "cancelled") return { allowed: false, reason: "cancelled" };
  if (state.active_attempt_id && state.active_attempt_id !== attemptId) return { allowed: false, reason: "attempt_identity_mismatch" };
  return state.active_attempt_id === attemptId && state.status === "running" && state.blocker === null && state.allowed_actions.includes("correct_proposal")
    ? { allowed: true } : { allowed: false, reason: "inactive" };
}

export function createPiRuntimeRecoveryGuard(
  db: typeof sql, jobId: string, attemptId: string, localTerminal: () => LocalTerminal,
): () => Promise<PiRecoveryPermission> {
  const local = (): PiRecoveryPermission | undefined => {
    const state = localTerminal();
    if (state.human) return { allowed: false, reason: "waiting_human" };
    if (state.done) return { allowed: false, reason: "completion_accepted" };
    if (state.prepared) return { allowed: false, reason: "terminal_prepared" };
    return undefined;
  };
  return async () => {
    const terminal = local();
    if (terminal) return terminal;
    if (!attemptId.trim()) return { allowed: false, reason: "attempt_identity_missing" };
    const state = await readCompletionExecutionState(db, jobId);
    // A terminal callback may have committed while the SQL projection was read.
    return local() ?? piRecoveryPermission(state, attemptId);
  };
}
