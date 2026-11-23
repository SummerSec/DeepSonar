import { collectSecretValues } from "../../credential-secret-projection.js";

/** Claude's launch policy defines this exact environment field as a positive integer cap. */
function isClaudeOutputCap(path: readonly string[], value: string): boolean {
  return path.length === 2 && path[0] === "env" && path[1] === "CLAUDE_CODE_MAX_OUTPUT_TOKENS"
    && /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
}

/** Preserve ambiguous fields, nested credentials, native assignments and short secret values. */
export function collectCheckpointCredentialValues(value: unknown, path: readonly string[] = []): string[] {
  if (typeof value === "string") {
    if (isClaudeOutputCap(path, value)) return [];
    return collectSecretValues(value, path.at(-1));
  }
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => typeof item === "string"
    ? collectSecretValues(item, path.at(-1))
    : collectCheckpointCredentialValues(item, [...path, "[]"])))];
  if (!value || typeof value !== "object") return [];
  return [...new Set(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    collectCheckpointCredentialValues(entry, [...path, key])))];
}
