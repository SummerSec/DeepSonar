/**
 * Pure Job lifecycle policy.
 *
 * This module deliberately has no Scheduler, database, or bounded-context
 * imports.  It is the one place that describes which Job status transitions
 * are legal; persistence and side effects belong to the application seam.
 */

export const JOB_STATUSES = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
  "failed",
  "timeout",
  "orphan",
  "succeeded",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses from which a job may be resumed/re-enqueued. */
export const RESUMABLE_JOB_STATUSES = ["failed", "timeout", "orphan", "waiting_human"] as const;

/** Statuses after which no further Job transition is legal. */
export const TERMINAL_JOB_STATUSES = ["succeeded", "cancelled"] as const;

export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

/**
 * The persisted Job state machine (§3.3).
 *
 * Keep terminal statuses in the map with an empty outgoing list.  That makes
 * the matrix exhaustive and lets tests prove that late/duplicate completion
 * events cannot revive a terminal Job.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  pending: ["claimed", "cancelled"],
  claimed: ["provisioning", "cancelled", "failed"],
  provisioning: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "timeout", "orphan", "cancelled", "waiting_human"],
  waiting_human: ["pending", "cancelled", "failed"],
  failed: ["pending"],
  timeout: ["pending"],
  orphan: ["pending"],
  succeeded: [],
  cancelled: [],
};

/** Return true only for a known, legal edge in the persisted state machine. */
export function canTransition(from: string, to: string): boolean {
  return (JOB_TRANSITIONS[from as JobStatus] ?? []).includes(to as JobStatus);
}

/** Return the legal source states for a target status in stable matrix order. */
export function allowedSourcesForTarget(to: string): readonly JobStatus[] {
  return JOB_STATUSES.filter((from) => JOB_TRANSITIONS[from].includes(to as JobStatus));
}

export function isKnownJobStatus(status: string): status is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(status);
}

export function isTerminalJobStatus(status: string): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * Build the persistence-independent part of an atomic transition.  The
 * application seam uses this to reject an unknown target before issuing SQL.
 */
export interface JobTransitionPlan {
  to: string;
  allowedFrom: readonly JobStatus[];
  patch: Readonly<Record<string, unknown>>;
}

export function planJobTransition(to: string, patch: Record<string, unknown> = {}): JobTransitionPlan {
  const allowedFrom = allowedSourcesForTarget(to);
  if (allowedFrom.length === 0) throw new Error(`非法目标状态: ${to}`);
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    throw new Error("Job transition patch must not include status; pass the target status separately");
  }
  return { to, allowedFrom, patch };
}
