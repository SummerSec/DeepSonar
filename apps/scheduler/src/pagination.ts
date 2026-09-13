/**
 * Cursor and page helpers shared by list, event, and evidence endpoints.
 *
 * Cursors are deliberately opaque to clients.  They only contain the stable
 * keyset fields needed by the server and are authenticated by shape/version,
 * not by exposing SQL fragments or internal ordering details.
 */

export const MAX_PAGE_SIZE = 50;

export interface CursorPayload {
  v: 1;
  kind: string;
  id?: string;
  created_at?: string;
  attempt_id?: string;
  seq?: number;
}

export interface PageEnvelope<T> {
  items: T[];
  /** Cursor supplied by the caller (null for the first page). */
  after: string | null;
  /** Cursor for the next forward page, or null when exhausted. */
  next_cursor: string | null;
  has_more: boolean;
  /** Server-side snapshot marker.  It is a watermark, not a durability claim. */
  watermark: string;
  /** True when the source may still change (in-memory/live evidence). */
  live: boolean;
  /** True when the bounded source had to drop older records. */
  truncated?: boolean;
  /** True when the requested cursor crossed a bounded retention gap. */
  gap?: boolean;
  /** current = mutable snapshot; history = append-only ledger; live = process-local tail. */
  query_plane?: "current" | "history" | "live";
  /** Process-stream pages name the durable source. Bus frames never use this. */
  source?: "evidence";
  /**
   * `local` = this Scheduler can see BLOB_DIR for the Job.
   * `unavailable` = expected process evidence is not on this replica.
   */
  visibility?: "local" | "unavailable";
  /** True when a local writer still has queued lines that are not on disk. */
  unpersisted?: boolean;
}

export type CursorErrorCode = "INVALID_CURSOR" | "CURSOR_GAP";

/** A malformed query parameter (e.g. `limit=abc`, `period=bogus`). Mapped to
 * 400 by the global error handler; silent fallback would return a 200 with a
 * different result set than the caller asked for. */
export class QueryParameterError extends Error {
  readonly path: string;

  constructor(path: string, message = "invalid query parameter") {
    super(message);
    this.name = "QueryParameterError";
    this.path = path;
  }
}

/** Explicit cursor failures are part of the HTTP/WS stream contract. */
export class CursorError extends Error {
  readonly code: CursorErrorCode;

  constructor(code: CursorErrorCode, message = code) {
    super(message);
    this.name = "CursorError";
    this.code = code;
  }
}

export function cursorErrorHttpStatus(code: CursorErrorCode): 400 | 409 {
  return code === "CURSOR_GAP" ? 409 : 400;
}

/** Decode a caller cursor, distinguishing an omitted cursor from bad input. */
export function parseCursor(raw: unknown, kind: string): CursorPayload | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const decoded = decodeCursor(raw, kind);
  if (!decoded) throw new CursorError("INVALID_CURSOR");
  return decoded;
}

/** Parse a bounded page size, rejecting malformed input instead of silently
 * falling back (a `limit=abc` must be a 400, not a 200 with the default page).
 * Out-of-range but well-formed values are clamped to `max`. */
export function parseBoundedLimit(raw: unknown, options: { max: number; fallback: number }): number {
  if (raw === undefined || raw === null || raw === "") return options.fallback;
  const text = String(raw);
  const value = /^[1-9][0-9]*$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new QueryParameterError("limit");
  return Math.min(options.max, value);
}

export function pageLimit(raw: unknown, fallback = MAX_PAGE_SIZE): number {
  return parseBoundedLimit(raw, {
    max: MAX_PAGE_SIZE,
    fallback: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(fallback))),
  });
}

export function encodeCursor(payload: Omit<CursorPayload, "v">): string {
  const value: CursorPayload = { v: 1, ...payload };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown, kind: string): CursorPayload | null {
  if (
    typeof raw !== "string" ||
    raw.length < 8 ||
    raw.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) return null;
  try {
    const decoded = Buffer.from(raw, "base64url");
    // Reject alternate/padded encodings so the opaque token has one stable
    // representation and malformed base64 cannot smuggle an empty payload.
    if (decoded.length === 0 || decoded.toString("base64url") !== raw) return null;
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Partial<CursorPayload>;
    if (value.v !== 1 || value.kind !== kind) return null;

    if (kind === "stream") {
      if (
        typeof value.attempt_id !== "string" ||
        value.attempt_id.length === 0 ||
        value.attempt_id.length > 128 ||
        !Number.isSafeInteger(value.seq) ||
        (value.seq as number) <= 0
      ) return null;
      return value as CursorPayload;
    }

    // SQL keyset endpoints interpolate these fields into explicit PostgreSQL
    // casts.  Validate the exact wire shape before a query is constructed so
    // malformed-but-decodable cursors become a deterministic 400 rather than
    // a database cast error (500).
    if (!canonicalTimestamp(value.created_at)) return null;
    if (kind === "jobs" || kind === "findings" || kind === "facts") {
      if (typeof value.id !== "string" || !UUID_RE.test(value.id)) return null;
      return value as CursorPayload;
    }
    if (kind === "events") {
      const id = positiveBigIntString(value.id);
      if (!id) return null;
      return { ...value, id } as CursorPayload;
    }

    if (value.id !== undefined && (typeof value.id !== "string" || value.id.length > 128)) return null;
    if (value.attempt_id !== undefined && (typeof value.attempt_id !== "string" || value.attempt_id.length > 128)) return null;
    if (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || value.seq < 0)) return null;
    return value as CursorPayload;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function positiveBigIntString(value: unknown): string | null {
  const max = 9_223_372_036_854_775_807n;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  try {
    const id = BigInt(value);
    return id > 0n && id <= max ? id.toString() : null;
  } catch {
    return null;
  }
}

export function page<T>(
  items: T[],
  options: {
    after?: string | null;
    nextCursor?: string | null;
    hasMore?: boolean;
    live?: boolean;
    watermark?: string;
    truncated?: boolean;
    gap?: boolean;
    query_plane?: "current" | "history" | "live";
    source?: "evidence";
    visibility?: "local" | "unavailable";
    unpersisted?: boolean;
  },
): PageEnvelope<T> {
  return {
    items,
    after: options.after ?? null,
    next_cursor: options.nextCursor ?? null,
    has_more: options.hasMore ?? false,
    watermark: options.watermark ?? new Date().toISOString(),
    live: options.live ?? false,
    ...(options.query_plane ? { query_plane: options.query_plane } : {}),
    ...(options.truncated ? { truncated: true } : {}),
    ...(options.gap ? { gap: true } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.unpersisted ? { unpersisted: true } : {}),
  };
}

export function cursorForRow(kind: string, row: { id: string; created_at: string | Date }): string {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return encodeCursor({ kind, id: String(row.id), created_at: created });
}
