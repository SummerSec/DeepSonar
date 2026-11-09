export type ProjectTaskQueueItemState = "queued" | "active" | "succeeded" | "failed" | "cancelled";

export type ProjectTaskQueuePauseReason = "manual" | "task_failed" | "task_cancelled";

export type ProjectTaskQueueBlockReason =
  | "queue_paused"
  | "waiting_turn"
  | "active_jobs"
  | "waiting_human"
  | "unknown_effect"
  | "task_paused"
  | "report_pending"
  | "root_pending"
  | "stale_completion"
  | "task_failed"
  | "task_cancelled"
  | "task_archived"
  | "project_archived";

export type ProjectTaskQueueReconciliation =
  | { kind: "hold"; blockReason: ProjectTaskQueueBlockReason }
  | { kind: "succeed" }
  | { kind: "pause"; pauseReason: Extract<ProjectTaskQueuePauseReason, "task_failed" | "task_cancelled"> };

export interface CanClaimQueuedTaskInput {
  queuePaused: boolean;
  itemState: ProjectTaskQueueItemState | null;
  isHead: boolean;
}

export interface TaskQueueReconciliationInput {
  canvasArchived: boolean;
  projectArchived: boolean;
  executionPaused: boolean;
  activeJobCount: number;
  waitingHumanCount: number;
  unresolvedEffect: boolean;
  hasStarted: boolean;
  itemState: ProjectTaskQueueItemState;
  queuePaused: boolean;
  latestJobStatus: string | null;
  rootStatus: string | null;
  currentTaskReportStatus: string | null;
  reportNodeStatus: string | null;
}

/**
 * An unenrolled canvas keeps the existing claim path. Queue order only gates
 * queued canvases; an already active head may continue its internal Jobs while
 * the project queue is paused.
 */
export function canClaimQueuedTask(input: CanClaimQueuedTaskInput): boolean {
  if (input.itemState === null) return true;
  if (!input.isHead) return false;
  if (input.itemState === "active") return true;
  if (input.itemState !== "queued") return false;
  return !input.queuePaused;
}

function reportStatus(input: TaskQueueReconciliationInput): string | null {
  return input.currentTaskReportStatus ?? input.reportNodeStatus;
}

function terminalFailureDecision(status: string | null): ProjectTaskQueueReconciliation | null {
  if (status === "cancelled") return { kind: "pause", pauseReason: "task_cancelled" };
  if (status === "failed" || status === "timeout" || status === "orphan" || status === "report_failed") {
    return { kind: "pause", pauseReason: "task_failed" };
  }
  return null;
}

/**
 * Decide only from a single SQL snapshot. A successful individual Job is not a
 * task completion signal; the actual task start, Root, and current report must
 * all converge before the queue releases its head. The current Task Report is
 * authoritative when present; otherwise the current report-node projection is
 * used as the existing platform completion signal.
 */
export function decideTaskQueueReconciliation(
  input: TaskQueueReconciliationInput,
): ProjectTaskQueueReconciliation {
  if (input.projectArchived) return { kind: "hold", blockReason: "project_archived" };
  if (input.canvasArchived) return { kind: "hold", blockReason: "task_archived" };
  if (input.executionPaused) return { kind: "hold", blockReason: "task_paused" };
  if (input.waitingHumanCount > 0) return { kind: "hold", blockReason: "waiting_human" };
  if (input.unresolvedEffect) return { kind: "hold", blockReason: "unknown_effect" };
  if (input.activeJobCount > 0) return { kind: "hold", blockReason: "active_jobs" };

  const latestJobFailure = terminalFailureDecision(input.latestJobStatus);
  if (latestJobFailure) return latestJobFailure;
  if (input.rootStatus === "__stale_completion__") {
    return { kind: "hold", blockReason: "stale_completion" };
  }
  const rootFailure = terminalFailureDecision(input.rootStatus);
  if (rootFailure) return rootFailure;
  if (reportStatus(input) === "__stale_completion__") {
    return { kind: "hold", blockReason: "stale_completion" };
  }
  const reportFailure = terminalFailureDecision(reportStatus(input));
  if (reportFailure) return reportFailure;

  if (input.itemState === "queued" && input.queuePaused) {
    return { kind: "hold", blockReason: "queue_paused" };
  }
  if (input.itemState !== "active") return { kind: "hold", blockReason: "root_pending" };

  if (!input.hasStarted || input.rootStatus !== "succeeded") {
    if (input.rootStatus === "analysis_complete" || input.rootStatus === "reporting") {
      return { kind: "hold", blockReason: "report_pending" };
    }
    return { kind: "hold", blockReason: "root_pending" };
  }
  if (reportStatus(input) !== null && reportStatus(input) !== "succeeded") {
    return { kind: "hold", blockReason: "report_pending" };
  }
  return { kind: "succeed" };
}
