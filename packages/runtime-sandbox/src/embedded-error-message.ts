/** Unwrap `message` / `error.message` from an error string that embeds JSON. */

const MAX_UNWRAP = 6;
const MAX_SCAN = 8 * 1024;
const SECRET_JSON_KEY = /"(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token)"\s*:/iu;

export function preferInnerJsonErrorMessage(raw: string): { message: string; detail?: string } {
  if (!raw) return { message: raw };
  const found = firstEmbeddedJsonObject(raw);
  if (!found) return { message: raw };
  const inner = innermostJsonMessage(found.value);
  if (!inner) return { message: raw };
  const prefix = stripTrailingColon(raw.slice(0, found.start));
  const message = prefix ? `${prefix}: ${inner}` : inner;
  if (message === raw) return { message: raw };
  return SECRET_JSON_KEY.test(raw) ? { message } : { message, detail: raw };
}

function innermostJsonMessage(value: unknown, depth = 0): string | undefined {
  if (depth >= MAX_UNWRAP) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const embedded = firstEmbeddedJsonObject(trimmed);
    if (embedded) {
      const nested = innermostJsonMessage(embedded.value, depth + 1);
      if (nested) {
        const prefix = stripTrailingColon(trimmed.slice(0, embedded.start));
        return prefix ? `${prefix}: ${nested}` : nested;
      }
    }
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
    const fromError = innermostJsonMessage(record.error, depth + 1);
    if (fromError) return fromError;
  }
  if (typeof record.message === "string" || (record.message && typeof record.message === "object" && !Array.isArray(record.message))) {
    return innermostJsonMessage(record.message, depth + 1);
  }
  return undefined;
}

function stripTrailingColon(text: string): string {
  return text.trimEnd().replace(/:+$/u, "").trimEnd();
}

function firstEmbeddedJsonObject(text: string): { start: number; value: unknown } | undefined {
  const limit = Math.min(text.length, MAX_SCAN);
  const start = text.slice(0, limit).indexOf("{");
  if (start < 0) return undefined;
  const value = parseJsonObjectAt(text, start, limit);
  return value === undefined ? undefined : { start, value };
}

function parseJsonObjectAt(text: string, start: number, limit: number): unknown | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < limit; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
