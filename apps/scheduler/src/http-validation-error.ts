import { z } from "zod";

export const INVALID_PAYLOAD = "invalid_payload";

const MAX_ISSUES = 20;

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
