import { contentSha256 } from "./criterion-model.js";

/** Saved task input identity. Scheduler convergence bookkeeping is not a new user scope. */
export function taskInputSha256(title: unknown, target: unknown): string {
  const input = target && typeof target === "object" && !Array.isArray(target)
    ? { ...(target as Record<string, unknown>) } : {};
  delete input.convergence;
  return contentSha256({ title, target: input });
}
