export class StrongRelationStoreError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "StrongRelationStoreError";
  }
}

export function fail(code: string, message = code): never {
  throw new StrongRelationStoreError(code, message);
}

export function boundedText(value: unknown, name: string, max: number, allowBlank = false): string {
  if (typeof value !== "string" || value.length > max || (!allowBlank && !value.trim())) {
    fail(`INVALID_${name.toUpperCase()}`);
  }
  return value;
}

export function isoTimestamp(value: unknown, name = "freshness_until"): string {
  const text = boundedText(value, name, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) fail(`INVALID_${name.toUpperCase()}`);
  return parsed.toISOString();
}

export function digest(value: unknown, name: string): string {
  const result = boundedText(value, name, 72);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) fail(`INVALID_${name.toUpperCase()}`);
  return result;
}

export function dateOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
