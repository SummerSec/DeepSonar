import { z } from "zod";

export const INVALID_PAYLOAD = "invalid_payload";

const MAX_ISSUES = 20;

/** Postgres parameter/data errors that mean "the caller sent a value the column
 * type cannot represent" (e.g. a non-UUID id reaching a uuid parameter). These
 * are client errors, not 500s; the raw pg code/message must not leak. */
const PG_PARAMETER_ERROR_CODES = new Set([
  "22P02", // invalid_text_representation (e.g. malformed uuid)
  "22P03", // invalid_binary_representation
  "22007", // invalid_datetime_format
  "22008", // datetime_field_overflow
  "22023", // invalid_parameter_value
  "42804", // datatype_mismatch
]);

/** True when the error is a Postgres value/type error caused by request input. */
export function isPostgresParameterError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && PG_PARAMETER_ERROR_CODES.has(String((error as { code?: unknown }).code)),
  );
}

export type ValidationIssue = {
  path: string;
  code: string;
};

export function validationHttpError(
  error: unknown,
): { statusCode: number; body: Record<string, unknown> } | null {
  if (error instanceof z.ZodError) {
    const issues = sanitizeZodIssues(error);
    return {
      statusCode: 400,
      body: {
        error: "invalid request",
        error_code: INVALID_PAYLOAD,
        issues,
      },
    };
  }
  if (isFastifyValidationError(error)) {
    return {
      statusCode: 400,
      body: {
        error: "invalid request",
        error_code: INVALID_PAYLOAD,
      },
    };
  }
  if (isPostgresParameterError(error)) {
    // Defense in depth: a malformed path/query/body value that slipped past a
    // per-route check still returns 400 instead of 500 + pg error text.
    return {
      statusCode: 400,
      body: {
        error: "invalid request",
        error_code: INVALID_PAYLOAD,
      },
    };
  }
  return null;
}

function sanitizeZodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: String(issue.code),
  }));
}

function isFastifyValidationError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "FST_ERR_VALIDATION",
  );
}
