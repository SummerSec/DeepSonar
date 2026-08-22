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
  | "scheduled"
  | "pausing"
  | "paused"
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
  /** First actual job start; null means the canvas has not left the queue. */
  startedAt?: string | null;
  /** Future ISO start gate from target_json.schedule.start_at. */
  scheduledStartAt?: string | null;
  /** Scheduler-owned Canvas execution gate. */
  executionState?: "pausing" | "paused" | "running" | null;
  /** Jobs that must drain before a pause is fully settled; excludes pending. */
  executionActiveCount?: number | null;
  pendingCount?: number | null;
  /** Optional clock override for tests / live tick. */
  nowMs?: number;
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
  scheduled: { label: "定时等待", color: "#a78bfa" },
  pausing: { label: "暂停中", color: "#fbbf24" },
  paused: { label: "已暂停", color: "#f59e0b" },
  running: { label: "进行中", color: "#65e6b4" },
  failed: { label: "失败", color: "#f87171" },
  completed: { label: "已完成", color: "#65e6b4" },
  reporting: { label: "生成报告", color: "#38bdf8" },
  analysis_complete: { label: "分析完成 · 等待报告", color: "#34d399" },
  idle: { label: "空闲", color: "#7f8796" },
};

/** Read schedule.start_at from canvas target_json when present and parseable. */
export function readScheduledStartAt(targetJson: unknown): string | null {
  if (!targetJson || typeof targetJson !== "object" || Array.isArray(targetJson)) return null;
  const schedule = (targetJson as Record<string, unknown>).schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return null;
  const raw = (schedule as Record<string, unknown>).start_at;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

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

function isReportGeneration(value: string): boolean {
  return ["reporting", "pending", "generating"].includes(value);
}

/**
 * Derive the one task lifecycle used by cards, filters, and the workbench.
 * Precedence is intentional: archived > scheduled wait > active work > failure >
 * report phase > analysis complete > governed completion > idle.
 * In particular, a stale root or last Job terminal status can never hide
 * active work, a report that is still being generated, or a failure.
 */
export function deriveTaskLifecycle(input: TaskLifecycleInput): TaskLifecycleProjection {
  const jobs = input.jobs ?? [];
  const activeJobs = jobs.reduce(
    (total, job) => total + (ACTIVE_TASK_JOB_STATUSES.has(normalized(job.status)) ? 1 : 0),
    0,
  );
  // A present scheduler rollup is authoritative, including explicit zero.
  // Visible Jobs are only a fallback for callers that do not have the rollup
  // (the workbench can be paginated or briefly stale during a delta).
  const hasActiveRollup = typeof input.activeCount === "number" && Number.isFinite(input.activeCount);
  const activeCount = hasActiveRollup ? count(input.activeCount) : activeJobs;
  const hasJobRollup = typeof input.jobCount === "number" && Number.isFinite(input.jobCount);
  const jobCount = hasJobRollup ? count(input.jobCount) : Math.max(jobs.length, activeCount);
  const hasJobs = jobCount > 0;
  const archived = input.archived === true || normalized(input.status) === "archived";
  const rootStatus = normalized(input.rootStatus);
  const reportStatus = normalized(input.reportStatus);
  const hasStarted = Boolean(input.startedAt);
  const hasEnded = Boolean(input.endedAt);
  // Claim/provision can write finished_at without ever entering running, so
  // the rollup still emits ended_at while started_at stays null. That is a
  // never-started failure, not Hub complete.
  const neverStartedTerminal = hasJobs && hasEnded && !hasStarted;
  const neverStartedJobFailure =
    !hasStarted && jobs.some((job) => isFailure(normalized(job.status)));
  const hasFailure =
    isFailure(rootStatus) || isFailure(reportStatus) || neverStartedTerminal || neverStartedJobFailure;
  // A root node can be `pending` before its first Job starts; only the report
  // node's pending/generating statuses mean report generation. The root's
  // explicit `reporting` phase is also governed by the Scheduler.
  const hasReportPhase = rootStatus === "reporting" || isReportGeneration(reportStatus);
  const hasAnalysisComplete = rootStatus === "analysis_complete";
  // Completion requires an actual run and a governed success: Jobs existed,
  // at least one entered running (started_at), the rollup is terminal, and
  // the root or report is in a successful terminal state. ended_at alone
  // is not enough — it is also set when provision fails before running.
  const hasCompletion =
    hasJobs && hasStarted && hasEnded && (isSuccess(rootStatus) || isSuccess(reportStatus));
  const nowMs = typeof input.nowMs === "number" && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const scheduledMs =
    typeof input.scheduledStartAt === "string" && input.scheduledStartAt.trim()
      ? Date.parse(input.scheduledStartAt)
      : Number.NaN;
  const waitingOnSchedule =
    Number.isFinite(scheduledMs) &&
    scheduledMs > nowMs &&
    !input.startedAt &&
    activeCount > 0;
  const executionState = normalized(input.executionState);

  let status: TaskLifecycleStatus;
  if (archived) status = "archived";
  else if (waitingOnSchedule) status = "scheduled";
  else if (executionState === "pausing") status = "pausing";
  else if (executionState === "paused") status = "paused";
  else if (activeCount > 0) status = "running";
  else if (hasFailure) status = "failed";
  else if (hasReportPhase) status = "reporting";
  else if (hasAnalysisComplete) status = "analysis_complete";
  else if (hasCompletion) status = "completed";
  else status = "idle";

  return {
    status,
    ...TASK_LIFECYCLE_META[status],
    // Scheduled tasks still occupy the active queue (pending Jobs) so list
    // filters that look at isActive continue to surface them.
    isActive: status === "running" || status === "scheduled" || status === "pausing",
    activeCount,
    hasJobs,
    endedAt: input.endedAt ?? null,
  };
}
