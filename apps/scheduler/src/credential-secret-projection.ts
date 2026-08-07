/**
 * Secrets in a CC Switch settings profile stay server-owned.  The API may
 * expose the profile shape, but it never exposes its values.  PATCH accepts
 * the stable marker so an editor can round-trip unchanged secrets without
 * learning them.
 */
export const MASKED_SECRET_PLACEHOLDER = "[已保存密钥]";

const SECRET_FIELD_PATTERN = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token|authorization|cookie|credential)/iu;
const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token|authorization|cookie|credential)\s*(?:=|:)\s*["'])([^"']*)(["'])/giu;

export function redactSecretAssignments(value: string): string {
  return value.replace(SECRET_ASSIGNMENT_PATTERN, `$1${MASKED_SECRET_PLACEHOLDER}$3`);
}

function restoreSecretAssignments(original: string, incoming: string): string {
  const originalValues = new Map<string, string>();
  for (const match of original.matchAll(SECRET_ASSIGNMENT_PATTERN)) {
    originalValues.set(match[1].toLowerCase(), match[2]);
  }
  return incoming.replace(SECRET_ASSIGNMENT_PATTERN, (full, prefix: string, value: string, suffix: string) => {
    const originalValue = originalValues.get(prefix.toLowerCase());
    return originalValue && (!value || value === MASKED_SECRET_PLACEHOLDER)
      ? `${prefix}${originalValue}${suffix}`
      : full;
  });
}

/** Recursively project a settings object without exposing secret values. */
export function redactSecretProjection(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && SECRET_FIELD_PATTERN.test(key) && value) return MASKED_SECRET_PLACEHOLDER;
    return redactSecretAssignments(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecretProjection(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
    entryKey,
    redactSecretProjection(entryValue, entryKey),
  ]));
}

/** Restore only values represented by the stable marker in an existing profile. */
export function restoreMaskedSecretValues(original: unknown, incoming: unknown, key?: string): unknown {
  if (typeof incoming === "string") {
    if (key && SECRET_FIELD_PATTERN.test(key) && incoming === MASKED_SECRET_PLACEHOLDER) {
      return typeof original === "string" ? original : incoming;
    }
    if (typeof original === "string") return restoreSecretAssignments(original, incoming);
    return incoming;
  }
  if (Array.isArray(incoming)) {
    return incoming.map((item, index) => restoreMaskedSecretValues(Array.isArray(original) ? original[index] : undefined, item));
  }
  if (!incoming || typeof incoming !== "object") return incoming;
  const originalObject = original && typeof original === "object" && !Array.isArray(original)
    ? original as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries(incoming as Record<string, unknown>).map(([entryKey, entryValue]) => [
    entryKey,
    restoreMaskedSecretValues(originalObject[entryKey], entryValue, entryKey),
  ]));
}

export function containsSecretMask(value: unknown): boolean {
  if (typeof value === "string") return value.includes(MASKED_SECRET_PLACEHOLDER);
  if (Array.isArray(value)) return value.some(containsSecretMask);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsSecretMask);
}
