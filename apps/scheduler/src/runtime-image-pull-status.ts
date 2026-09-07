import { sql } from "./db.js";

export type RuntimeImagePullItemStatus = "queued" | "running" | "succeeded" | "failed";
export type RuntimeImagePullTaskStatus = RuntimeImagePullItemStatus | "interrupted";

export interface RuntimeImagePullItem {
  image_key: string;
  image_ref: string;
  status: RuntimeImagePullItemStatus;
  error: string | null;
  error_code?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface RuntimeImagePullTask {
  task_id: string;
  purpose?: string;
  status: RuntimeImagePullTaskStatus;
  started_at: string | null;
  finished_at: string | null;
  interrupted_at?: string | null;
  interrupt_reason?: string | null;
  error_code?: string | null;
  error?: string | null;
  total: number;
  completed: number;
  items: RuntimeImagePullItem[];
}

export interface RuntimeImagePullStatusView {
  task_id: string | null;
  purpose: string;
  status: RuntimeImagePullTaskStatus | "idle";
  phase: string;
  started_at: string | null;
  finished_at: string | null;
  interrupted_at: string | null;
  interrupt_reason: string | null;
  error_code: string | null;
  error: string | null;
  total: number;
  completed: number;
  items: Array<RuntimeImagePullItem & { phase: string; error_code: string | null }>;
  checked_at: string;
}

export interface RuntimeImagePullTaskStore {
  save(task: RuntimeImagePullTask): Promise<void>;
  loadLatest(): Promise<RuntimeImagePullTask | null>;
  interruptInFlight(input: { interruptedAt: string; reason: string }): Promise<RuntimeImagePullTask | null>;
  reset?(): void;
}

const SCHEDULER_RESTARTED = "scheduler_restarted";
const SCHEDULER_RESTARTED_MESSAGE = "Scheduler 重启，进行中的拉取已中断；请重新拉取。";

export function createMemoryRuntimeImagePullTaskStore(): RuntimeImagePullTaskStore {
  let latest: RuntimeImagePullTask | null = null;
  return {
    async save(task) {
      latest = clonePullTask(task);
    },
    async loadLatest() {
      return latest ? clonePullTask(latest) : null;
    },
    async interruptInFlight(input) {
      if (!latest || (latest.status !== "queued" && latest.status !== "running")) return latest ? clonePullTask(latest) : null;
      latest = markPullTaskInterrupted(latest, input);
      return clonePullTask(latest);
    },
    reset() {
      latest = null;
    },
  };
}

function clonePullTask(task: RuntimeImagePullTask): RuntimeImagePullTask {
  return {
    ...task,
    items: task.items.map((item) => ({ ...item })),
  };
}

export function markPullTaskInterrupted(
  task: RuntimeImagePullTask,
  input: { interruptedAt: string; reason: string },
): RuntimeImagePullTask {
  return {
    ...task,
    status: "interrupted",
    interrupted_at: input.interruptedAt,
    interrupt_reason: input.reason,
    error_code: SCHEDULER_RESTARTED,
    error: SCHEDULER_RESTARTED_MESSAGE,
    finished_at: task.finished_at ?? input.interruptedAt,
    items: task.items.map((item) => ({ ...item })),
  };
}

function asIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return null;
}

function rowToTask(row: Record<string, unknown>): RuntimeImagePullTask {
  const items = Array.isArray(row.items_json) ? row.items_json as RuntimeImagePullItem[] : [];
  return {
    task_id: String(row.task_id),
    purpose: String(row.purpose ?? ""),
    status: row.status as RuntimeImagePullTaskStatus,
    started_at: asIso(row.started_at),
    finished_at: asIso(row.finished_at),
    interrupted_at: asIso(row.interrupted_at),
    interrupt_reason: row.interrupt_reason == null ? null : String(row.interrupt_reason),
    error_code: row.error_code == null ? null : String(row.error_code),
    error: row.error == null ? null : String(row.error),
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    items,
  };
}

export function createSqlRuntimeImagePullTaskStore(
  db: typeof sql = sql,
): RuntimeImagePullTaskStore {
  return {
    async save(task) {
      await db`
        INSERT INTO runtime_image_pull_tasks (
          task_id, purpose, status, started_at, finished_at, interrupted_at, interrupt_reason,
          error_code, error, total, completed, items_json, updated_at
        ) VALUES (
          ${task.task_id},
          ${task.purpose ?? "admin_bulk"},
          ${task.status},
          ${task.started_at},
          ${task.finished_at},
          ${task.interrupted_at ?? null},
          ${task.interrupt_reason ?? null},
          ${task.error_code ?? null},
          ${task.error ?? null},
          ${task.total},
          ${task.completed},
          ${db.json(task.items as never)},
          now()
        )
        ON CONFLICT (task_id) DO UPDATE SET
          purpose = EXCLUDED.purpose,
          status = EXCLUDED.status,
          started_at = EXCLUDED.started_at,
          finished_at = EXCLUDED.finished_at,
          interrupted_at = EXCLUDED.interrupted_at,
          interrupt_reason = EXCLUDED.interrupt_reason,
          error_code = EXCLUDED.error_code,
          error = EXCLUDED.error,
          total = EXCLUDED.total,
          completed = EXCLUDED.completed,
          items_json = EXCLUDED.items_json,
          updated_at = now()`;
    },
    async loadLatest() {
      const [row] = await db<Record<string, unknown>[]>`
        SELECT * FROM runtime_image_pull_tasks ORDER BY created_at DESC LIMIT 1`;
      return row ? rowToTask(row) : null;
    },
    async interruptInFlight(input) {
      const rows = await db<Record<string, unknown>[]>`
        UPDATE runtime_image_pull_tasks
        SET status = 'interrupted',
            interrupted_at = ${input.interruptedAt},
            interrupt_reason = ${input.reason},
            error_code = ${SCHEDULER_RESTARTED},
            error = ${SCHEDULER_RESTARTED_MESSAGE},
            finished_at = COALESCE(finished_at, ${input.interruptedAt}::timestamptz),
            updated_at = now()
        WHERE status IN ('queued', 'running')
        RETURNING *`;
      if (rows[0]) return rowToTask(rows[0]);
      const [latest] = await db<Record<string, unknown>[]>`
        SELECT * FROM runtime_image_pull_tasks ORDER BY created_at DESC LIMIT 1`;
      return latest ? rowToTask(latest) : null;
    },
  };
}

let store: RuntimeImagePullTaskStore = createMemoryRuntimeImagePullTaskStore();

export function useRuntimeImagePullTaskStore(next: RuntimeImagePullTaskStore): void {
  store = next;
}

export function useSqlRuntimeImagePullTaskStore(): void {
  store = createSqlRuntimeImagePullTaskStore();
}

export function resetRuntimeImagePullTaskStore(): void {
  store = createMemoryRuntimeImagePullTaskStore();
}

export async function persistRuntimeImagePullTask(task: RuntimeImagePullTask): Promise<void> {
  try {
    await store.save(task);
  } catch (error) {
    console.warn(`[runtime-images] persist pull task failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadLatestRuntimeImagePullTask(): Promise<RuntimeImagePullTask | null> {
  try {
    return await store.loadLatest();
  } catch (error) {
    console.warn(`[runtime-images] load pull task failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function interruptInFlightRuntimeImagePullTasks(input: {
  interruptedAt: string;
  reason: string;
}): Promise<RuntimeImagePullTask | null> {
  try {
    return await store.interruptInFlight(input);
  } catch (error) {
    console.warn(`[runtime-images] interrupt pull tasks failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function pullItemPhase(status: RuntimeImagePullItemStatus | RuntimeImagePullTaskStatus | "idle"): string {
  if (status === "running") return "pulling";
  return status;
}

export function idleRuntimeImagePullStatus(checkedAt = new Date().toISOString()): RuntimeImagePullStatusView {
  return {
    task_id: null,
    purpose: "idle",
    status: "idle",
    phase: "idle",
    started_at: null,
    finished_at: null,
    interrupted_at: null,
    interrupt_reason: null,
    error_code: null,
    error: null,
    total: 0,
    completed: 0,
    items: [],
    checked_at: checkedAt,
  };
}

export function toRuntimeImagePullStatusView(
  task: RuntimeImagePullTask | null,
  checkedAt = new Date().toISOString(),
): RuntimeImagePullStatusView {
  if (!task) return idleRuntimeImagePullStatus(checkedAt);
  return {
    ...task,
    task_id: task.task_id,
    purpose: task.purpose ?? "admin_bulk",
    phase: pullItemPhase(task.status),
    interrupted_at: task.interrupted_at ?? null,
    interrupt_reason: task.interrupt_reason ?? null,
    error_code: task.error_code ?? null,
    error: task.error ?? null,
    checked_at: checkedAt,
    items: task.items.map((item) => ({
      ...item,
      phase: pullItemPhase(item.status),
      error_code: item.error_code ?? (item.status === "failed" ? "pull_failed" : null),
    })),
  };
}

/** Hub-facing errors must not echo executable OCI refs or digests. */
export function redactRuntimeImageReadinessError(text: string): string {
  return text
    .replace(/[A-Za-z0-9._/-]+@sha256:[a-fA-F0-9]{64}/g, "<image>")
    .replace(/sha256:[a-fA-F0-9]{64}/g, "sha256:<digest>")
    .replace(/\b(?:ghcr\.io|docker\.io|registry-[^\s,;]+|cr\.[^\s,;]+)\S*/g, "<registry>");
}
