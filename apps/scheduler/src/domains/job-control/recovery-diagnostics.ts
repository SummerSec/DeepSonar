/**
 * Operator 友好的只读诊断面（#1036 A item1 / D item3）。
 *
 * — `readWaitingclassification`：跨 Job 历史等待分类盘点（业务决定 / 授权等待 /
 *   未知效果 / 已确认平台死路 / 无信号）。
 * — `readRecoveryDiagnostics`：单 Job 的未结清效果 + 修正预算 + 既有平台动作引用。
 *
 * 两条都是纯 SELECT 投影：不改状态机、不登记 receipt、不扩大动作。分类只使用
 * 内核事实（jobs/events/job_attempt_effects/canvases 的持久字段），不读取
 * runtime 进程内存 registry（batch 面在无 host 注册处仍可运行）。所有业务文本
 * （summary/message/effect error 原文）不出现在响应里：本文件是诊断面，不是
 * 证据检索面，人工看原文走 `/jobs/:id/evidence*`。
 */
import { sql } from "../../db.js";
import { COMPLETION_REPAIR_LIMIT, completionReceiptId } from "../event-ingestion/completion-receipt.js";
import { readRepairTokenBudget, readRepairTokenBudgets, type RepairTokenBudget } from "../event-ingestion/repair-token-budget.js";

type Database = typeof sql;

export const WAITING_CLASSIFICATION_STATUSES = ["waiting_human", "failed", "timeout", "orphan"] as const;
export const WAITING_CLASSIFICATION_MAX_LIMIT = 100;

/** 与 #1036 A 项一致的四类主分类；无内核信号时显式 `no_signal`，不臆测。 */
export type WaitingCategory =
  | "unknown_effects"
  | "confirmed_platform_dead_end"
  | "human_decision"
  | "authorized_operator"
  | "no_signal";

export interface WaitingRow {
  id: string;
  project_id: string;
  canvas_id: string | null;
  type: string;
  status: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  human_subject_kind: string | null;
  rejected_completions: number;
  last_completion_receipt: string | null;
  unresolved_effects: number;
  unresolved_effect_kinds: string[] | null;
  /** 规范化后的布尔（未传前 raw 列名 objective_status）。 */
  objective_stopped: boolean;
  objective_raw_status: string | null;
}

export interface WaitingClassificationEntry {
  job_id: string;
  project_id: string;
  canvas_id: string | null;
  type: string;
  status: "waiting_human" | "failed" | "timeout" | "orphan";
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  category: WaitingCategory;
  /** 细分信号；只含枚举/计数，不含业务文本（脱敏边界）。 */
  signals: {
    unresolved_effect_count: number;
    unresolved_effect_kinds: string[];
    human_subject_kind: string | null;
    rejected_completion_count: number;
    /**
     * `true` 表示已按内核回执身份（event_dedup/Attempt 归属 + 事件 ID 派生 + 4xx/5xx
     * accepted:false）逐条核对通过，`false` 表示形状像回执但不满足内核身份、
     * 不能据此判平台死路，`null` 表示未到阈值、无需核对。
     */
    rejected_completion_verified: boolean | null;
    completion_accepted: boolean;
    plan_objective_stopped: boolean;
  };
  budget: {
    usage_status: "known" | "pending" | "unknown" | null;
    remaining_tokens: number | null;
    deadline_exhausted: boolean;
  } | null;
}

const HUMAN_DECISION_KINDS = new Set(["business_decision", "high_risk_action", "finding"]);
const HUMAN_AUTHORIZED_KINDS = new Set(["authorization", "credential"]);
const HUMAN_TOPIC_KIND_RE = /^[a-z0-9_]{1,48}$/;

function normalizeSubjectKind(value: string | null): string | null {
  if (value === null || !HUMAN_TOPIC_KIND_RE.test(value)) return null;
  return value;
}

export function waitingRowToEntry(
  row: WaitingRow,
  budget: RepairTokenBudget | null,
  /** 只在计数达到阈值时由调用方做内核身份核对；不足阈值时为 null。 */
  rejectedCompletionVerified: boolean | null = null,
): WaitingClassificationEntry {
  const unresolvedKinds = Array.isArray(row.unresolved_effect_kinds) ? [...new Set(row.unresolved_effect_kinds)] : [];
  const completed = row.last_completion_receipt === "persisted_deferred";
  const deadlineElapsed = Boolean(budget?.deadline && Date.parse(budget.deadline) <= Date.now());
  const budgetExhausted = budget
    ? budget.usage_status !== "known" || deadlineElapsed || budget.remaining_tokens === 0
    : false;
  // 分类优先级与 #1036 A 一致：未知效果不受其它信号影响；死路只在无未结清
  // 效果时才判，避免把可对账的窗口误报成终点；再按人工类，最后 fallback。
  let category: WaitingCategory;
  if (row.unresolved_effects > 0) category = "unknown_effects";
  else if (row.objective_stopped
    || (row.rejected_completions >= COMPLETION_REPAIR_LIMIT && rejectedCompletionVerified !== false)) {
    category = "confirmed_platform_dead_end";
  } else if (HUMAN_AUTHORIZED_KINDS.has(row.human_subject_kind ?? "")) category = "authorized_operator";
  else if (HUMAN_DECISION_KINDS.has(row.human_subject_kind ?? "")) category = "human_decision";
  else category = "no_signal";
  return {
    job_id: row.id,
    project_id: row.project_id,
    canvas_id: row.canvas_id,
    type: row.type,
    status: row.status as WaitingClassificationEntry["status"],
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    category,
    signals: {
      unresolved_effect_count: row.unresolved_effects,
      unresolved_effect_kinds: unresolvedKinds,
      human_subject_kind: normalizeSubjectKind(row.human_subject_kind),
      rejected_completion_count: row.rejected_completions,
      rejected_completion_verified: rejectedCompletionVerified,
      completion_accepted: completed,
      plan_objective_stopped: row.objective_stopped,
    },
    budget: budget ? {
      usage_status: budget.usage_status,
      remaining_tokens: budget.remaining_tokens,
      deadline_exhausted: budget.usage_status === "known" && deadlineElapsed,
    } : null,
  };
}

/** 只读跨 Job 盘点。行内不携带 summary/message/effect error 文本（脱敏边界见文件头）。 */
export async function readWaitingClassification(input: {
  db?: Database;
  projectIds?: readonly string[];
  statuses?: readonly (typeof WAITING_CLASSIFICATION_STATUSES)[number][];
  limit?: number;
}): Promise<WaitingClassificationEntry[]> {
  const db = input.db ?? sql;
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > WAITING_CLASSIFICATION_MAX_LIMIT) {
    throw new Error(`invalid waiting classification limit; expected 1..${WAITING_CLASSIFICATION_MAX_LIMIT}`);
  }
  const statuses = (input.statuses ?? [...WAITING_CLASSIFICATION_STATUSES]).filter(value =>
    (WAITING_CLASSIFICATION_STATUSES as readonly string[]).includes(value));
  if (!statuses.length) return [];
  const projectIds = (input.projectIds ?? []).map((value) => value.toLowerCase());
  const rows = await db<WaitingRow[]>`
    SELECT j.id, j.project_id::text AS project_id, j.canvas_id, j.type, j.status,
      j.created_at, j.started_at, j.finished_at,
      (SELECT e.payload_json->'subject'->>'kind' FROM events e
        WHERE e.job_id = j.id AND e.type='human' ORDER BY e.job_seq DESC LIMIT 1) AS human_subject_kind,
      (SELECT count(*)::int FROM events e WHERE e.job_id = j.id AND e.type='control_receipt'
        AND e.payload_json->>'operation'='mark_job_done' AND e.payload_json->>'status'='rejected') AS rejected_completions,
      (SELECT e.payload_json->>'status' FROM events e
        WHERE e.job_id = j.id AND e.type='control_receipt' AND e.payload_json->>'operation'='mark_job_done'
        ORDER BY e.job_seq DESC LIMIT 1) AS last_completion_receipt,
      (SELECT count(*)::int FROM job_attempt_effects e
        WHERE e.job_id = j.id AND e.status IN ('unknown','effect_pending')) AS unresolved_effects,
      (SELECT array_agg(DISTINCT e.effect_kind) FROM job_attempt_effects e
        WHERE e.job_id = j.id AND e.status IN ('unknown','effect_pending')) AS unresolved_effect_kinds,
      (c.target_json->'plan_objective'->>'status') AS objective_raw_status
    FROM jobs j
    LEFT JOIN canvases c ON c.id = j.canvas_id
    WHERE j.status = ANY(${statuses}::text[])
      AND (${projectIds.length === 0} OR j.project_id::text = ANY(${projectIds}::text[]))
    ORDER BY j.created_at DESC, j.id DESC
    LIMIT ${limit}`;
  const budgets = await readRepairTokenBudgets(db, rows.map((row) => String(row.id)));
  const entries: WaitingClassificationEntry[] = [];
  for (const row of rows) {
    const subject = normalizeSubjectKind(row.human_subject_kind);
    const budget = budgets.get(String(row.id)) ?? null;
    const normalized: WaitingRow = { ...row, human_subject_kind: subject,
      objective_stopped: row.objective_raw_status === "stopped" };
    const verified = row.objective_raw_status === "stopped" || row.rejected_completions < COMPLETION_REPAIR_LIMIT
      ? null : await verifyCompletionRepairExhausted(db, String(row.id));
    entries.push(waitingRowToEntry(normalized, budget, verified));
  }
  return entries;
}

export interface UnresolvedEffectDiagnosticRow {
  effect_id: string;
  effect_kind: string;
  status: "unknown" | "effect_pending";
  step: number;
  created_at: Date;
  updated_at: Date;
  ledger_settlement_status: string | null;
  ledger_usage_tokens: number | null;
  operator_settled: boolean;
  replay_policy: string;
  attempt_id: string;
}

export interface RecoveryDiagnostics {
  job_id: string;
  status: string;
  project_id: string;
  classification: {
    category: WaitingCategory;
    signals: WaitingClassificationEntry["signals"];
  };
  unresolved_effects: UnresolvedEffectDiagnosticRow[];
  repair_budget: {
    receipt_ref: string;
    attempt_id: string;
    usage_status: "known" | "pending" | "unknown";
    known_tokens: number;
    remaining_tokens: number | null;
    deadline: string | null;
  } | null;
  /** 只引用既有平台入口，不发明新动作；执行前仍按各自现有语命校验。 */
  next_actions: Array<{ action: string; method?: "POST"; path: string; note: string }>;
}

const OPERATOR_NOTE_SETTLE =
  "同 Job 活动或排队执行仍在时拒绝结清；完成后按现有 governance 以单条 evidence 结清该 effect（不回放、不改用量）";
const OPERATOR_NOTE_JOB = "Job 行包含 attempt/session/用量与错误摘要；原文/会话走 evidence 端点，不在本诊断复述";

/** 单 Job 诊断（#1036 D item3）：人工结清后 usage 仍未知等场景的可查询下一步。 */
export async function readRecoveryDiagnostics(db0: Database, jobId: string): Promise<RecoveryDiagnostics | null> {
  const db = db0;
  const [job] = await db`SELECT id::text AS id, project_id::text AS project_id, status FROM jobs WHERE id=${jobId}`;
  if (!job) return null;
  const [waitingRows] = await readWaitingClassificationRowsForJob(db, jobId);
  const budget = await readRepairTokenBudget(db, String(job.id));
  const effects = await db<UnresolvedEffectDiagnosticRaw[]>`
    SELECT e.id::text AS effect_ref, e.effect_kind, e.status, e.step, e.created_at, e.updated_at,
      e.replay_policy, e.attempt_id::text AS attempt_id, e.settlement_json->>'reconciled_by' AS reconciled_by,
      l.settlement_status AS ledger_settlement_status, l.total_tokens AS ledger_usage_tokens
    FROM job_attempt_effects e
    LEFT JOIN job_usage_ledger l ON l.attempt_id = e.attempt_id AND l.effect_id = e.effect_id
    WHERE e.job_id = ${jobId} AND e.status IN ('unknown','effect_pending')
    ORDER BY e.created_at ASC LIMIT ${UNRESOLVED_EFFECT_DIAGNOSTICS_MAX}`;
  const unresolved = effects.map((row: UnresolvedEffectDiagnosticRaw) => ({
    effect_id: row.effect_ref,
    effect_kind: row.effect_kind,
    status: row.status as "unknown" | "effect_pending",
    step: row.step,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ledger_settlement_status: row.ledger_settlement_status,
    ledger_usage_tokens: row.ledger_usage_tokens === null ? null : Number(row.ledger_usage_tokens),
    operator_settled: row.reconciled_by === "operator-settlement",
    replay_policy: row.replay_policy,
    attempt_id: row.attempt_id,
  }));
  const classificationRow: WaitingRow | undefined = waitingRows;
  const entry = classificationRow
    ? waitingRowToEntry(classificationRow, budget,
      classificationRow.objective_stopped || classificationRow.rejected_completions < COMPLETION_REPAIR_LIMIT
        ? null : await verifyCompletionRepairExhausted(db, jobId))
    : null;
  const next_actions: RecoveryDiagnostics["next_actions"] = [];
  for (const row of unresolved) {
    next_actions.push({
      action: "settle_effect",
      method: "POST",
      path: `/jobs/${jobId}/effects/${row.effect_id}/settlement`,
      note: OPERATOR_NOTE_SETTLE,
    });
  }
  next_actions.push({ action: "inspect_job", path: `/jobs/${jobId}`, note: OPERATOR_NOTE_JOB });
  if (unresolved.length === 0 && budget === null) {
    next_actions.push({ action: "read_completion_receipt", path: `/control/v1/jobs/${jobId}/operations/mark_job_done`, note: "无未知效果且无修正预算回执时以原完成回执为准" });
  }
  return {
    job_id: String(job.id),
    status: String(job.status),
    project_id: String(job.project_id),
    classification: entry ? { category: entry.category, signals: entry.signals } : {
      category: "no_signal" as WaitingCategory,
      signals: { unresolved_effect_count: unresolved.length, unresolved_effect_kinds: unresolved.map((r: UnresolvedEffectDiagnosticRow) => r.effect_kind),
        human_subject_kind: null, rejected_completion_count: 0, rejected_completion_verified: null,
        completion_accepted: false, plan_objective_stopped: false },
    },
    unresolved_effects: unresolved,
    repair_budget: budget ? {
      receipt_ref: budget.receipt_ref,
      attempt_id: budget.attempt_id,
      usage_status: budget.usage_status,
      known_tokens: budget.known_tokens,
      remaining_tokens: budget.remaining_tokens,
      deadline: budget.deadline ?? null,
    } : null,
    next_actions,
  };
}

export const UNRESOLVED_EFFECT_DIAGNOSTICS_MAX = 50;

type UnresolvedEffectDiagnosticRaw = {
  effect_ref: string; effect_kind: string; status: string; step: number;
  created_at: Date; updated_at: Date; reconciled_by: string | null;
  ledger_settlement_status: string | null; ledger_usage_tokens: number | string | null;
  replay_policy: string; attempt_id: string;
};

/**
 * 与 `hub-platform-stop.ts#readStopCode` 相同的回执身份核对：形状像 mark_job_done
 * 拒绝的 control_receipt 必须同时具备事件 ID 派生、event_dedup/Attempt 归属、
 * 4xx/5xx 且 accepted:false，才允许计入"平台死路"。任一条不满足即整组不算。
 */
type ControlReceiptHistoryRow = {
  event_id: string;
  attempt_id: string | null;
  attempt_job_id: string | null;
  dedup_job_id: string | null;
  payload_json: ControlReceiptHistoryPayload;
};

/** 只读回执身份核对需要的字段；其余 payload 不是本投影的契约。 */
type ControlReceiptHistoryPayload = {
  v?: number; status?: string; operation?: string; idempotency_key?: string; proposal_revision?: number;
  input_digest?: string; snapshot_digest?: string; attempt_id?: string | null;
  result?: { statusCode?: number; body?: { accepted?: boolean } };
};

async function verifyCompletionRepairExhausted(db: Database, jobId: string): Promise<boolean> {
  const history = await db<ControlReceiptHistoryRow[]>`
    SELECT e.event_id,e.attempt_id,e.payload_json,a.job_id AS attempt_job_id,d.job_id AS dedup_job_id
    FROM events e LEFT JOIN job_attempts a ON a.id=e.attempt_id LEFT JOIN event_dedup d ON d.event_id=e.event_id
    WHERE e.job_id=${jobId} AND e.type='control_receipt' AND e.payload_json->>'operation'='mark_job_done'
    ORDER BY e.job_seq LIMIT ${COMPLETION_REPAIR_LIMIT + 1}`;
  if (history.length < COMPLETION_REPAIR_LIMIT) return false;
  for (const event of history) {
    const receipt = event.payload_json;
    const key = receipt.idempotency_key;
    const revision = receipt.proposal_revision;
    const statusCode = receipt.result?.statusCode;
    if (receipt?.v !== 1 || receipt.status !== "rejected" || receipt.operation !== "mark_job_done"
      || typeof key !== "string" || !key
      || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
      || !/^[a-f0-9]{64}$/u.test(receipt.input_digest ?? "") || !/^[a-f0-9]{64}$/u.test(receipt.snapshot_digest ?? "")
      || receipt.attempt_id !== event.attempt_id || event.attempt_job_id !== jobId || event.dedup_job_id !== jobId
      || event.event_id !== completionReceiptId(jobId, key)
      || typeof statusCode !== "number" || !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599
      || receipt.result?.body?.accepted !== false) return false;
  }
  return true;
}

/** 内部共用：单 Job 的 waiting 行 select（与批量查询同一字段面）。 */
async function readWaitingClassificationRowsForJob(db: Database, jobId: string): Promise<[WaitingRow] | []> {
  const rows = await db<WaitingRow[]>`
    SELECT j.id::text AS id, j.project_id::text AS project_id, j.canvas_id, j.type, j.status,
      j.created_at, j.started_at, j.finished_at,
      (SELECT e.payload_json->'subject'->>'kind' FROM events e
        WHERE e.job_id = ${jobId} AND e.type='human' ORDER BY e.job_seq DESC LIMIT 1) AS human_subject_kind,
      (SELECT count(*)::int FROM events e WHERE e.job_id=${jobId} AND e.type='control_receipt'
        AND e.payload_json->>'operation'='mark_job_done' AND e.payload_json->>'status'='rejected') AS rejected_completions,
      (SELECT e.payload_json->>'status' FROM events e
        WHERE e.job_id=${jobId} AND e.type='control_receipt' AND e.payload_json->>'operation'='mark_job_done'
        ORDER BY e.job_seq DESC LIMIT 1) AS last_completion_receipt,
      (SELECT count(*)::int FROM job_attempt_effects e
        WHERE e.job_id=${jobId} AND e.status IN ('unknown','effect_pending')) AS unresolved_effects,
      (SELECT array_agg(DISTINCT e.effect_kind) FROM job_attempt_effects e
        WHERE e.job_id=${jobId} AND e.status IN ('unknown','effect_pending')) AS unresolved_effect_kinds,
      (c.target_json->'plan_objective'->>'status') AS objective_raw_status
    FROM jobs j LEFT JOIN canvases c ON c.id = j.canvas_id WHERE j.id=${jobId}`;
  const first = rows[0];
  if (!first) return [];
  return [{ ...first, human_subject_kind: normalizeSubjectKind(first.human_subject_kind),
    objective_stopped: first.objective_raw_status === "stopped" }];
}
