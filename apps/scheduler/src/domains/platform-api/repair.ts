import type { CapabilityPrincipal } from "./tokens.js";
import {
  type RepairFeedback,
  repairFeedbackFromControlRejection,
  repairFeedbackFromZodIssues,
} from "@deepsonar/shared-types";

export interface ControlOperationRejectionBody {
  accepted: false;
  error: string;
  error_code: string;
  retryable: boolean;
  path?: string;
  repair: RepairFeedback;
  details?: Record<string, unknown>;
}

/** Handler extras that may appear beside / under the canonical envelope. Envelope keys are never copied. */
const REJECTION_DETAIL_ALLOWLIST = [
  "expected",
  "observed_shape",
  "retry_after_sec",
  "bucket",
  "limit",
  "window_seconds",
  "image_key",
  "readiness",
  "preparing",
  "task_id",
  "checked_at",
  "remaining",
  "calls_left",
  "bytes_left",
] as const;

const DETAIL_STRING_MAX = 240;

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length <= DETAIL_STRING_MAX ? value : `${value.slice(0, DETAIL_STRING_MAX - 1)}…`;
  }
  if (depth >= 2 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const sanitized = sanitizeDetailValue(own(object, key), depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

export function allowlistedRejectionDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of REJECTION_DETAIL_ALLOWLIST) {
    const sanitized = sanitizeDetailValue(own(details, key), 0);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Allowlisted extras first; canonical RepairFeedback fields always win. */
export function attachAllowlistedRejectionDetails(
  body: ControlOperationRejectionBody,
  details?: Record<string, unknown>,
): ControlOperationRejectionBody {
  const safe = allowlistedRejectionDetails(details);
  if (!safe) return body;
  return { ...safe, ...body, details: safe };
}

export function controlSchemaRejection(input: {
  operation: string;
  code: string;
  issues: readonly { code?: string; path?: readonly unknown[]; message?: string; origin?: string; maximum?: number | bigint; minimum?: number | bigint; expected?: unknown }[];
  rawInput?: unknown;
  idempotencyKey?: string;
}): ControlOperationRejectionBody {
  const repair = repairFeedbackFromZodIssues({
    operation: input.operation,
    code: input.code,
    issues: input.issues,
    rawInput: input.rawInput,
    idempotency_key: input.idempotencyKey,
  });
  return rejectionBody(repair, true);
}

export function controlRuntimeRejection(input: {
  operation: string;
  code: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
  path?: string;
  details?: Record<string, unknown>;
  rawInput?: unknown;
  idempotencyKey?: string | null;
}): ControlOperationRejectionBody {
  const repair = repairFeedbackFromControlRejection({
    operation: input.operation,
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    statusCode: input.statusCode,
    path: input.path,
    details: input.details,
    rawInput: input.rawInput,
    idempotency_key: input.idempotencyKey ?? undefined,
  });
  return attachAllowlistedRejectionDetails(rejectionBody(repair, input.retryable), input.details);
}

export function controlPlatformFailure(input: {
  operation: string;
  code: "HANDLER_UNAVAILABLE" | "HANDLER_FAILED";
  message: string;
  idempotencyKey?: string | null;
}): ControlOperationRejectionBody {
  return controlRuntimeRejection({
    operation: input.operation,
    code: input.code,
    message: input.message,
    retryable: true,
    statusCode: input.code === "HANDLER_UNAVAILABLE" ? 503 : 500,
    idempotencyKey: input.idempotencyKey,
  });
}

function rejectionBody(repair: RepairFeedback, retryable: boolean): ControlOperationRejectionBody {
  return {
    accepted: false,
    error: repair.message,
    error_code: repair.code,
    retryable,
    ...(repair.path ? { path: repair.path } : {}),
    repair,
  };
}

/** A host-owned query instruction, not a snapshot/version promise or new authority. */
export function withScopedReferenceRefresh(
  body: ControlOperationRejectionBody,
  principal: Pick<CapabilityPrincipal, "jobId" | "canvasId" | "operationIds">,
): ControlOperationRejectionBody {
  if (body.repair.operation !== "submit_hub_decision" || body.repair.code !== "invalid_node_ref"
    || body.repair.category !== "model_correctable") return body;
  if (!principal.canvasId || !principal.operationIds.includes("graph_query")) {
    return { ...body, repair: { ...body.repair,
      next_action: "当前 Job 没有可用的画布查询权限；停止猜测引用并按既有人工/失败路径处理，不扩大授权。",
    } };
  }
  const ref = `/control/v1/jobs/${principal.jobId}/operations/graph_query`;
  return { ...body, repair: { ...body.repair, current_state_ref: ref,
    next_action: 'GET current_state_ref 只读取操作 Schema；使用当前 Job token 和新 Idempotency-Key 向该地址 POST {"kind":"overview"}，再按需查询并只使用返回的 referable_ids。查询仍受权限和预算限制；失败时停止。读取结果不是版本锁，修正后以新 Idempotency-Key 重提，服务端仍重新检查引用与状态。',
  } };
}
