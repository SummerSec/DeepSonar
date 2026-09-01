import { randomUUID } from "node:crypto";
import { encodeCursor, page, pageLimit, parseCursor, CursorError, type PageEnvelope } from "./pagination.js";

/**
 * Agent realtime stream bus (in-memory only).
 *
 * The bus is a bounded observation cache, not a source of durable evidence:
 * restart, eviction, or subscriber backpressure can lose frames.  The HTTP
 * evidence endpoint tails the per-attempt NDJSON archive when a client needs a
 * reliable backfill.
 */

export interface StreamItem {
  /** runtime normalized event type or a scheduler run marker */
  type: string;
  /** Stable attempt identity shared with the evidence archive. */
  attempt_id: string;
  /** Monotonic sequence within an attempt. */
  seq: number;
  at: number;
  [k: string]: unknown;
}

export const STREAM_BUFFER_MAX = 300;
export const STREAM_ITEM_MAX_BYTES = 16 * 1024;
export const STREAM_SUBSCRIBER_QUEUE_MAX = 128;
export const STREAM_JOB_CACHE_MAX = 256;
export const STREAM_JOB_CACHE_TTL_MS = 30 * 60 * 1000;

const buffers = new Map<string, StreamItem[]>();
const subs = new Map<string, Set<(item: StreamItem) => void>>();
const attempts = new Map<string, { attemptId: string; seq: number }>();
const touched = new Map<string, number>();

function evictStreamCaches(now = Date.now()): void {
  for (const [jobId, at] of touched) {
    if (subs.has(jobId)) continue;
    if (now - at > STREAM_JOB_CACHE_TTL_MS) {
      buffers.delete(jobId);
      attempts.delete(jobId);
      touched.delete(jobId);
    }
  }
  const candidates = [...touched.entries()]
    .filter(([jobId]) => !subs.has(jobId))
    .sort((a, b) => a[1] - b[1]);
  while (touched.size > STREAM_JOB_CACHE_MAX && candidates.length > 0) {
    const [jobId] = candidates.shift()!;
    buffers.delete(jobId);
    attempts.delete(jobId);
    touched.delete(jobId);
  }
}

function boundString(value: string, max = 4000): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function boundedItem(item: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (typeof value === "string") next[key] = boundString(value);
    else if (Array.isArray(value)) next[key] = value.slice(0, 32);
    else next[key] = value;
  }
  // Keep a hard byte ceiling even when a provider puts a large nested object
  // in a supposedly small frame.  Prefer preserving the event identity fields.
  if (Buffer.byteLength(JSON.stringify(next), "utf8") <= STREAM_ITEM_MAX_BYTES) return next;
  const reduced: Record<string, unknown> = {};
  for (const key of ["type", "attempt_id", "seq", "at", "toolName", "callId", "action", "text", "delta"]) {
    if (next[key] !== undefined) reduced[key] = typeof next[key] === "string" ? boundString(String(next[key]), 1800) : next[key];
  }
  return reduced;
}

function currentAttempt(jobId: string, explicit?: string): { attemptId: string; seq: number } {
  const existing = attempts.get(jobId);
  const attemptId = explicit?.trim() || existing?.attemptId || `attempt-${randomUUID()}`;
  if (!existing || existing.attemptId !== attemptId) {
    const state = { attemptId, seq: 0 };
    attempts.set(jobId, state);
    return state;
  }
  return existing;
}

/** Publish one bounded frame. `seq` may be supplied by the evidence writer so
 * HTTP and WS cursors refer to the same attempt sequence (gaps are valid). */
export function publishStream(
  jobId: string,
  item: Omit<StreamItem, "attempt_id" | "seq" | "at"> & { attempt_id?: string },
  attemptId?: string,
  evidenceSeq?: number,
): void {
  evictStreamCaches();
  touched.set(jobId, Date.now());
  const explicitAttempt = attemptId ?? (typeof item.attempt_id === "string" ? item.attempt_id : undefined);
  const state = currentAttempt(jobId, explicitAttempt);
  if (item.type === "run.started") {
    // A new executor attempt gets a fresh cursor namespace and cache.  If an
    // older caller does not provide an id, generate one at the run boundary.
    const nextAttempt = explicitAttempt || `attempt-${randomUUID()}`;
    if (nextAttempt !== state.attemptId) {
      state.attemptId = nextAttempt;
    }
    // EvidenceWriter starts a fresh sequence for every executor attempt,
    // including a retry that happens to reuse an identifier.
    state.seq = 0;
    buffers.set(jobId, []);
  }
  const seq = Number.isSafeInteger(evidenceSeq) && (evidenceSeq as number) > 0
    ? (evidenceSeq as number)
    : ++state.seq;
  state.seq = Math.max(state.seq, seq);
  const full = boundedItem({ ...item, attempt_id: state.attemptId, seq, at: Date.now() }) as StreamItem;
  full.cursor = streamCursor(full);

  let buf = buffers.get(jobId);
  if (!buf) {
    buf = [];
    buffers.set(jobId, buf);
  }
  buf.push(full);
  if (buf.length > STREAM_BUFFER_MAX) buf.splice(0, buf.length - STREAM_BUFFER_MAX);

  for (const fn of subs.get(jobId) ?? []) {
    try {
      fn(full);
    } catch {
      // Subscriber cleanup is owned by the WS layer.
    }
  }
}

export function streamBuffer(jobId: string): StreamItem[] {
  evictStreamCaches();
  return [...(buffers.get(jobId) ?? [])];
}

export function streamCursor(item: Pick<StreamItem, "attempt_id" | "seq">): string {
  return encodeCursor({ kind: "stream", attempt_id: item.attempt_id, seq: item.seq });
}

export function streamItemKey(item: Pick<StreamItem, "attempt_id" | "seq">): string {
  return `${item.attempt_id}:${item.seq}`;
}

export function streamWindow(
  jobId: string,
  options: { after?: string | null; limit?: number; allowMissingCursor?: boolean } = {},
): PageEnvelope<StreamItem> {
  const source = buffers.get(jobId) ?? [];
  const limit = pageLimit(options.limit, 50);
  const after = options.after ?? null;
  const cursor = parseCursor(after, "stream");
  let start = 0;
  if (cursor?.attempt_id && Number.isSafeInteger(cursor.seq)) {
    const found = source.findIndex((item) => item.attempt_id === cursor.attempt_id && item.seq === cursor.seq);
    if (found < 0 && !options.allowMissingCursor) throw new CursorError("CURSOR_GAP");
    start = found >= 0
      ? found + 1
      : source.findIndex((item) => item.attempt_id === cursor.attempt_id && item.seq > (cursor.seq as number));
    if (start < 0) start = options.allowMissingCursor ? 0 : source.length;
  }
  const selected = source.slice(start, start + limit);
  const hasMore = start + selected.length < source.length;
  const next = selected.at(-1);
  return page(selected, {
    after,
    nextCursor: hasMore && next ? streamCursor(next) : next ? streamCursor(next) : null,
    hasMore,
    live: true,
    watermark: next ? streamCursor(next) : new Date().toISOString(),
  });
}

export function subscribeStream(jobId: string, fn: (item: StreamItem) => void): () => void {
  touched.set(jobId, Date.now());
  let set = subs.get(jobId);
  if (!set) {
    set = new Set();
    subs.set(jobId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set?.size === 0) subs.delete(jobId);
  };
}

/** Number of active subscribers, exposed for lifecycle regression tests. */
export function streamSubscriberCount(jobId?: string): number {
  if (jobId !== undefined) return subs.get(jobId)?.size ?? 0;
  let total = 0;
  for (const set of subs.values()) total += set.size;
  return total;
}

export function clearStreamForTests(): void {
  buffers.clear();
  subs.clear();
  attempts.clear();
  touched.clear();
}

export function streamCacheSizeForTests(): number {
  evictStreamCaches();
  return touched.size;
}
