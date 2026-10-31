import type {
  TaskExecutionControl,
  TaskExecutionControlResult,
  TaskExecutionState,
} from "@deepsonar/shared-types";

export const TASK_EXECUTION_ACTIVE_STATUSES = [
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readTaskExecutionControl(targetJson: unknown): TaskExecutionControl {
  const raw = record(record(targetJson).execution_control);
  return {
    paused: raw.paused === true,
    paused_at: typeof raw.paused_at === "string" ? raw.paused_at : null,
    paused_by: typeof raw.paused_by === "string" ? raw.paused_by : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

export function canvasExecutionIsPaused(targetJson: unknown): boolean {
  return readTaskExecutionControl(targetJson).paused;
}

export function taskExecutionState(targetJson: unknown, activeCount: number): TaskExecutionState {
  if (!canvasExecutionIsPaused(targetJson)) return "running";
  return activeCount > 0 ? "pausing" : "paused";
}

export function setTaskExecutionControl(
  targetJson: unknown,
  paused: boolean,
  actorId: string | null,
  now = new Date(),
): Record<string, unknown> {
  const target = { ...record(targetJson) };
  target.execution_control = paused
    ? {
        paused: true,
        paused_at: now.toISOString(),
        paused_by: actorId,
        reason: "manual_pause",
      }
    : {
        paused: false,
        paused_at: null,
        paused_by: null,
        reason: null,
      };
  return target;
}

export function taskExecutionProjection(
  canvasId: string,
  targetJson: unknown,
  activeCount: number,
  pendingCount: number,
  changed: boolean,
): TaskExecutionControlResult {
  return {
    canvas_id: canvasId,
    execution_state: taskExecutionState(targetJson, activeCount),
    active_count: activeCount,
    pending_count: pendingCount,
    changed,
  };
}

export function projectTaskExecution<T extends Record<string, unknown>>(row: T): T & {
  execution_state: TaskExecutionState;
  execution_active_count: number;
  pending_count: number;
} {
  const activeCount = Number(row.execution_active_count ?? 0);
  return {
    ...row,
    execution_state: taskExecutionState(row.target_json, activeCount),
    execution_active_count: activeCount,
    pending_count: Number(row.pending_count ?? 0),
  };
}
