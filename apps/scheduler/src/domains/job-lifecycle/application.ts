import { sql } from "../../db.js";
import { planJobTransition, type JobTransitionPlan } from "./transition-policy.js";
import type {
  JobLifecycleDatabase,
  JobLifecycleOperations,
  JobLifecycleRow,
  JobTransitionExecutor,
  JobTransitionRequest,
  JobTransitionRow,
  ProvisionReconcileResult,
} from "./ports.js";
import {
  interruptProvision,
  markAttemptInterrupted,
  requestAttemptCancel,
  settleAttemptTerminal,
} from "../job-attempt/index.js";

export type {
  JobLifecycleDatabase,
  JobLifecycleOperations,
  JobLifecycleRow,
  JobTransitionExecutor,
  JobTransitionRequest,
  JobTransitionRow,
  ProvisionReconcileResult,
} from "./ports.js";

/**
 * Application 方法保持为窄 CAS 操作。事务由调用方拥有并把标记客户端传入，
 * 生命周期代码不会意外开启第二连接或改变 Canvas/Job 的外层加锁顺序。
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
 * 围绕测试替身或显式 ports 构造 application seam；历史的
 * `createJobLifecycleApplication(executor)` 形式保留，使策略单测无需数据库。
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
  const atomically = async <T>(work: (tx: JobLifecycleDatabase) => Promise<T>): Promise<T> => {
    // 默认适配器自行开启事务；调用方已经提供事务客户端时直接复用，
    // 避免在同一连接上嵌套事务造成错误的收口边界。
    if (db === sql) return db.begin((tx) => work(tx as unknown as JobLifecycleDatabase)) as Promise<T>;
    return work(db);
  };
  return createJobLifecycleApplication({
    async transitionJob({ jobId, to, allowedFrom, patch }) {
      // planJobTransition 在进入此适配器前拒绝 patch.status，因此持久化目标只来自 to。
      const sets = { status: to, ...patch };
      const [row] = await db`
        UPDATE jobs SET ${db(sets)}
        WHERE id = ${jobId} AND status = ANY(${allowedFrom})
        RETURNING id, status`;
      return row ? (row as JobTransitionRow) : null;
    },

    /** Dispatcher claim：pending -> claimed，并保留领取时间。 */
    async claimPendingJob(jobId) {
      const [row] = await db`
        UPDATE jobs SET status = 'claimed', claimed_at = now()
        WHERE id = ${jobId} AND status = 'pending'
        RETURNING id`;
      return row ? (row as JobLifecycleRow) : null;
    },

    /** Executor 异常：只有活动执行状态允许进入 failed。 */
    async failExecution(jobId, error) {
      const [row] = await db`
        UPDATE jobs SET status = 'failed', finished_at = now(), error = ${error}
        WHERE id = ${jobId} AND status IN ('claimed','provisioning','running')
        RETURNING id, type`;
      return row ? (row as JobLifecycleRow) : null;
    },

    /** Reaper 执行超时（多来源恢复操作）。 */
    async reapExecutionTimeout() {
      return atomically(async (tx) => {
        const result = await tx`
          UPDATE jobs SET status = 'timeout', finished_at = now(),
                          error = COALESCE(error, '') || '超时（Reaper 判定）'
          WHERE status IN ('claimed','provisioning','running')
            AND started_at IS NOT NULL
            AND started_at + (timeout_sec * interval '1 second') < now()
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await settleAttemptTerminal(tx, String(row.id), "timeout", { reason: "reaper_timeout" }, "超时（Reaper 判定）");
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
    },

    /** Reaper provision 超时（多来源恢复操作）。 */
    async reapProvisionTimeout(provisionSec) {
      return atomically(async (tx) => {
        const result = await tx`
          UPDATE jobs SET status = 'failed', finished_at = now(),
                          error = COALESCE(error, '') || 'provision 超时（Reaper 判定）'
          WHERE status IN ('claimed','provisioning')
            AND claimed_at IS NOT NULL
            AND claimed_at + (${provisionSec} * interval '1 second') < now()
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await settleAttemptTerminal(tx, String(row.id), "failed", { reason: "provision_timeout" }, "provision 超时（Reaper 判定）");
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
    },

    /** Reaper lease 恢复：只有过期的 running lease 可进入 orphan。 */
    async reapLeaseOrphans() {
      return atomically(async (tx) => {
        const result = await tx`
          UPDATE jobs SET status = 'orphan', finished_at = now(),
                          error = COALESCE(error, '') || 'lease 过期（Reaper 判定孤儿）'
          WHERE status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < now()
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await settleAttemptTerminal(tx, String(row.id), "orphan", { reason: "lease_expired" }, "lease 过期（Reaper 判定孤儿）");
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
    },

    /**
     * 启动恢复：只有明确处于 preparing 且没有任何效果记录的 Attempt 才能回到
     * pending。其余状态无法证明外部效果未发生，必须以 orphan 终止，避免默认
     * never 策略被重启重排绕过。
     */
    async reconcileProvisioning() {
      return atomically(async (tx) => {
        const candidates = await tx`
          SELECT j.id, j.status, j.sandbox_id, a.id AS attempt_id, a.phase,
                 EXISTS (
                   SELECT 1 FROM job_attempt_effects e
                    WHERE e.attempt_id = a.id
                 ) AS has_effect
            FROM jobs j
            LEFT JOIN job_attempts a
              ON a.job_id = j.id AND a.status = 'active'
           WHERE j.status IN ('claimed','provisioning')
           FOR UPDATE OF j`;
        const requeued: Record<string, unknown>[] = [];
        const orphanedRows: Record<string, unknown>[] = [];
        for (const row of candidates) {
          const jobId = String(row.id);
          const canRequeue = Boolean(row.attempt_id)
            && row.phase === "preparing"
            && row.has_effect === false
            && !row.sandbox_id;
          if (canRequeue) {
            const [reset] = await tx`
              UPDATE jobs SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL
               WHERE id = ${jobId} AND status IN ('claimed','provisioning')
               RETURNING id, status`;
            if (reset) {
              await markAttemptInterrupted(tx, jobId, "调度器重启（provision 尚未产生效果）");
              requeued.push(reset as Record<string, unknown>);
            }
            continue;
          }

          const [orphaned] = await tx`
            UPDATE jobs SET status = 'orphan', finished_at = now(),
              error = COALESCE(error, '调度器重启（provision 外部效果状态未知）'),
              claimed_at = NULL, lease_expires_at = NULL
             WHERE id = ${jobId} AND status IN ('claimed','provisioning')
             RETURNING id, status, sandbox_id, type, canvas_id, project_id, priority, error`;
          if (orphaned) {
            await settleAttemptTerminal(
              tx,
              jobId,
              "orphan",
              { reason: "provision_effect_unknown", phase: row.phase ?? "missing_attempt" },
              "调度器重启（provision 外部效果状态未知）",
            );
            orphanedRows.push(orphaned as Record<string, unknown>);
          }
        }
        return {
          requeued: rows(requeued as JobLifecycleRow[]),
          orphaned: rows(orphanedRows as JobLifecycleRow[]),
        } satisfies ProvisionReconcileResult;
      });
    },

    /** 启动对账恢复：running -> orphan，并记录重启证据。 */
    async reconcileRunning() {
      return atomically(async (tx) => {
        const result = await tx`
          UPDATE jobs SET status = 'orphan', finished_at = now(),
                          error = COALESCE(error, '') || '调度器重启（执行中断）'
          WHERE status = 'running'
          RETURNING id, sandbox_id, type, canvas_id, project_id, priority, error`;
        for (const row of result) {
          await settleAttemptTerminal(
            tx,
            String(row.id),
            "orphan",
            { reason: "scheduler_restart", result: "执行上下文丢失" },
            "调度器重启（执行中断）",
          );
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
    },

    /** 单 Job 取消：只处理活动状态，并清理 lease/heartbeat 元数据。 */
    async cancelJob(jobId, error) {
      const row = await atomically(async (tx) => {
        await requestAttemptCancel(tx, jobId, error);
        const [row] = await tx`
          UPDATE jobs SET status = 'cancelled', finished_at = now(),
            error = ${error}, lease_expires_at = NULL, heartbeat_at = NULL
          WHERE id = ${jobId} AND status IN ('pending','claimed','provisioning','running','waiting_human')
          RETURNING id, status, sandbox_id, project_id, type, canvas_id`;
        if (row) await settleAttemptTerminal(tx, jobId, "cancelled", { reason: error }, error);
        return row ? (row as JobLifecycleRow) : null;
      });
      if (row) await interruptProvision(jobId);
      return row;
    },

    /**
     * 归档/删除和画布批量取消使用此操作。单个 UPDATE 是原子线性化点；调用方
     * 只对返回行执行沙箱、Token 和画布副作用。
     */
    async cancelJobsOnCanvas(canvasId, error, preserveExistingError = false, clearRuntimeMetadata = true) {
      const cancelled = await atomically(async (tx) => {
        const result = preserveExistingError
        ? clearRuntimeMetadata
          ? await tx`
              UPDATE jobs SET status = 'cancelled', finished_at = now(),
                error = COALESCE(error, 'task archived/deleted'),
                lease_expires_at = NULL, heartbeat_at = NULL
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`
          : await tx`
              UPDATE jobs SET status = 'cancelled', finished_at = now(),
                error = COALESCE(error, 'task archived/deleted')
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`
        : clearRuntimeMetadata
          ? await tx`
              UPDATE jobs SET status = 'cancelled', finished_at = now(),
                error = ${error}, lease_expires_at = NULL, heartbeat_at = NULL
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`
          : await tx`
              UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${error}
              WHERE canvas_id = ${canvasId}
                AND status IN ('pending','claimed','provisioning','running','waiting_human')
              RETURNING id, status, sandbox_id, project_id, type, canvas_id`;
        for (const row of result) {
          await requestAttemptCancel(tx, String(row.id), error);
          await settleAttemptTerminal(tx, String(row.id), "cancelled", { reason: error }, error);
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
      await Promise.all(cancelled.map((row) => interruptProvision(String(row.id))));
      return cancelled;
    },

    /** 按冻结快照 ID 执行运行镜像撤销取消。 */
    async cancelJobsForRuntimeImageVersion(versionId, error) {
      const cancelled = await atomically(async (tx) => {
        const result = await tx`
          UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${error}
          WHERE agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${versionId}
            AND status IN ('pending','claimed','provisioning','running','waiting_human')
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await requestAttemptCancel(tx, String(row.id), error);
          await settleAttemptTerminal(tx, String(row.id), "cancelled", { reason: error }, error);
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
      await Promise.all(cancelled.map((row) => interruptProvision(String(row.id))));
      return cancelled;
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
