import { recordSystemAudit } from "../../audit.js";
import type { sql as Sql } from "../../db.js";
import {
  canClaimQueuedTask as canClaimByModel,
  decideTaskQueueReconciliation,
  type ProjectTaskQueueBlockReason,
  type ProjectTaskQueueItemState,
  type ProjectTaskQueuePauseReason,
  type TaskQueueReconciliationInput,
} from "./task-queue-model.js";

type Db = typeof Sql;

const LIVE_JOB_STATUSES = ["pending", "claimed", "provisioning", "running", "waiting_human"] as const;
const CLAIMED_JOB_STATUSES = ["claimed", "provisioning", "running", "waiting_human"] as const;

export class TaskQueueError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "TaskQueueError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ProjectTaskQueueItemView {
  id: string;
  canvas_id: string;
  title: string;
  state: ProjectTaskQueueItemState;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  block_reason: ProjectTaskQueueBlockReason | null;
}

export interface ProjectTaskQueueView {
  project_id: string;
  paused: boolean;
  pause_reason: ProjectTaskQueuePauseReason | null;
  items: ProjectTaskQueueItemView[];
  has_more: boolean;
}

interface QueueItemRow {
  id: string;
  project_id: string;
  canvas_id: string;
  state: ProjectTaskQueueItemState;
  created_at: Date | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
}

interface QueueHead {
  id: string;
  project_id: string;
  canvas_id: string;
  state: ProjectTaskQueueItemState;
  created_at: Date | string;
  started_at: Date | string | null;
}

interface TaskSnapshot extends TaskQueueReconciliationInput {
  startedAt: Date | string | null;
}

function dateText(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function asQueueState(value: unknown): ProjectTaskQueueItemState {
  return String(value) as ProjectTaskQueueItemState;
}

function isPauseReason(value: unknown): value is ProjectTaskQueuePauseReason {
  return value === "manual" || value === "task_failed" || value === "task_cancelled";
}

function isTerminalState(state: ProjectTaskQueueItemState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

/**
 * Caller must hold DISPATCH_CLAIM_ADVISORY_KEY in this transaction. Initial
 * enrollment follows the prepared Job insert; retry enrollment never executes
 * or replays an effect and always takes a fresh queue position.
 */
export async function enqueueProjectTask(
  tx: Db,
  projectId: string,
  canvasId: string,
): Promise<{ id: string; project_id: string; canvas_id: string; state: ProjectTaskQueueItemState }> {
  const [canvas] = await tx`
    SELECT c.project_id::text AS project_id, c.status AS canvas_status, c.archived_at,
           p.status AS project_status, p.archived_at AS project_archived_at
    FROM canvases c JOIN projects p ON p.id = c.project_id
    WHERE c.id = ${canvasId}`;
  if (!canvas) throw new TaskQueueError("QUEUE_CANVAS_NOT_FOUND", "任务画布不存在");
  if (String(canvas.project_id) !== projectId) {
    throw new TaskQueueError("QUEUE_PROJECT_MISMATCH", "任务画布不属于指定项目");
  }
  if (canvas.project_status !== "active" || canvas.project_archived_at) {
    throw new TaskQueueError("QUEUE_PROJECT_ARCHIVED", "归档项目不能接收队列任务");
  }
  if (canvas.canvas_status !== "active" || canvas.archived_at) {
    throw new TaskQueueError("QUEUE_CANVAS_ARCHIVED", "归档任务不能进入项目队列");
  }

  const [existing] = await tx<QueueItemRow[]>`
    SELECT id::text, project_id::text, canvas_id, state, created_at, started_at, ended_at
    FROM project_task_queue_items WHERE canvas_id = ${canvasId} FOR UPDATE`;
  if (existing && (existing.state === "queued" || existing.state === "active")) {
    return {
      id: String(existing.id), project_id: String(existing.project_id), canvas_id: String(existing.canvas_id),
      state: existing.state,
    };
  }

  const [safety] = await tx`
    SELECT
      EXISTS (
        SELECT 1 FROM jobs
        WHERE canvas_id = ${canvasId} AND status = ANY(${CLAIMED_JOB_STATUSES})
      ) AS has_claimed_job,
      EXISTS (
        SELECT 1 FROM jobs j JOIN job_attempt_effects e ON e.job_id = j.id
        WHERE j.canvas_id = ${canvasId}
          AND (e.status IN ('effect_pending', 'unknown') OR (e.status = 'planned' AND e.effect_kind = 'agent_run'))
      ) AS has_unresolved_effect,
      EXISTS (
        SELECT 1 FROM jobs WHERE canvas_id = ${canvasId} AND status = 'pending'
      ) AS has_pending_job`;
  if (safety?.has_claimed_job) {
    throw new TaskQueueError("QUEUE_JOB_ACTIVE", "任务仍有已领取或执行中的 Job，不能进入队列");
  }
  if (safety?.has_unresolved_effect) {
    throw new TaskQueueError("QUEUE_UNKNOWN_EFFECT", "任务仍有未结清外部效果，不能重新排队");
  }
  if (!safety?.has_pending_job) {
    throw new TaskQueueError("QUEUE_NO_PENDING_JOB", "任务没有待领取 Job，不能创建队列占位");
  }

  await tx`INSERT INTO project_task_queues (project_id) VALUES (${projectId}) ON CONFLICT (project_id) DO NOTHING`;
  if (existing && isTerminalState(existing.state)) {
    const [requeued] = await tx`
      UPDATE project_task_queue_items
      SET id = nextval(pg_get_serial_sequence('project_task_queue_items', 'id')),
          state = 'queued', created_at = clock_timestamp(), started_at = NULL, ended_at = NULL
      WHERE id = ${existing.id}
      RETURNING id::text, project_id::text, canvas_id, state`;
    if (!requeued) throw new TaskQueueError("QUEUE_HEAD_CHANGED", "任务队列状态已变化，请重新读取");
    await recordSystemAudit({
      action: "task_queue.retry_enqueue",
      projectId,
      resourceType: "project_task_queue_item",
      resourceId: String(requeued.id),
      before: { canvas_id: canvasId, item_id: String(existing.id), state: existing.state },
      after: { canvas_id: canvasId, item_id: String(requeued.id), state: "queued" },
    }, tx as unknown as Db);
    return {
      id: String(requeued.id), project_id: String(requeued.project_id),
      canvas_id: String(requeued.canvas_id), state: asQueueState(requeued.state),
    };
  }

  const [inserted] = await tx`
    INSERT INTO project_task_queue_items (project_id, canvas_id)
    VALUES (${projectId}, ${canvasId})
    RETURNING id::text, project_id::text, canvas_id, state`;
  if (!inserted) throw new TaskQueueError("QUEUE_ITEM_CREATE_FAILED", "无法创建任务队列占位");
  return {
    id: String(inserted.id), project_id: String(inserted.project_id),
    canvas_id: String(inserted.canvas_id), state: asQueueState(inserted.state),
  };
}

async function readQueueHead(tx: Db, projectId: string): Promise<QueueHead | null> {
  const [head] = await tx<QueueHead[]>`
    SELECT id::text, project_id::text, canvas_id, state, created_at, started_at
    FROM project_task_queue_items
    WHERE project_id = ${projectId} AND state = 'active'
    ORDER BY id LIMIT 1`;
  if (head) return head;
  const [queued] = await tx<QueueHead[]>`
    SELECT id::text, project_id::text, canvas_id, state, created_at, started_at
    FROM project_task_queue_items
    WHERE project_id = ${projectId} AND state = 'queued'
    ORDER BY id LIMIT 1`;
  return queued ?? null;
}

async function readTaskSnapshot(tx: Db, head: QueueHead): Promise<TaskSnapshot | null> {
  const [row] = await tx`
    SELECT c.status AS canvas_status, c.archived_at AS canvas_archived_at,
           p.status AS project_status, p.archived_at AS project_archived_at,
           COALESCE(c.target_json #>> '{execution_control,paused}', 'false') = 'true' AS execution_paused,
           (SELECT COUNT(*)::int FROM jobs j
            WHERE j.canvas_id = c.id AND j.status = ANY(${LIVE_JOB_STATUSES})) AS active_job_count,
           (SELECT COUNT(*)::int FROM jobs j
            WHERE j.canvas_id = c.id AND j.status = 'waiting_human') AS waiting_human_count,
           EXISTS (
             SELECT 1 FROM jobs j JOIN job_attempt_effects e ON e.job_id = j.id
             WHERE j.canvas_id = c.id
               AND (e.status IN ('effect_pending', 'unknown') OR (e.status = 'planned' AND e.effect_kind = 'agent_run'))
           ) AS unresolved_effect,
           (SELECT MIN(j.started_at) FROM jobs j
            WHERE j.canvas_id = c.id AND j.started_at IS NOT NULL AND j.started_at >= ${head.created_at}) AS started_at,
           (SELECT j.status FROM jobs j WHERE j.canvas_id = c.id
              AND GREATEST(COALESCE(j.created_at, '-infinity'::timestamptz),
                           COALESCE(j.claimed_at, '-infinity'::timestamptz),
                           COALESCE(j.started_at, '-infinity'::timestamptz),
                           COALESCE(j.finished_at, '-infinity'::timestamptz)) >= ${head.created_at}
            ORDER BY GREATEST(COALESCE(j.created_at, '-infinity'::timestamptz),
                              COALESCE(j.claimed_at, '-infinity'::timestamptz),
                              COALESCE(j.started_at, '-infinity'::timestamptz),
                              COALESCE(j.finished_at, '-infinity'::timestamptz)) DESC,
                     j.created_at DESC, j.id DESC LIMIT 1) AS latest_job_status,
           (SELECT CASE WHEN n.updated_at >= fence.generation_at THEN n.status ELSE '__stale_completion__' END FROM canvas_nodes n
            WHERE n.canvas_id = c.id AND n.node_type = 'root'
            ORDER BY n.updated_at DESC, n.id DESC LIMIT 1) AS root_status,
           (SELECT CASE WHEN tr.updated_at >= fence.generation_at THEN tr.status ELSE '__stale_completion__' END FROM task_reports tr
            WHERE tr.canvas_id = c.id ORDER BY tr.version DESC, tr.id DESC LIMIT 1) AS task_report_status,
           (SELECT CASE WHEN n.updated_at >= fence.generation_at THEN n.status ELSE '__stale_completion__' END FROM canvas_nodes n
            WHERE n.canvas_id = c.id AND n.node_type = 'report'
            ORDER BY n.updated_at DESC, n.id DESC LIMIT 1) AS report_node_status
    FROM canvases c JOIN projects p ON p.id = c.project_id
    LEFT JOIN LATERAL (
      SELECT GREATEST(
        ${head.created_at}::timestamptz,
        COALESCE(MAX(GREATEST(
          COALESCE(j.created_at, '-infinity'::timestamptz),
          COALESCE(j.claimed_at, '-infinity'::timestamptz),
          COALESCE(j.started_at, '-infinity'::timestamptz)
        )), ${head.created_at}::timestamptz)
      ) AS generation_at
      FROM jobs j WHERE j.canvas_id = c.id
    ) fence ON true
    WHERE c.id = ${head.canvas_id} AND c.project_id = ${head.project_id}`;
  if (!row) return null;
  return {
    canvasArchived: row.canvas_status !== "active" || Boolean(row.canvas_archived_at),
    projectArchived: row.project_status !== "active" || Boolean(row.project_archived_at),
    executionPaused: row.execution_paused === true,
    activeJobCount: Number(row.active_job_count ?? 0),
    waitingHumanCount: Number(row.waiting_human_count ?? 0),
    unresolvedEffect: row.unresolved_effect === true,
    hasStarted: row.started_at !== null && row.started_at !== undefined,
    startedAt: (row.started_at as Date | string | null) ?? null,
    itemState: head.state,
    queuePaused: false,
    latestJobStatus: (row.latest_job_status as string | null) ?? null,
    rootStatus: (row.root_status as string | null) ?? null,
    currentTaskReportStatus: (row.task_report_status as string | null) ?? null,
    reportNodeStatus: (row.report_node_status as string | null) ?? null,
  };
}

async function reconcileQueueHead(tx: Db, projectId: string): Promise<boolean> {
  const head = await readQueueHead(tx, projectId);
  if (!head) return false;
  const [queue] = await tx`SELECT paused, pause_reason FROM project_task_queues WHERE project_id = ${projectId}`;
  const snapshot = await readTaskSnapshot(tx, head);
  if (!snapshot) return false;
  snapshot.queuePaused = queue?.paused === true;

  if (snapshot.hasStarted && head.started_at === null) {
    await tx`
      UPDATE project_task_queue_items SET started_at = ${snapshot.startedAt}
      WHERE id = ${head.id} AND started_at IS NULL AND state IN ('queued','active')`;
  }

  const decision = decideTaskQueueReconciliation(snapshot);
  if (decision.kind === "succeed") {
    const [updated] = await tx`
      UPDATE project_task_queue_items
      SET state = 'succeeded', ended_at = clock_timestamp()
      WHERE id = ${head.id} AND state = 'active'
      RETURNING id::text`;
    if (!updated) return false;
    const previousPauseReason = isPauseReason(queue?.pause_reason) ? queue.pause_reason : null;
    if (previousPauseReason === "task_failed" || previousPauseReason === "task_cancelled") {
      await tx`
        UPDATE project_task_queues SET paused = false, pause_reason = NULL, updated_at = clock_timestamp()
        WHERE project_id = ${projectId}`;
    }
    await recordSystemAudit({
      action: "task_queue.task_succeeded",
      projectId,
      resourceType: "project_task_queue_item",
      resourceId: String(head.id),
      before: { canvas_id: head.canvas_id, item_id: String(head.id), state: head.state },
      after: { canvas_id: head.canvas_id, item_id: String(head.id), state: "succeeded" },
    }, tx as unknown as Db);
    return true;
  }

  if (decision.kind === "pause") {
    const preserveManualPause = queue?.paused === true && queue.pause_reason === "manual";
    const changedPause = !preserveManualPause
      && (queue?.paused !== true || queue?.pause_reason !== decision.pauseReason);
    if (changedPause) {
      await tx`
        UPDATE project_task_queues
        SET paused = true, pause_reason = ${decision.pauseReason}, updated_at = clock_timestamp()
        WHERE project_id = ${projectId}`;
    }
    if (changedPause) {
      await recordSystemAudit({
        action: decision.pauseReason === "task_cancelled" ? "task_queue.task_cancelled" : "task_queue.task_failed",
        projectId,
        resourceType: "project_task_queue_item",
        resourceId: String(head.id),
        before: {
          canvas_id: head.canvas_id, item_id: String(head.id), state: head.state,
          paused: queue?.paused === true, pause_reason: queue?.pause_reason ?? null,
        },
        after: {
          canvas_id: head.canvas_id, item_id: String(head.id), state: head.state,
          paused: true, pause_reason: decision.pauseReason,
        },
      }, tx as unknown as Db);
    }
    return changedPause;
  }
  return false;
}

/**
 * The caller owns DISPATCH_CLAIM_ADVISORY_KEY. Queue timestamps advance on
 * every inspected live queue, so bounded scans rotate fairly across projects.
 */
export async function reconcileProjectTaskQueues(tx: Db, limit = 32): Promise<number> {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 32;
  if (boundedLimit === 0) return 0;
  const queues = await tx<{ project_id: string }[]>`
    SELECT q.project_id::text
    FROM project_task_queues q
    WHERE EXISTS (
      SELECT 1 FROM project_task_queue_items i
      WHERE i.project_id = q.project_id AND i.state IN ('queued','active')
    )
    ORDER BY q.reconciled_at ASC, q.project_id ASC
    LIMIT ${boundedLimit}`;
  for (const queue of queues) {
    const projectId = String(queue.project_id);
    await tx`
      UPDATE project_task_queues SET reconciled_at = clock_timestamp()
      WHERE project_id = ${projectId}`;
    await reconcileQueueHead(tx, projectId);
  }
  return queues.length;
}

/**
 * Must run after the caller obtains the shared dispatch claim advisory lock.
 * A retry of a terminal membership is moved to the tail only when a legitimate
 * pending Job exists and no in-flight Job or unresolved external effect remains.
 */
export async function canClaimQueuedTask(tx: Db, projectId: string, canvasId: string): Promise<boolean> {
  const [canvas] = await tx`
    SELECT cv.project_id::text, cv.status, cv.archived_at, p.status AS project_status, p.archived_at AS project_archived_at
    FROM canvases cv JOIN projects p ON p.id = cv.project_id WHERE cv.id = ${canvasId}`;
  if (!canvas || String(canvas.project_id) !== projectId || canvas.status !== "active" || canvas.archived_at
    || canvas.project_status !== "active" || canvas.project_archived_at) return false;
  const [membership] = await tx<QueueItemRow[]>`
    SELECT id::text, project_id::text, canvas_id, state, created_at, started_at, ended_at
    FROM project_task_queue_items WHERE canvas_id = ${canvasId}`;
  if (!membership) return true;
  if (String(membership.project_id) !== projectId) return false;

  // The bounded global reconciliation pass may not have reached this project.
  // Reconcile its current head before judging a queued candidate so one old
  // active head cannot indefinitely strand the next pending task.
  await reconcileQueueHead(tx, projectId);
  const [currentMembership] = await tx<QueueItemRow[]>`
    SELECT id::text, project_id::text, canvas_id, state, created_at, started_at, ended_at
    FROM project_task_queue_items WHERE canvas_id = ${canvasId}`;
  if (!currentMembership) return true;
  if (String(currentMembership.project_id) !== projectId) return false;
  if (isTerminalState(currentMembership.state)) {
    try {
      await enqueueProjectTask(tx, projectId, canvasId);
    } catch (error) {
      if (error instanceof TaskQueueError) return false;
      throw error;
    }
  }

  const [queue] = await tx`SELECT paused FROM project_task_queues WHERE project_id = ${projectId}`;
  const head = await readQueueHead(tx, projectId);
  const [current] = await tx`
    SELECT state FROM project_task_queue_items WHERE canvas_id = ${canvasId} AND project_id = ${projectId}`;
  return canClaimByModel({
    queuePaused: queue?.paused === true,
    itemState: current ? asQueueState(current.state) : null,
    isHead: head?.canvas_id === canvasId,
  });
}

/** Called only after Job lifecycle CAS succeeds, in the same claim transaction. */
export async function markQueuedTaskClaimed(tx: Db, projectId: string, canvasId: string): Promise<void> {
  const [membership] = await tx<QueueItemRow[]>`
    SELECT id::text, project_id::text, canvas_id, state, created_at, started_at, ended_at
    FROM project_task_queue_items WHERE canvas_id = ${canvasId} FOR UPDATE`;
  if (!membership) return;
  if (String(membership.project_id) !== projectId) {
    throw new TaskQueueError("QUEUE_PROJECT_MISMATCH", "Job 与任务队列项目不一致");
  }
  const [queue] = await tx`SELECT paused FROM project_task_queues WHERE project_id = ${projectId}`;
  const head = await readQueueHead(tx, projectId);
  if (!canClaimByModel({
    queuePaused: queue?.paused === true,
    itemState: membership.state,
    isHead: head?.canvas_id === canvasId,
  })) {
    throw new TaskQueueError("QUEUE_HEAD_CHANGED", "任务不再是可领取的队列队首");
  }
  if (membership.state === "queued") {
    await tx`
      UPDATE project_task_queue_items SET state = 'active'
      WHERE id = ${membership.id} AND state = 'queued'`;
  }
}

function readBlockReason(
  snapshot: TaskQueueReconciliationInput,
  state: ProjectTaskQueueItemState,
  isHead: boolean,
  pauseReason: unknown,
): ProjectTaskQueueBlockReason | null {
  if (isTerminalState(state)) return null;
  if (!isHead) return snapshot.queuePaused ? "queue_paused" : "waiting_turn";
  const decision = decideTaskQueueReconciliation(snapshot);
  if (decision.kind === "pause") return decision.pauseReason;
  if (decision.kind === "hold") return decision.blockReason;
  if (pauseReason === "task_failed" || pauseReason === "task_cancelled") return pauseReason;
  if (state === "queued" && snapshot.queuePaused) return "queue_paused";
  return null;
}

/** Read a bounded current+waiting projection followed by the newest history. */
export async function readProjectTaskQueue(db: Db, projectId: string): Promise<ProjectTaskQueueView> {
  const [queue] = await db`
    SELECT project_id::text, paused, pause_reason FROM project_task_queues WHERE project_id = ${projectId}`;
  const rows = await db<any[]>`
    WITH active_item AS MATERIALIZED (
      SELECT i.id, i.project_id, i.canvas_id, i.state, i.created_at, i.started_at, i.ended_at,
             0 AS bucket, i.id AS order_id
      FROM project_task_queue_items i
      WHERE i.project_id = ${projectId} AND i.state = 'active'
      ORDER BY i.id LIMIT 1
    ),
    queued_items AS MATERIALIZED (
      SELECT i.id, i.project_id, i.canvas_id, i.state, i.created_at, i.started_at, i.ended_at,
             0 AS bucket, i.id AS order_id
      FROM project_task_queue_items i
      WHERE i.project_id = ${projectId} AND i.state = 'queued'
      ORDER BY i.id LIMIT 101
    ),
    live_items AS MATERIALIZED (
      SELECT * FROM active_item UNION ALL SELECT * FROM queued_items
    ),
    history_items AS MATERIALIZED (
      SELECT i.id, i.project_id, i.canvas_id, i.state, i.created_at, i.started_at, i.ended_at,
             1 AS bucket, -i.id AS order_id
      FROM project_task_queue_items i
      WHERE i.project_id = ${projectId} AND i.state IN ('succeeded','failed','cancelled')
      ORDER BY i.id DESC LIMIT 101
    ),
    candidates AS MATERIALIZED (
      SELECT * FROM live_items UNION ALL SELECT * FROM history_items
    ),
    numbered AS (
      SELECT c.*, row_number() OVER (ORDER BY bucket, order_id ASC) AS row_no
      FROM candidates c
    ),
    head AS (
      SELECT canvas_id FROM (
        (SELECT canvas_id, 0 AS bucket, id AS order_id
         FROM project_task_queue_items WHERE project_id = ${projectId} AND state = 'active'
         ORDER BY id LIMIT 1)
        UNION ALL
        (SELECT canvas_id, 1 AS bucket, id AS order_id
         FROM project_task_queue_items WHERE project_id = ${projectId} AND state = 'queued'
         ORDER BY id LIMIT 1)
      ) h ORDER BY bucket, order_id LIMIT 1
    )
    SELECT n.id::text, n.project_id::text, n.canvas_id, c.title, n.state,
           n.created_at, n.started_at, n.ended_at,
           (head.canvas_id = n.canvas_id) AS is_head,
           c.status AS canvas_status, c.archived_at AS canvas_archived_at,
           p.status AS project_status, p.archived_at AS project_archived_at,
           COALESCE(c.target_json #>> '{execution_control,paused}', 'false') = 'true' AS execution_paused,
           (SELECT COUNT(*)::int FROM jobs j
            WHERE j.canvas_id = c.id AND j.status = ANY(${LIVE_JOB_STATUSES})) AS active_job_count,
           (SELECT COUNT(*)::int FROM jobs j
            WHERE j.canvas_id = c.id AND j.status = 'waiting_human') AS waiting_human_count,
           EXISTS (
             SELECT 1 FROM jobs j JOIN job_attempt_effects e ON e.job_id = j.id
             WHERE j.canvas_id = c.id
               AND (e.status IN ('effect_pending', 'unknown') OR (e.status = 'planned' AND e.effect_kind = 'agent_run'))
           ) AS unresolved_effect,
           EXISTS (SELECT 1 FROM jobs j WHERE j.canvas_id = c.id
                   AND j.started_at IS NOT NULL AND j.started_at >= n.created_at) AS has_started,
           (SELECT j.status FROM jobs j WHERE j.canvas_id = c.id
              AND GREATEST(COALESCE(j.created_at, '-infinity'::timestamptz),
                           COALESCE(j.claimed_at, '-infinity'::timestamptz),
                           COALESCE(j.started_at, '-infinity'::timestamptz),
                           COALESCE(j.finished_at, '-infinity'::timestamptz)) >= n.created_at
            ORDER BY GREATEST(COALESCE(j.created_at, '-infinity'::timestamptz),
                              COALESCE(j.claimed_at, '-infinity'::timestamptz),
                              COALESCE(j.started_at, '-infinity'::timestamptz),
                              COALESCE(j.finished_at, '-infinity'::timestamptz)) DESC,
                     j.created_at DESC, j.id DESC LIMIT 1) AS latest_job_status,
           (SELECT CASE WHEN r.updated_at >= fence.generation_at THEN r.status ELSE '__stale_completion__' END
            FROM canvas_nodes r WHERE r.canvas_id = c.id AND r.node_type = 'root'
            ORDER BY r.updated_at DESC, r.id DESC LIMIT 1) AS root_status,
           (SELECT CASE WHEN tr.updated_at >= fence.generation_at THEN tr.status ELSE '__stale_completion__' END
            FROM task_reports tr WHERE tr.canvas_id = c.id
            ORDER BY tr.version DESC, tr.id DESC LIMIT 1) AS task_report_status,
           (SELECT CASE WHEN r.updated_at >= fence.generation_at THEN r.status ELSE '__stale_completion__' END
            FROM canvas_nodes r WHERE r.canvas_id = c.id AND r.node_type = 'report'
            ORDER BY r.updated_at DESC, r.id DESC LIMIT 1) AS report_node_status,
           (SELECT COUNT(*)::int FROM live_items) AS live_candidate_count,
           (SELECT COUNT(*)::int FROM history_items) AS history_candidate_count
    FROM numbered n
    JOIN canvases c ON c.id = n.canvas_id
    JOIN projects p ON p.id = n.project_id
    LEFT JOIN head ON true
    LEFT JOIN LATERAL (
      SELECT GREATEST(
        n.created_at,
        COALESCE(MAX(GREATEST(
          COALESCE(j.created_at, '-infinity'::timestamptz),
          COALESCE(j.claimed_at, '-infinity'::timestamptz),
          COALESCE(j.started_at, '-infinity'::timestamptz)
        )), n.created_at)
      ) AS generation_at
      FROM jobs j WHERE j.canvas_id = c.id
    ) fence ON true
    WHERE n.row_no <= 100
    ORDER BY n.row_no`;
  const liveCandidateCount = Number(rows[0]?.live_candidate_count ?? 0);
  const historyCandidateCount = Number(rows[0]?.history_candidate_count ?? 0);
  const historyRoom = Math.max(0, 100 - liveCandidateCount);
  const hasMore = liveCandidateCount > 100 || historyCandidateCount > historyRoom;
  const pauseReason = isPauseReason(queue?.pause_reason) ? queue.pause_reason : null;
  const items = rows.map((row) => {
    const state = asQueueState(row.state);
    const snapshot: TaskQueueReconciliationInput = {
      canvasArchived: row.canvas_status !== "active" || Boolean(row.canvas_archived_at),
      projectArchived: row.project_status !== "active" || Boolean(row.project_archived_at),
      executionPaused: row.execution_paused === true,
      activeJobCount: Number(row.active_job_count ?? 0),
      waitingHumanCount: Number(row.waiting_human_count ?? 0),
      unresolvedEffect: row.unresolved_effect === true,
      hasStarted: row.has_started === true,
      itemState: state,
      queuePaused: queue?.paused === true,
      latestJobStatus: (row.latest_job_status as string | null) ?? null,
      rootStatus: (row.root_status as string | null) ?? null,
      currentTaskReportStatus: (row.task_report_status as string | null) ?? null,
      reportNodeStatus: (row.report_node_status as string | null) ?? null,
    };
    return {
      id: String(row.id),
      canvas_id: String(row.canvas_id),
      title: String(row.title),
      state,
      created_at: dateText(row.created_at) ?? "",
      started_at: dateText(row.started_at),
      ended_at: dateText(row.ended_at),
      block_reason: readBlockReason(snapshot, state, row.is_head === true, pauseReason),
    } satisfies ProjectTaskQueueItemView;
  });
  return {
    project_id: projectId,
    paused: queue?.paused === true,
    pause_reason: pauseReason,
    items,
    has_more: hasMore,
  };
}

/** Pause retains live work; resuming a failed head requires its current item id. */
export async function setProjectTaskQueuePaused(
  tx: Db,
  projectId: string,
  paused: boolean,
  acknowledgeFailedHead?: string,
): Promise<ProjectTaskQueueView> {
  const [project] = await tx`SELECT id FROM projects WHERE id = ${projectId} FOR SHARE`;
  if (!project) throw new TaskQueueError("QUEUE_PROJECT_NOT_FOUND", "项目不存在", 404);
  await tx`INSERT INTO project_task_queues (project_id) VALUES (${projectId}) ON CONFLICT (project_id) DO NOTHING`;
  if (!paused) await reconcileQueueHead(tx, projectId);
  const [queue] = await tx`
    SELECT paused, pause_reason FROM project_task_queues WHERE project_id = ${projectId} FOR UPDATE`;
  if (paused) {
    if (acknowledgeFailedHead !== undefined) {
      throw new TaskQueueError("QUEUE_HEAD_CHANGED", "恢复确认不能用于暂停请求");
    }
    if (queue?.paused !== true || queue.pause_reason !== "manual") {
      await tx`
        UPDATE project_task_queues SET paused = true, pause_reason = 'manual', updated_at = clock_timestamp()
        WHERE project_id = ${projectId}`;
    }
    return readProjectTaskQueue(tx, projectId);
  }

  const head = await readQueueHead(tx, projectId);
  const snapshot = head ? await readTaskSnapshot(tx, head) : null;
  if (snapshot?.unresolvedEffect) {
    throw new TaskQueueError("QUEUE_RESUME_UNKNOWN_EFFECT", "队首任务仍有未结清外部效果，不能恢复队列");
  }
  const decision = snapshot ? decideTaskQueueReconciliation(snapshot) : null;
  const failurePaused = queue?.paused === true
    && (queue.pause_reason === "task_failed" || queue.pause_reason === "task_cancelled");
  const manualFailure = queue?.paused === true && queue.pause_reason === "manual" && decision?.kind === "pause";
  if (acknowledgeFailedHead !== undefined && !failurePaused && !manualFailure) {
    throw new TaskQueueError("QUEUE_HEAD_CHANGED", "失败队首确认已过期，请重新读取队列");
  }

  if (failurePaused || manualFailure) {
    if (!head || (head.state !== "active" && head.state !== "queued") || !snapshot) {
      throw new TaskQueueError("QUEUE_HEAD_CHANGED", "失败队首已变化，请重新读取队列");
    }
    if (snapshot.activeJobCount > 0) {
      throw new TaskQueueError("QUEUE_RESUME_ACTIVE_JOB", "失败队首仍有待领取或执行中的 Job，不能确认结清");
    }
    if (acknowledgeFailedHead === undefined) {
      throw new TaskQueueError("QUEUE_FAILED_HEAD_ACK_REQUIRED", "恢复前需要确认当前失败队首");
    }
    if (acknowledgeFailedHead !== String(head.id)) {
      throw new TaskQueueError("QUEUE_HEAD_CHANGED", "失败队首已变化，请重新读取并确认当前队首");
    }
    if (snapshot.executionPaused || snapshot.canvasArchived || snapshot.projectArchived) {
      throw new TaskQueueError("QUEUE_RESUME_HEAD_BLOCKED", "队首任务仍处于暂停或归档状态，不能结清");
    }
    if (decision?.kind !== "pause") {
      throw new TaskQueueError("QUEUE_RESUME_HEAD_NOT_TERMINAL", "当前队首没有可确认的失败或取消终态");
    }
    const terminalState = decision.pauseReason === "task_cancelled" ? "cancelled" : "failed";
    const [settled] = await tx`
      UPDATE project_task_queue_items SET state = ${terminalState}, ended_at = clock_timestamp()
      WHERE id = ${head.id} AND state IN ('active','queued')
      RETURNING id::text`;
    if (!settled) throw new TaskQueueError("QUEUE_HEAD_CHANGED", "失败队首已变化，请重新读取队列");
    await tx`
      UPDATE project_task_queues SET paused = false, pause_reason = NULL, updated_at = clock_timestamp()
      WHERE project_id = ${projectId}`;
    await recordSystemAudit({
      action: "task_queue.failed_head_acknowledged",
      projectId,
      resourceType: "project_task_queue_item",
      resourceId: String(head.id),
      before: { canvas_id: head.canvas_id, item_id: String(head.id), state: head.state, pause_reason: queue.pause_reason },
      after: { canvas_id: head.canvas_id, item_id: String(head.id), state: terminalState, paused: false, pause_reason: null },
    }, tx as unknown as Db);
    return readProjectTaskQueue(tx, projectId);
  }

  if (queue?.paused !== true) {
    if (acknowledgeFailedHead !== undefined) {
      throw new TaskQueueError("QUEUE_HEAD_CHANGED", "失败队首确认已过期，请重新读取队列");
    }
    return readProjectTaskQueue(tx, projectId);
  }

  await tx`
    UPDATE project_task_queues SET paused = false, pause_reason = NULL, updated_at = clock_timestamp()
    WHERE project_id = ${projectId}`;
  return readProjectTaskQueue(tx, projectId);
}
