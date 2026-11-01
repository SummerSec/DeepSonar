import { contentSha256 } from "./criterion-model.js";

/** Saved task input identity. Scheduler convergence bookkeeping is not a new user scope. */
export function taskInputSha256(title: unknown, target: unknown): string {
  const input = target && typeof target === "object" && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) } : {};
  delete input.convergence;
  // Objective and scheduler execution projections are control metadata. They
  // are versioned separately and must not make an unchanged user task input
  // look stale (or allow a new Plan key to reset its lifetime budget).
  delete input.plan_objective;
  delete input.plan_execution;
  return contentSha256({ title, target: input });
}
