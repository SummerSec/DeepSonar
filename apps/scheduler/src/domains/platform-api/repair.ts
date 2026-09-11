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
  return rejectionBody(repair, input.retryable);
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
