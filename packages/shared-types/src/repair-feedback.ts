import { z } from "zod";

/** Keep these numeric twins of the control-payload constants to avoid an index cycle. */
const DONE_SUMMARY_MAX_BYTES = 8 * 1024;
const SEMANTIC_EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;

/** Versioned RepairFeedback envelope (#446 Phase 1). */
export const REPAIR_FEEDBACK_SCHEMA_VERSION = 1 as const;

export const REPAIR_FEEDBACK_CATEGORIES = [
  "model_correctable",
  "transient_retryable",
  "unknown_external_effect",
  "permanent_failure",
] as const;
export type RepairFeedbackCategory = (typeof REPAIR_FEEDBACK_CATEGORIES)[number];

/** Advertised same-session correction budget until Phase 2 persists attempt counts. */
export const DEFAULT_MODEL_REPAIR_ATTEMPT_BUDGET = 8;

const PERMANENT_CONTROL_CODES = new Set([
  "tool_not_allowed",
  "job_not_running",
  "forbidden_control_file",
]);

export const RepairFeedbackRemainingBudget = z
  .object({
    attempts: z.number().int().min(0).optional(),
    tokens: z.number().int().min(0).optional(),
    wall_time_sec: z.number().int().min(0).optional(),
  })
  .strict();
export type RepairFeedbackRemainingBudget = z.infer<typeof RepairFeedbackRemainingBudget>;

export const RepairFeedbackAcceptedEffect = z
  .object({
    effect_id: z.string().min(1).max(120),
    status: z.string().min(1).max(80),
  })
  .strict();
export type RepairFeedbackAcceptedEffect = z.infer<typeof RepairFeedbackAcceptedEffect>;

export const RepairFeedback = z
  .object({
    v: z.literal(REPAIR_FEEDBACK_SCHEMA_VERSION).default(REPAIR_FEEDBACK_SCHEMA_VERSION),
    category: z.enum(REPAIR_FEEDBACK_CATEGORIES),
    code: z.string().min(1).max(120),
    operation: z.string().min(1).max(120),
    path: z.string().min(1).max(240).optional(),
    message: z.string().min(1).max(2000),
    expected: z.unknown().optional(),
    observed_shape: z.unknown().optional(),
    current_state_ref: z.string().min(1).max(240).optional(),
    accepted_effects: z.array(RepairFeedbackAcceptedEffect).max(32).optional(),
    idempotency_key: z.string().min(1).max(128).optional(),
    proposal_revision: z.number().int().min(0).default(0),
    repair_attempt: z.number().int().min(0).default(0),
    remaining_budget: RepairFeedbackRemainingBudget.default({}),
    next_action: z.string().min(1).max(500).optional(),
  })
  .strict();
export type RepairFeedback = z.infer<typeof RepairFeedback>;

export const RepairFeedbackJsonSchema = z.toJSONSchema(RepairFeedback, { target: "draft-7" }) as Record<string, unknown>;

export type RepairFeedbackInput = {
  category: RepairFeedbackCategory;
  code: string;
  operation: string;
  path?: string;
  message: string;
  expected?: unknown;
  observed_shape?: unknown;
  current_state_ref?: string;
  accepted_effects?: RepairFeedbackAcceptedEffect[];
  idempotency_key?: string;
  proposal_revision?: number;
  repair_attempt?: number;
  remaining_budget?: RepairFeedbackRemainingBudget;
  next_action?: string;
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Type / length / count only — never copy untrusted contents. */
export function describeObservedShape(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  switch (typeof value) {
    case "string":
      return { type: "string", length: value.length, utf8_bytes: utf8Bytes(value) };
    case "number":
      return { type: Number.isFinite(value) ? "number" : "number_nonfinite" };
    case "boolean":
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return { type: typeof value };
    default:
      return { type: "object", keys: Object.keys(value as object).length };
  }
}

const TRANSIENT_CONTROL_CODES = new Set([
  "event_rate_limited",
  "HANDLER_UNAVAILABLE",
  "HANDLER_FAILED",
]);

export function repairCategoryForControlFailure(input: {
  code: string;
  retryable?: boolean;
  statusCode?: number;
}): RepairFeedbackCategory {
  if (
    TRANSIENT_CONTROL_CODES.has(input.code)
    || input.statusCode === 429
    || input.statusCode === 503
    || input.statusCode === 500
  ) {
    return "transient_retryable";
  }
  if (PERMANENT_CONTROL_CODES.has(input.code) || input.retryable === false) return "permanent_failure";
  return "model_correctable";
}

export function buildRepairFeedback(input: RepairFeedbackInput): RepairFeedback {
  return RepairFeedback.parse({
    v: REPAIR_FEEDBACK_SCHEMA_VERSION,
    proposal_revision: 0,
    repair_attempt: 0,
    remaining_budget: defaultRemainingBudget(input.category),
    ...input,
  });
}

function defaultRemainingBudget(category: RepairFeedbackCategory): RepairFeedbackRemainingBudget {
  return category === "model_correctable" ? { attempts: DEFAULT_MODEL_REPAIR_ATTEMPT_BUDGET } : {};
}

function joinIssuePath(path: readonly unknown[] | undefined): string | undefined {
  if (!path || path.length === 0) return undefined;
  const parts = path.filter((part): part is string | number => typeof part === "string" || typeof part === "number");
  return parts.length > 0 ? parts.join(".") : undefined;
}

function valueAtPath(input: unknown, path: string | undefined): unknown {
  if (!path) return input;
  let current: unknown = input;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

type ZodIssueLike = {
  code?: string;
  path?: readonly unknown[];
  message?: string;
  origin?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  expected?: unknown;
};

function expectedFromZodIssue(issue: ZodIssueLike, operation: string, path: string | undefined): unknown {
  if (isUtf8ByteLimitIssue(issue, operation, path)) {
    return {
      kind: "utf8_bytes_max",
      max: path === "summary" ? DONE_SUMMARY_MAX_BYTES : SEMANTIC_EVENT_PAYLOAD_MAX_BYTES,
    };
  }
  if (issue.code === "too_big" && issue.maximum !== undefined) {
    return { kind: issue.origin === "string" ? "max_length" : "max", max: Number(issue.maximum) };
  }
  if (issue.code === "too_small" && issue.minimum !== undefined) {
    return { kind: issue.origin === "string" ? "min_length" : "min", min: Number(issue.minimum) };
  }
  if (issue.code === "unrecognized_keys") return { kind: "unknown_field" };
  if (typeof issue.expected === "string") return { kind: "type", type: issue.expected };
  return { kind: "strict_contract" };
}

function isUtf8ByteLimitIssue(issue: ZodIssueLike, operation: string, path: string | undefined): boolean {
  const message = issue.message ?? "";
  return /UTF-8 bytes/i.test(message) || (operation === "mark_job_done" && path === "summary" && /exceed/i.test(message));
}

function sanitizedZodMessage(issue: ZodIssueLike, operation: string, path: string | undefined, expected: unknown): string {
  if (isUtf8ByteLimitIssue(issue, operation, path)) {
    const max = expected && typeof expected === "object" && "max" in expected
      ? Number((expected as { max: number }).max)
      : DONE_SUMMARY_MAX_BYTES;
    return `${operation}${path ? `.${path}` : ""} 超过 ${max} UTF-8 字节上限；请缩短后使用新的 Idempotency-Key 重试。`;
  }
  if (issue.code === "unrecognized_keys") {
    return `${INVALID_CONTROL_CONTRACT} 不允许未知字段。`;
  }
  if (issue.code === "too_small") {
    return `${INVALID_CONTROL_CONTRACT} 字段 ${path ?? "input"} 过短或为空。`;
  }
  if (issue.code === "invalid_type") {
    return `${INVALID_CONTROL_CONTRACT} 字段 ${path ?? "input"} 类型不匹配。`;
  }
  return `${INVALID_CONTROL_CONTRACT} 请按 expected 修正 ${path ?? "输入"} 后重试。`;
}

const INVALID_CONTROL_CONTRACT = "控制工具参数不符合严格契约；";

function nextActionFor(input: {
  category: RepairFeedbackCategory;
  code?: string;
  path?: string;
  expected?: unknown;
}): string {
  if (input.code === "HANDLER_UNAVAILABLE") {
    return "平台运行时 handler 暂时不可用；使用同一 Idempotency-Key 重试，不要改写 payload。";
  }
  if (input.code === "HANDLER_FAILED") {
    return "平台执行失败且未返回业务拒绝；使用同一 Idempotency-Key 重试，不要改写 payload。";
  }
  if (input.category === "transient_retryable") {
    return "等待 advertised retry_after_sec 后，使用同一 Idempotency-Key 重试。";
  }
  if (input.category === "unknown_external_effect") {
    return "停止自动重放；保留 effect id，交对账或人工处理。";
  }
  if (input.category === "permanent_failure") {
    return "不要重试此提案；先修复 Job 权限、状态或平台配置。";
  }
  if (input.expected && typeof input.expected === "object" && input.expected !== null && "kind" in input.expected
    && (input.expected as { kind?: string }).kind === "utf8_bytes_max") {
    const max = Number((input.expected as { max?: number }).max);
    return `将 ${input.path ?? "payload"} 缩短到最多 ${max} UTF-8 字节（或改走 payload_file / 拆分事件），然后使用新的 Idempotency-Key 重新提交。`;
  }
  return `按 expected 修正 ${input.path ?? "输入"} 后，使用新的 Idempotency-Key 重新提交。`;
}

export function repairFeedbackFromZodIssues(input: {
  operation: string;
  code: string;
  issues: readonly ZodIssueLike[];
  rawInput?: unknown;
  idempotency_key?: string;
}): RepairFeedback {
  const issue = input.issues[0] ?? {};
  const path = joinIssuePath(issue.path);
  const expected = expectedFromZodIssue(issue, input.operation, path);
  return buildRepairFeedback({
    category: "model_correctable",
    code: input.code,
    operation: input.operation,
    path,
    message: sanitizedZodMessage(issue, input.operation, path, expected),
    expected,
    observed_shape: describeObservedShape(valueAtPath(input.rawInput, path)),
    idempotency_key: input.idempotency_key,
    next_action: nextActionFor({ category: "model_correctable", code: input.code, path, expected }),
  });
}

export function repairFeedbackFromControlRejection(input: {
  operation: string;
  code: string;
  message: string;
  retryable?: boolean;
  statusCode?: number;
  path?: string;
  details?: Record<string, unknown>;
  rawInput?: unknown;
  idempotency_key?: string;
}): RepairFeedback {
  const category = repairCategoryForControlFailure(input);
  const expected = input.details && "expected" in input.details
    ? input.details.expected
    : category === "transient_retryable" && input.details
      ? { kind: "rate_limit", ...pickRateLimitShape(input.details) }
      : undefined;
  const observed = input.details && "observed_shape" in input.details
    ? input.details.observed_shape
    : input.rawInput !== undefined
      ? describeObservedShape(valueAtPath(input.rawInput, input.path))
      : undefined;
  return buildRepairFeedback({
    category,
    code: input.code,
    operation: input.operation,
    path: input.path,
    message: truncateMessage(input.message),
    expected,
    observed_shape: observed,
    idempotency_key: input.idempotency_key,
    next_action: nextActionFor({ category, code: input.code, path: input.path, expected }),
  });
}

function pickRateLimitShape(details: Record<string, unknown>): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const key of ["retry_after_sec", "bucket", "limit", "window_seconds"] as const) {
    if (details[key] !== undefined) shape[key] = details[key];
  }
  return shape;
}

function truncateMessage(message: string): string {
  const stripped = message.replace(/^\[[a-z0-9_]+\]\s*/i, "").trim();
  return stripped.length <= 2000 ? stripped : `${stripped.slice(0, 1999)}…`;
}
