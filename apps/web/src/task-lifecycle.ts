/**
 * Task-level lifecycle projection shared by the task list and task workbench.
 *
 * Job status is an execution detail. A task can have a newer completed Job
 * while another Job is still active, so the task projection must always look
 * at the active rollup and the current canvas jobs before considering root or
 * report terminal states.
 */

export const ACTIVE_TASK_JOB_STATUSES = new Set([
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
]);

export type TaskLifecycleStatus =
  | "archived"
  | "running"
  | "failed"
  | "completed"
  | "reporting"
  | "analysis_complete"
  | "idle";

export interface TaskLifecycleInput {
  /** Canvas status from the task list. */
  status?: string | null;
  /** Explicit archive flag for callers that do not carry the canvas status. */
  archived?: boolean;
  /** Scheduler rollup; active_count is authoritative when it is non-zero. */
  activeCount?: number | null;
  /** Jobs currently visible in the workbench (may be a partial page). */
  jobs?: readonly { status?: string | null }[];
  /** Total Job count from the canvas rollup, used when jobs are paginated. */
  jobCount?: number | null;
  /** Root node lifecycle status. */
  rootStatus?: string | null;
  /** Report node/API lifecycle status, when available. */
  reportStatus?: string | null;
  /** Scheduler lifecycle end timestamp. */
  endedAt?: string | null;
}

export interface TaskLifecycleProjection {
  status: TaskLifecycleStatus;
  label: string;
  color: string;
  isActive: boolean;
  activeCount: number;
  hasJobs: boolean;
  endedAt: string | null;
}

export const TASK_LIFECYCLE_META: Record<
  TaskLifecycleStatus,
  { label: string; color: string }
> = {
  archived: { label: "已归档", color: "#71717a" },
  running: { label: "进行中", color: "#65e6b4" },
  failed: { label: "失败", color: "#f87171" },
  completed: { label: "已完成", color: "#65e6b4" },
  reporting: { label: "生成报告", color: "#38bdf8" },
  analysis_complete: { label: "分析完成 · 等待报告", color: "#34d399" },
  idle: { label: "空闲", color: "#7f8796" },
};

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalized(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isFailure(value: string): boolean {
  return ["failed", "failure", "error", "timeout", "cancelled", "orphan"].includes(value) || value.endsWith("_failed");
}

function isSuccess(value: string): boolean {
  return ["succeeded", "success", "completed", "complete"].includes(value);
}

function isReporting(value: string): boolean {
  return ["reporting", "pending", "generating"].includes(value);
}

/**
 * Derive the one task lifecycle used by cards, filters, and the workbench.
 * Precedence is intentional: archived > active work > failure > completion >
 * report generation > analysis complete > idle. In particular, a stale root
 * or last Job terminal status can never hide an active Job.
 */
export function deriveTaskLifecycle(input: TaskLifecycleInput): TaskLifecycleProjection {
  const jobs = input.jobs ?? [];
  const activeJobs = jobs.reduce(
    (total, job) => total + (ACTIVE_TASK_JOB_STATUSES.has(normalized(job.status)) ? 1 : 0),
    0,
  );
  const activeCount = Math.max(count(input.activeCount), activeJobs);
  const jobCount = Math.max(count(input.jobCount), jobs.length, activeCount);
  const hasJobs = jobCount > 0;
  const archived = input.archived === true || normalized(input.status) === "archived";
  const rootStatus = normalized(input.rootStatus);
  const reportStatus = normalized(input.reportStatus);

  let status: TaskLifecycleStatus;
  if (archived) status = "archived";
  else if (activeCount > 0) status = "running";
  else if (!hasJobs) status = "idle";
  else if (isFailure(rootStatus) || isFailure(reportStatus)) status = "failed";
  else if (isSuccess(rootStatus) || isSuccess(reportStatus)) status = "completed";
  else if (rootStatus === "analysis_complete") status = "analysis_complete";
  else if (isReporting(rootStatus) || isReporting(reportStatus)) status = "reporting";
  else if (input.endedAt) status = "completed";
  else status = "idle";

  return {
    status,
    ...TASK_LIFECYCLE_META[status],
    isActive: status === "running",
    activeCount,
    hasJobs,
    endedAt: input.endedAt ?? null,
  };
}
