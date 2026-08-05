import { sql } from "../../db.js";
import { planJobTransition, type JobTransitionPlan } from "./transition-policy.js";
import type {
  JobLifecycleDatabase,
  JobLifecycleOperations,
  JobLifecycleRow,
  JobTransitionExecutor,
  JobTransitionRequest,
  JobTransitionRow,
} from "./ports.js";

export type {
  JobLifecycleDatabase,
  JobLifecycleOperations,
  JobLifecycleRow,
  JobTransitionExecutor,
  JobTransitionRequest,
  JobTransitionRow,
} from "./ports.js";

/**
 * Application methods are deliberately small CAS operations.  A caller owns
 * the transaction and passes its tagged client to `createSql...`; lifecycle
 * code therefore cannot accidentally open a second connection or reorder a
 * surrounding Canvas/Job lock sequence.
 */
export interface JobLifecycleApplication extends JobLifecycleOperations {
  transitionJob(
    jobId: string,
    to: string,
    patch?: Record<string, unknown>,
  ): Promise<JobTransitionRow | null>;
}

type LifecycleOperationOverrides = Partial<JobLifecycleOperations> & {
  transitionJob?: JobTransitionExecutor;
};

function missingOperation(name: string): never {
  throw new Error(`Job lifecycle operation is not configured: ${name}`);
}

/**
 * Build an application seam around test doubles or explicit ports.  The
 * historical `createJobLifecycleApplication(executor)` form remains valid so
 * existing policy/unit tests can stay persistence-free.
 */
export function createJobLifecycleApplication(
  overridesOrExecutor: JobTransitionExecutor | LifecycleOperationOverrides,
): JobLifecycleApplication {
  const overrides: LifecycleOperationOverrides =
    typeof overridesOrExecutor === "function"
      ? { transitionJob: overridesOrExecutor }
      : overridesOrExecutor;
  const transitionExecutor = overrides.transitionJob;
  const requireOperation = <K extends keyof JobLifecycleOperations>(name: K) => {
    const operation = overrides[name];
    return operation ?? ((..._args: never[]) => missingOperation(String(name))) as unknown as JobLifecycleOperations[K];
  };
  return {
    async transitionJob(jobId, to, patch = {}) {
      if (!transitionExecutor) return missingOperation("transitionJob");
      const plan = planJobTransition(to, patch);
      return transitionExecutor({ jobId, ...plan });
    },
    claimPendingJob: requireOperation("claimPendingJob"),
    failExecution: requireOperation("failExecution"),
    reapExecutionTimeout: requireOperation("reapExecutionTimeout"),
    reapProvisionTimeout: requireOperation("reapProvisionTimeout"),
    reapLeaseOrphans: requireOperation("reapLeaseOrphans"),
    reconcileProvisioning: requireOperation("reconcileProvisioning"),
    reconcileRunning: requireOperation("reconcileRunning"),
    cancelJob: requireOperation("cancelJob"),
    cancelJobsOnCanvas: requireOperation("cancelJobsOnCanvas"),
    cancelJobsForRuntimeImageVersion: requireOperation("cancelJobsForRuntimeImageVersion"),
  };
}

function rows(value: readonly JobLifecycleRow[]): JobLifecycleRow[] {
  return value.map((row) => row as JobLifecycleRow);
}

/**
 * PostgreSQL adapter for all lifecycle-owned status writers.  Every method
 * keeps its caller's original source-state CAS and metadata patch.  The three
 * recovery operations intentionally model legacy policy exceptions:
 * Reaper's timeout covers claimed/provisioning/running, while boot reconcile
 * requeues claimed/provisioning; those are not represented as pure matrix
 * edges because they are scheduler-recovery decisions, not normal execution
 * transitions.
 */
export function createSqlJobLifecycleApplication(db: JobLifecycleDatabase = sql): JobLifecycleApplication {
  return createJobLifecycleApplication({
    async transitionJob({ jobId, to, allowedFrom, patch }) {
      // `planJobTransition` rejects a patch.status override before this adapter
      // is reached, so the persisted target always comes from `to`.
      const sets = { status: to, ...patch };
      const [row] = await db`
        UPDATE jobs SET ${db(sets)}
        WHERE id = ${jobId} AND status = ANY(${allowedFrom})
        RETURNING id, status`;
      return row ? (row as JobTransitionRow) : null;
    },

    /** Dispatcher claim: pending -> claimed, preserving the claim timestamp. */
    async claimPendingJob(jobId) {
      const [row] = await db`
        UPDATE jobs SET status = 'claimed', claimed_at = now()
        WHERE id = ${jobId} AND status = 'pending'
        RETURNING id`;
      return row ? (row as JobLifecycleRow) : null;
    },

    /** Executor exception: only active execution states may become failed. */
    async failExecution(jobId, error) {
      const [row] = await db`
        UPDATE jobs SET status = 'failed', finished_at = now(), error = ${error}
        WHERE id = ${jobId} AND status IN ('claimed','provisioning','running')
        RETURNING id, type`;
      return row ? (row as JobLifecycleRow) : null;
    },

    /** Reaper execution timeout (legacy multi-source recovery operation). */
    async reapExecutionTimeout() {
      const result = await db`
        UPDATE jobs SET status = 'timeout', finished_at = now(),
                        error = COALESCE(error, '') || '超时（Reaper 判定）'
        WHERE status IN ('claimed','provisioning','running')
          AND started_at IS NOT NULL
          AND started_at + (timeout_sec * interval '1 second') < now()
        RETURNING id, sandbox_id`;
      return rows(result as unknown as JobLifecycleRow[]);
    },

    /** Reaper provisioning timeout (legacy multi-source recovery operation). */
    async reapProvisionTimeout(provisionSec) {
      const result = await db`
        UPDATE jobs SET status = 'failed', finished_at = now(),
                        error = COALESCE(error, '') || 'provision 超时（Reaper 判定）'
        WHERE status IN ('claimed','provisioning')
          AND claimed_at IS NOT NULL
          AND claimed_at + (${provisionSec} * interval '1 second') < now()
        RETURNING id, sandbox_id`;
      return rows(result as unknown as JobLifecycleRow[]);
    },

    /** Reaper lease recovery: only an expired running lease may orphan. */
    async reapLeaseOrphans() {
      const result = await db`
        UPDATE jobs SET status = 'orphan', finished_at = now(),
                        error = COALESCE(error, '') || 'lease 过期（Reaper 判定孤儿）'
        WHERE status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
        RETURNING id, sandbox_id`;
      return rows(result as unknown as JobLifecycleRow[]);
    },

    /** Boot reconcile recovery: claimed/provisioning -> pending with lease metadata cleared. */
    async reconcileProvisioning() {
      const result = await db`
        UPDATE jobs SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL
        WHERE status IN ('claimed','provisioning')
        RETURNING id`;
      return rows(result as unknown as JobLifecycleRow[]);
    },

    /** Boot reconcile recovery: running -> orphan with restart evidence. */
    async reconcileRunning() {
      const result = await db`
        UPDATE jobs SET status = 'orphan', finished_at = now(),
                        error = COALESCE(error, '') || '调度器重启（执行中断）'
        WHERE status = 'running'
        RETURNING id, sandbox_id, type, canvas_id, project_id, priority, error`;
      return rows(result as unknown as JobLifecycleRow[]);
    },

    /** Single cancel route: active states only; clear lease/heartbeat metadata. */
    async cancelJob(jobId, error) {
      const [row] = await db`
        UPDATE jobs SET status = 'cancelled', finished_at = now(),
          error = ${error}, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE id = ${jobId} AND status IN ('pending','claimed','provisioning','running','waiting_human')
        RETURNING id, status, sandbox_id, project_id, type, canvas_id`;
      return row ? (row as JobLifecycleRow) : null;
    },

    /**
     * Bulk cancellation used by archive/delete and canvas cancel-active.  One
     * UPDATE is the atomic linearization point; callers perform sandbox/token/
     * canvas side effects only for returned rows.
     */
    async cancelJobsOnCanvas(canvasId, error, preserveExistingError = false, clearRuntimeMetadata = true) {
      const result = preserveExistingError
        ? clearRuntimeMetadata
          ? await db`
              UPDATE jobs SET status = 'cancelled', finished_at = now(),
                error = COALESCE(error, 'task archived/deleted'),
                lease_expires_at = NULL, heartbeat_at = NULL
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`
          : await db`
              UPDATE jobs SET status = 'cancelled', finished_at = now(),
                error = COALESCE(error, 'task archived/deleted')
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`
        : clearRuntimeMetadata
          ? await db`
              UPDATE jobs SET status = 'cancelled', finished_at = now(),
                error = ${error}, lease_expires_at = NULL, heartbeat_at = NULL
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`
          : await db`
              UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${error}
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`;
      return rows(result as unknown as JobLifecycleRow[]);
    },

    /** Runtime-image revocation cancellation, guarded by the frozen snapshot id. */
    async cancelJobsForRuntimeImageVersion(versionId, error) {
      const result = await db`
        UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${error}
        WHERE agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${versionId}
          AND status IN ('pending','claimed','provisioning','running','waiting_human')
        RETURNING id, sandbox_id`;
      return rows(result as unknown as JobLifecycleRow[]);
    },
  });
}

const defaultApplication = createSqlJobLifecycleApplication();

/** Scheduler-compatible application entry point retained for core callers. */
export async function transitionJob(
  jobId: string,
  to: string,
  patch: Record<string, unknown> = {},
): Promise<JobTransitionRow | null> {
  return defaultApplication.transitionJob(jobId, to, patch);
}
