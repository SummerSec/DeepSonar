/**
 * Transfer representation and validation for canvas_broadcasts.
 *
 * A package is untrusted input.  Keep this module free of database access so
 * export/import paths and non-live smoke tests share exactly the same checks.
 */

export const CANVAS_BROADCASTS_FILE = "data/canvas-broadcasts.jsonl";

export const BROADCAST_STATUSES = ["planned", "injected", "failed", "skipped", "unknown"] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const BROADCAST_NODE_TYPES = ["fact", "finding"] as const;
export type BroadcastNodeType = (typeof BROADCAST_NODE_TYPES)[number];

export const BROADCAST_TARGET_KINDS = ["role", "hub", "verify", "report"] as const;
export type BroadcastTargetKind = (typeof BROADCAST_TARGET_KINDS)[number];

/** JSON/JSONL transfer row; source_* ids refer to the exporting instance. */
export interface CanvasBroadcastTransferRow {
  source_id: string;
  source_canvas_id: string;
  source_job_id: string;
  source_node_id: string;
  source_node_type: BroadcastNodeType;
  target_job_id: string;
  target_role: string;
  target_role_kind: BroadcastTargetKind;
  attempt: number;
  delivery_status: BroadcastStatus;
  skip_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  title: string | null;
  payload_preview: string | null;
  payload_sha256: string | null;
  message_chars: number | null;
  injected_at: string | null;
  finished_at: string | null;
  decision_deadline_at: string;
  created_at: string;
  updated_at: string;
}

export interface TransferCanvasRef {
  source_id: string;
}

export interface TransferJobRef {
  source_id: string;
  source_canvas_id?: string | null;
}

export interface TransferNodeRef {
  source_id: string;
  source_canvas_id?: string | null;
  source_job_id?: string | null;
  node_type?: string | null;
}

const TEXT_LIMITS = {
  target_role: 200,
  skip_reason: 200,
  error_code: 100,
  error_message: 500,
  title: 500,
  payload_preview: 2_000,
} as const;

const REDACTED = "[REDACTED]";

/**
 * Redact common credential/header forms before truncating to a byte limit.
 * This intentionally handles text rather than trying to parse arbitrary JSON.
 */
export function sanitizeBroadcastText(value: unknown, maxBytes: number): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/((?:authorization|proxy-authorization|bearer|token|api[_-]?key|secret|password|passwd|credential)\s*[:=]\s*)(?:Bearer\s+)?([^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  // Do not slice a UTF-8 sequence in the middle.  A short loop is adequate
  // for the bounded 500/2048-byte fields and keeps the result deterministic.
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
  return text.slice(0, end);
}

function requiredId(value: unknown, field: string): string {
  const id = String(value ?? "").trim();
  if (!id) throw transferError("BROADCAST_FIELD_INVALID", `canvas_broadcasts.${field} 不能为空`);
  return id;
}

function optionalId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return id || null;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  // Timestamp validation belongs to PostgreSQL.  Reject control characters
  // here while preserving the original ISO representation for round trips.
  if (/[\u0000-\u001F\u007F]/.test(text)) {
    throw transferError("BROADCAST_FIELD_INVALID", "canvas_broadcasts timestamp 含控制字符");
  }
  return text;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  const text = String(value ?? "");
  if (!values.includes(text as T)) {
    throw transferError("BROADCAST_FIELD_INVALID", `canvas_broadcasts.${field} 非法: ${text}`);
  }
  return text as T;
}

function nullableInt(value: unknown, field: string, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw transferError("BROADCAST_FIELD_INVALID", `canvas_broadcasts.${field} 非法`);
  }
  return n;
}

function requiredTimestamp(value: unknown, field: string): string {
  const timestamp = optionalTimestamp(value);
  if (!timestamp) throw transferError("BROADCAST_FIELD_INVALID", `canvas_broadcasts.${field} 不能为空`);
  return timestamp;
}

/** Sanitize and normalize a raw DB/package row without following references. */
export function sanitizeCanvasBroadcastRow(raw: Record<string, unknown>): CanvasBroadcastTransferRow {
  const sourceNodeType = enumValue(raw.source_node_type, BROADCAST_NODE_TYPES, "source_node_type");
  const status = enumValue(raw.delivery_status, BROADCAST_STATUSES, "delivery_status");
  const targetRoleKind = enumValue(raw.target_role_kind, BROADCAST_TARGET_KINDS, "target_role_kind");
  const skipReason = sanitizeBroadcastText(raw.skip_reason, TEXT_LIMITS.skip_reason);
  const errorCode = sanitizeBroadcastText(raw.error_code, TEXT_LIMITS.error_code);

  if ((status === "skipped") !== Boolean(skipReason)) {
    throw transferError("BROADCAST_FIELD_INVALID", "skipped 状态必须且只能带 skip_reason");
  }
  if ((status === "failed" || status === "unknown") !== Boolean(errorCode)) {
    throw transferError("BROADCAST_FIELD_INVALID", "failed/unknown 状态必须且只能带 error_code");
  }

  const attempt = nullableInt(raw.attempt, "attempt", 1, 2_147_483_647);
  if (attempt === null) throw transferError("BROADCAST_FIELD_INVALID", "canvas_broadcasts.attempt 不能为空");
  const messageChars = nullableInt(raw.message_chars, "message_chars", 0, 100_000);
  const payloadSha = raw.payload_sha256 == null || raw.payload_sha256 === "" ? null : String(raw.payload_sha256);
  if (payloadSha !== null && !/^[a-f0-9]{64}$/i.test(payloadSha)) {
    throw transferError("BROADCAST_FIELD_INVALID", "payload_sha256 必须为 SHA-256");
  }

  const row: CanvasBroadcastTransferRow = {
    source_id: requiredId(raw.source_id, "source_id"),
    source_canvas_id: requiredId(raw.source_canvas_id, "source_canvas_id"),
    source_job_id: requiredId(raw.source_job_id, "source_job_id"),
    source_node_id: requiredId(raw.source_node_id, "source_node_id"),
    source_node_type: sourceNodeType,
    target_job_id: requiredId(raw.target_job_id, "target_job_id"),
    target_role: sanitizeBroadcastText(raw.target_role, TEXT_LIMITS.target_role) ?? "",
    target_role_kind: targetRoleKind,
    attempt,
    delivery_status: status,
    skip_reason: skipReason,
    error_code: errorCode,
    error_message: sanitizeBroadcastText(raw.error_message, TEXT_LIMITS.error_message),
    title: sanitizeBroadcastText(raw.title, TEXT_LIMITS.title),
    payload_preview: sanitizeBroadcastText(raw.payload_preview, TEXT_LIMITS.payload_preview),
    payload_sha256: payloadSha,
    message_chars: messageChars,
    injected_at: optionalTimestamp(raw.injected_at),
    finished_at: optionalTimestamp(raw.finished_at),
    decision_deadline_at: requiredTimestamp(raw.decision_deadline_at, "decision_deadline_at"),
    created_at: requiredTimestamp(raw.created_at, "created_at"),
    updated_at: requiredTimestamp(raw.updated_at, "updated_at"),
  };

  if (!row.target_role) throw transferError("BROADCAST_FIELD_INVALID", "target_role 不能为空");
  if (status === "planned" && (row.injected_at !== null || row.finished_at !== null)) {
    throw transferError("BROADCAST_FIELD_INVALID", "planned 状态不能带 injected_at/finished_at");
  }
  if (status === "injected" && (row.injected_at === null || row.finished_at === null)) {
    throw transferError("BROADCAST_FIELD_INVALID", "injected 状态必须带 injected_at/finished_at");
  }
  if (status !== "planned" && status !== "injected" && row.finished_at === null) {
    throw transferError("BROADCAST_FIELD_INVALID", `${status} 状态必须带 finished_at`);
  }
  if (row.source_job_id === row.target_job_id) {
    throw transferError("BROADCAST_REF_INVALID", "source_job_id 不能等于 target_job_id");
  }
  return row;
}

export function broadcastNaturalKey(row: Pick<CanvasBroadcastTransferRow, "source_node_id" | "target_job_id" | "attempt">): string {
  return `${row.source_node_id}\u0000${row.target_job_id}\u0000${row.attempt}`;
}

export function transferError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Validate all package references before writing any imported rows.  Missing
 * dependencies fail closed; callers must not silently drop a broadcast row.
 */
export function validateCanvasBroadcastRows(
  rawRows: Record<string, unknown>[],
  canvases: TransferCanvasRef[],
  jobs: TransferJobRef[],
  nodes: TransferNodeRef[],
): CanvasBroadcastTransferRow[] {
  const canvasMap = new Map(canvases.map((row) => [String(row.source_id), row]));
  const jobMap = new Map(jobs.map((row) => [String(row.source_id), row]));
  const nodeMap = new Map(nodes.map((row) => [String(row.source_id), row]));
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const rows: CanvasBroadcastTransferRow[] = [];

  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw transferError("BROADCAST_ROW_INVALID", "canvas_broadcasts 行必须是对象");
    }
    const row = sanitizeCanvasBroadcastRow(raw);
    if (seenIds.has(row.source_id)) {
      throw transferError("DUPLICATE_BROADCAST_ID", `重复 canvas_broadcasts.source_id: ${row.source_id}`);
    }
    seenIds.add(row.source_id);

    const key = broadcastNaturalKey(row);
    if (seenKeys.has(key)) {
      throw transferError("DUPLICATE_BROADCAST_KEY", `重复 canvas_broadcasts 自然键: ${key.replace(/\u0000/g, "/")}`);
    }
    seenKeys.add(key);

    const canvas = canvasMap.get(row.source_canvas_id);
    const sourceJob = jobMap.get(row.source_job_id);
    const targetJob = jobMap.get(row.target_job_id);
    const sourceNode = nodeMap.get(row.source_node_id);
    if (!canvas || !sourceJob || !targetJob || !sourceNode) {
      throw transferError(
        "BROADCAST_REF_MISSING",
        `canvas_broadcasts ${row.source_id} 缺少 canvas/source job/target job/source node 依赖`,
      );
    }
    if (sourceJob.source_canvas_id !== row.source_canvas_id || targetJob.source_canvas_id !== row.source_canvas_id) {
      throw transferError("BROADCAST_REF_INVALID", `canvas_broadcasts ${row.source_id} 的 Job 不属于同一 canvas`);
    }
    if (sourceNode.source_canvas_id !== row.source_canvas_id) {
      throw transferError("BROADCAST_REF_INVALID", `canvas_broadcasts ${row.source_id} 的 source node 不属于同一 canvas`);
    }
    if (sourceNode.source_job_id && sourceNode.source_job_id !== row.source_job_id) {
      throw transferError("BROADCAST_REF_INVALID", `canvas_broadcasts ${row.source_id} 的 source node 不属于 source job`);
    }
    if (sourceNode.node_type !== row.source_node_type) {
      throw transferError("BROADCAST_REF_INVALID", `canvas_broadcasts ${row.source_id} 的 node_type 不匹配`);
    }
    rows.push(row);
  }
  return rows;
}

/** Fields compared for an identical destination collision. */
export function broadcastContent(row: Record<string, unknown>): string {
  const fields = [
    "canvas_id",
    "source_job_id",
    "source_node_id",
    "source_node_type",
    "target_job_id",
    "target_role",
    "target_role_kind",
    "attempt",
    "delivery_status",
    "skip_reason",
    "error_code",
    "error_message",
    "title",
    "payload_preview",
    "payload_sha256",
    "message_chars",
    "injected_at",
    "finished_at",
    "decision_deadline_at",
    "created_at",
    "updated_at",
  ];
  return JSON.stringify(
    Object.fromEntries(
      fields.map((field) => {
        const value = row[field];
        return [field, value == null ? null : value instanceof Date ? value.toISOString() : String(value)];
      }),
    ),
  );
}
