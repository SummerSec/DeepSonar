import { collectSecretValues } from "../../credential-secret-projection.js";

/** Preserve ambiguous fields, nested credentials, native assignments and short secret values. */
export function collectCheckpointCredentialValues(value: unknown, path: readonly string[] = []): string[] {
  if (typeof value === "string") {
    return collectSecretValues(value, path.at(-1));
  }
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => typeof item === "string"
    ? collectSecretValues(item, path.at(-1))
    : collectCheckpointCredentialValues(item, [...path, "[]"])))];
  if (!value || typeof value !== "object") return [];
  return [...new Set(Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    collectCheckpointCredentialValues(entry, [...path, key])))];
}

/** Only the executing Claude adapter validates this exact launch environment field. */
export function checkpointRuntimeEnvironmentSecrets(environment: Record<string, unknown>, agentCli?: string): string[] {
  const cap = environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  if (agentCli === "claude-code" && typeof cap === "string" && /^[1-9]\d*$/u.test(cap) && Number.isSafeInteger(Number(cap))) {
    const { CLAUDE_CODE_MAX_OUTPUT_TOKENS: _cap, ...remaining } = environment;
    return collectCheckpointCredentialValues(remaining);
  }
  return collectCheckpointCredentialValues(environment);
}
