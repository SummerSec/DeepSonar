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
}

export function pageLimit(raw: unknown, fallback = MAX_PAGE_SIZE): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(fallback)));
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(n)));
}

export function encodeCursor(payload: Omit<CursorPayload, "v">): string {
  const value: CursorPayload = { v: 1, ...payload };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(raw: unknown, kind: string): CursorPayload | null {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 512) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (value.v !== 1 || value.kind !== kind) return null;
    if (value.id !== undefined && (typeof value.id !== "string" || value.id.length > 128)) return null;
    if (value.created_at !== undefined && typeof value.created_at !== "string") return null;
    if (value.attempt_id !== undefined && (typeof value.attempt_id !== "string" || value.attempt_id.length > 128)) return null;
    if (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || value.seq < 0)) return null;
    return value as CursorPayload;
  } catch {
    return null;
  }
}

export function page<T>(
  items: T[],
  options: { after?: string | null; nextCursor?: string | null; hasMore?: boolean; live?: boolean; watermark?: string },
): PageEnvelope<T> {
  return {
    items,
    after: options.after ?? null,
    next_cursor: options.nextCursor ?? null,
    has_more: options.hasMore ?? false,
    watermark: options.watermark ?? new Date().toISOString(),
    live: options.live ?? false,
  };
}

export function cursorForRow(kind: string, row: { id: string; created_at: string | Date }): string {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return encodeCursor({ kind, id: String(row.id), created_at: created });
}
