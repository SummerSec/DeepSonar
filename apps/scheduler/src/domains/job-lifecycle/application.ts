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
  createAttempt,
  markAttemptInterrupted,
  requestAttemptCancel,
  settleAttemptTerminal,
} from "../job-attempt/index.js";
import {
  CHROME_JOB_STALL_SEC,
  HUB_JOB_STALL_SEC,
  INFLIGHT_TOOL_BUDGET_MIN_SEC,
  INFLIGHT_TOOL_BUDGET_MULTIPLIER,
  INFLIGHT_TOOL_STALL_ERROR,
  INFLIGHT_TOOL_STALL_REASON,
  TOOL_CALL_STARTED_PREFIX,
} from "./stall-policy.js";

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
    retryProvisioning: requireOperation("retryProvisioning"),
    retryTruncatedExecution: requireOperation("retryTruncatedExecution"),
    retryContextWindowExceeded: requireOperation("retryContextWindowExceeded"),
    failExecution: requireOperation("failExecution"),
    reapExecutionTimeout: requireOperation("reapExecutionTimeout"),
    reapProvisionTimeout: requireOperation("reapProvisionTimeout"),
    reapLeaseOrphans: requireOperation("reapLeaseOrphans"),
    reapStalledExecution: requireOperation("reapStalledExecution"),
    reapWaitingHumanTimeout: requireOperation("reapWaitingHumanTimeout"),
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
export function createSqlJobLifecycleApplication(
  db: JobLifecycleDatabase = sql,
  options: { deferProvisionInterruption?: boolean } = {},
): JobLifecycleApplication {
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

    /** Requeue a transient pre-running provision failure with a fresh Attempt. */
    async retryProvisioning(jobId, error, snapshotIdentity, resourceLabels) {
      return atomically(async (tx) => {
        const [row] = await tx`
          UPDATE jobs
          SET status = 'pending', claimed_at = NULL, started_at = NULL,
              finished_at = NULL, lease_expires_at = NULL, sandbox_id = NULL, error = NULL
          WHERE id = ${jobId} AND status IN ('claimed','provisioning') AND started_at IS NULL
          RETURNING id, status`;
        if (!row) return null;
        await settleAttemptTerminal(tx, jobId, "failed", {
          reason: "provision_retry",
          retry_scheduled: true,
        }, error);
        await tx`
          UPDATE canvas_nodes SET status = 'pending', updated_at = now()
          WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})
            AND status IN ('running', 'failed')`;
        await createAttempt(tx, jobId, snapshotIdentity, resourceLabels);
        return row as JobLifecycleRow;
      });
    },

    /**
     * Requeue a transient post-provision stream truncation with a fresh Attempt.
     * Must not reuse retryProvisioning: that CAS requires started_at IS NULL.
     */
    async retryTruncatedExecution(jobId, error, snapshotIdentity, resourceLabels) {
      return atomically(async (tx) => {
        const [row] = await tx`
          UPDATE jobs
          SET status = 'pending', claimed_at = NULL, started_at = NULL,
              finished_at = NULL, lease_expires_at = NULL, sandbox_id = NULL, error = NULL
          WHERE id = ${jobId} AND status = 'running' AND started_at IS NOT NULL
          RETURNING id, status`;
        if (!row) return null;
        await settleAttemptTerminal(tx, jobId, "failed", {
          reason: "pi_stream_truncated",
          retry_scheduled: true,
        }, error);
        await tx`
          UPDATE canvas_nodes SET status = 'pending', updated_at = now()
          WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})
            AND status IN ('running', 'failed')`;
        await createAttempt(tx, jobId, snapshotIdentity, resourceLabels);
        return row as JobLifecycleRow;
      });
    },

    /**
     * Requeue after provider context window exceeded with a fresh Attempt.
     * Caller must stamp payload_json.context_window_compact_retry before/within
     * the same transaction so the next execution compresses the prompt.
     */
    async retryContextWindowExceeded(jobId, error, snapshotIdentity, resourceLabels) {
      return atomically(async (tx) => {
        const [row] = await tx`
          UPDATE jobs
          SET status = 'pending', claimed_at = NULL, started_at = NULL,
              finished_at = NULL, lease_expires_at = NULL, sandbox_id = NULL, error = NULL
          WHERE id = ${jobId} AND status = 'running' AND started_at IS NOT NULL
          RETURNING id, status`;
        if (!row) return null;
        await settleAttemptTerminal(tx, jobId, "failed", {
          reason: "context_window_exceeded",
          retry_scheduled: true,
        }, error);
        await tx`
          UPDATE canvas_nodes SET status = 'pending', updated_at = now()
          WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})
            AND status IN ('running', 'failed')`;
        await createAttempt(tx, jobId, snapshotIdentity, resourceLabels);
        return row as JobLifecycleRow;
      });
    },

    /** Executor 异常：只有活动执行状态允许进入 failed。空串不能当失败原因。 */
    async failExecution(jobId, error) {
      const persistedError = error.trim() || "exception";
      const [row] = await db`
        UPDATE jobs SET status = 'failed', finished_at = now(), error = ${persistedError}
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
            AND COALESCE(execution_deadline_at,started_at+timeout_sec*interval '1 second') < now()
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await settleAttemptTerminal(tx, String(row.id), "timeout", { reason: "reaper_timeout" }, "超时（Reaper 判定）");
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
    },

    /** Reaper provision 超时（多来源恢复操作）。 */
    async reapProvisionTimeout(provisionSec) {
      const fallback = Number.isSafeInteger(provisionSec) && provisionSec > 0 ? provisionSec : 300;
      const timedOut = await atomically(async (tx) => {
        const result = await tx`
          UPDATE jobs SET status = 'failed', finished_at = now(),
                          error = COALESCE(error, '') || 'provision 超时（Reaper 判定）'
          WHERE status IN ('claimed','provisioning')
            AND claimed_at IS NOT NULL
            AND claimed_at + (
              COALESCE(
                NULLIF((agent_snapshot_json #>> '{runtime_knobs,provision_timeout_sec}')::int, 0),
                ${fallback}::int
              ) * interval '1 second'
            ) < now()
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await settleAttemptTerminal(tx, String(row.id), "failed", { reason: "provision_timeout" }, "provision 超时（Reaper 判定）");
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
      // 先提交 Job/Attempt 终态，再通知当前进程中止 provider 创建。这样
      // cancel 与 reaper 共用同一外部效果顺序，并在本次 Reaper 处理返回前
      // 等待所有中止完成，缩短超时 provision 继续占用宿主资源的窗口。
      await Promise.all(timedOut.map((row) => interruptProvision(String(row.id))));
      return timedOut;
    },

    /**
     * Reaper lease 恢复：过期的 running lease 可进入 orphan。
     * Control 心跳或最近语义事件不早于 lease_expires_at 时不得误杀（#529）。
     */
    async reapLeaseOrphans() {
      return atomically(async (tx) => {
        const result = await tx`
          UPDATE jobs SET status = 'orphan', finished_at = now(),
                          error = COALESCE(error, '') || 'lease 过期（Reaper 判定孤儿）'
          WHERE status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < now()
            AND COALESCE(heartbeat_at, '-infinity'::timestamptz) < lease_expires_at
            AND COALESCE(
              (SELECT max(e.created_at) FROM events e WHERE e.job_id = jobs.id),
              '-infinity'::timestamptz
            ) < lease_expires_at
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await settleAttemptTerminal(tx, String(row.id), "orphan", { reason: "lease_expired" }, "lease 过期（Reaper 判定孤儿）");
        }
        return rows(result as unknown as JobLifecycleRow[]);
      });
    },

    /**
     * running 但语义事件停摆：lease 心跳单独不能证明 Agent 还在干活。
     * 在飞 tool.call（payload 或最近一条 tool.call.started 进度）且 lease 仍有效时不判停滞；
     * chrome-audit/test/fuzz 另有 per-image stall 下限，避免单条长工具超过全局 900s。
     */
    async reapStalledExecution(stallSec) {
      const platformStall = Number.isSafeInteger(stallSec) ? stallSec : 0;
      const chromeAuditStall = CHROME_JOB_STALL_SEC["deepsonar-chrome-audit"];
      const chromeTestStall = CHROME_JOB_STALL_SEC["deepsonar-chrome-test"];
      const chromeFuzzStall = CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"];
      const hubStall = HUB_JOB_STALL_SEC;
      const inflightMin = INFLIGHT_TOOL_BUDGET_MIN_SEC;
      const inflightMultiplier = INFLIGHT_TOOL_BUDGET_MULTIPLIER;
      return atomically(async (tx) => {
        // #1086：stall 下限与 in-flight tool 预算共用同一 floor 表达式，避免第二套阈值漂移。
        // 开关语义只看未叠加 floor 的配置值：runtime_knobs.stall_sec=0（或平台默认 0）
        // 仍明确关闭 watchdog，Chrome/Hub floor 不越权打开（评审 P1，SQL 与 TS 对齐）。
        const configuredSec = tx`COALESCE(
              (agent_snapshot_json #>> '{runtime_knobs,stall_sec}')::int,
              ${platformStall}::int
            )`;
        const floorSec = tx`GREATEST(
              COALESCE(
                (agent_snapshot_json #>> '{runtime_knobs,stall_sec}')::int,
                ${platformStall}::int
              ),
              CASE agent_snapshot_json #>> '{runtime_image,image_key}'
                WHEN 'deepsonar-chrome-fuzz' THEN ${chromeFuzzStall}::int
                WHEN 'deepsonar-chrome-audit' THEN ${chromeAuditStall}::int
                WHEN 'deepsonar-chrome-test' THEN ${chromeTestStall}::int
                ELSE COALESCE(
                  (agent_snapshot_json #>> '{runtime_knobs,stall_sec}')::int,
                  ${platformStall}::int
                )
              END,
              CASE type
                WHEN 'hub_reason' THEN ${hubStall}::int
                ELSE 0
              END
            )`;
        const lastActivity = tx`GREATEST(
              started_at,
              COALESCE((SELECT max(e.created_at) FROM events e WHERE e.job_id = jobs.id), started_at)
            )`;
        const leaseLive = tx`(
              lease_expires_at IS NOT NULL
              AND lease_expires_at > now()
            )`;
        const inflightTool = tx`(
                NULLIF(payload_json #>> '{runtime_activity,inflight_tool}', '') IS NOT NULL
                OR COALESCE(
                  (
                    SELECT e.payload_json->>'message'
                      FROM events e
                     WHERE e.job_id = jobs.id
                       AND e.type = 'progress'
                       AND e.payload_json->>'message' LIKE 'tool.call.%'
                     ORDER BY e.created_at DESC, e.id DESC
                     LIMIT 1
                  ),
                  ''
                ) LIKE ${`${TOOL_CALL_STARTED_PREFIX}%`}
              )`;
        const inflightBudget = tx`GREATEST(
              ${floorSec}::int * ${inflightMultiplier}::int,
              ${inflightMin}::int
            )::int * interval '1 second'`;
        // 先收口超出 in-flight 预算的挂死工具（独立稳定原因），再走普通停滞判定；
        // 已 failed 的行不会在第二条 UPDATE 里再次匹配 status='running'。
        const inflightStalled = await tx`
          UPDATE jobs SET status = 'failed', finished_at = now(),
                          error = COALESCE(error, '') || ${INFLIGHT_TOOL_STALL_ERROR}
          WHERE status = 'running'
            AND started_at IS NOT NULL
            AND ${configuredSec}::int > 0
            AND ${leaseLive}
            AND ${inflightTool}
            AND ${lastActivity} + ${inflightBudget} < now()
          RETURNING id, sandbox_id`;
        for (const row of inflightStalled) {
          await settleAttemptTerminal(tx, String(row.id), "failed",
            { reason: INFLIGHT_TOOL_STALL_REASON }, INFLIGHT_TOOL_STALL_ERROR);
        }
        const result = await tx`
          UPDATE jobs SET status = 'failed', finished_at = now(),
                          error = COALESCE(error, '') || '产出停滞（Reaper 判定）'
          WHERE status = 'running'
            AND started_at IS NOT NULL
            AND ${configuredSec}::int > 0
            AND ${lastActivity} + ${floorSec}::int * interval '1 second' < now()
            AND NOT (${leaseLive} AND ${inflightTool})
          RETURNING id, sandbox_id`;
        for (const row of result) {
          await settleAttemptTerminal(tx, String(row.id), "failed", { reason: "reaper_stall" }, "产出停滞（Reaper 判定）");
        }
        return rows([...inflightStalled, ...result] as unknown as JobLifecycleRow[]);
      });
    },

    /**
     * #1074: the human response window is an overdue marker, never an execution
     * deadline. Resource destruction is separately fenced by the owning Attempt.
     */
    async reapWaitingHumanTimeout(waitingHumanSec) {
      const budget = Number.isSafeInteger(waitingHumanSec) ? waitingHumanSec : 0;
      if (budget <= 0) return [];
      await atomically(async (tx) => {
        await tx`UPDATE human_requests r SET overdue_at=clock_timestamp()
          FROM jobs j WHERE j.id=r.job_id AND j.status='waiting_human'
            AND r.status='open' AND r.overdue_at IS NULL
            AND r.created_at+(${budget}::int*interval '1 second')<clock_timestamp()`;
      });
      return [];
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
             RETURNING id, status, sandbox_id, type, canvas_id, project_id, priority, error, agent_snapshot_json`;
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
          RETURNING id, sandbox_id, type, canvas_id, project_id, priority, error, agent_snapshot_json`;
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
        await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
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
      // An outer transaction has not committed when atomically() returns. Its owner
      // must invoke interruptProvision only after the real commit succeeds.
      if (!options.deferProvisionInterruption) {
        await Promise.all(cancelled.map((row) => interruptProvision(String(row.id))));
      }
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
