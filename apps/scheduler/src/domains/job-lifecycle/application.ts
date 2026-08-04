import { sql } from "../../db.js";
import { planJobTransition, type JobTransitionPlan } from "./transition-policy.js";

/** Minimal row shape returned by the atomic Job status update. */
export type JobTransitionRow = Record<string, unknown>;

export interface JobTransitionRequest extends JobTransitionPlan {
  jobId: string;
}

/**
 * Persistence callback for the lifecycle application seam.
 *
 * The callback owns the transaction/connection.  The lifecycle application
 * only supplies the policy-approved target, source guard, and patch, making
 * the transition behavior testable without a PostgreSQL process.
 */
export type JobTransitionExecutor = (request: JobTransitionRequest) => Promise<JobTransitionRow | null>;

export interface JobLifecycleApplication {
  transitionJob(
    jobId: string,
    to: string,
    patch?: Record<string, unknown>,
  ): Promise<JobTransitionRow | null>;
}

export function createJobLifecycleApplication(execute: JobTransitionExecutor): JobLifecycleApplication {
  return {
    async transitionJob(jobId, to, patch = {}) {
      const plan = planJobTransition(to, patch);
      return execute({ jobId, ...plan });
    },
  };
}

/**
 * PostgreSQL adapter for the application seam.  The `WHERE status = ANY(...)`
 * guard remains the linearization point: a concurrent claim/reaper/finalize
 * wins the race and this call returns null without running follow-up work.
 */
export function createSqlJobLifecycleApplication(db: typeof sql = sql): JobLifecycleApplication {
  return createJobLifecycleApplication(async ({ jobId, to, allowedFrom, patch }) => {
    // Preserve the compatibility facade's historical merge order.  A supplied
    // `status` key can therefore override `to`; this is a documented follow-up
    // hardening item, and current internal callers never pass that key.
    const sets = { status: to, ...patch };
    const [row] = await db`
      UPDATE jobs SET ${db(sets)}
      WHERE id = ${jobId} AND status = ANY(${allowedFrom})
      RETURNING id, status`;
    return row ? (row as JobTransitionRow) : null;
  });
}

const defaultApplication = createSqlJobLifecycleApplication();

/** Scheduler-compatible application entry point. */
export async function transitionJob(
  jobId: string,
  to: string,
  patch: Record<string, unknown> = {},
): Promise<JobTransitionRow | null> {
  return defaultApplication.transitionJob(jobId, to, patch);
}
