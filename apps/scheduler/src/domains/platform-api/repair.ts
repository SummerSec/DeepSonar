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
