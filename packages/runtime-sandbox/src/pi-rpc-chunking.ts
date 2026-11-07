/**
 * #944: chunked Pi RPC frames.
 *
 * A single JSONL event above the per-event bound used to fail the whole Job with
 * `PI_RPC_MESSAGE_TOO_LARGE`. The Pi CLI owns the emitter, so this module covers
 * the receiving side: it accepts `{type:"chunk", id, seq, total, data}` frames,
 * reassembles them in order, and only then hands the original record back to the
 * existing dispatch path. It also ships a `chunkPiRpcRecord` helper so tests (and
 * a future in-repo emitter) can produce the wire form.
 *
 * Everything fails closed: an unknown id shape, an inconsistent `total`, an
 * oversized payload, a duplicate sequence with different bytes, or an
 * incomplete group past its deadline all raise a stable `PI_RPC_*` code instead
 * of dispatching a partial record.
 */

/** Default chunk payload size. Kept well under the 8 MiB per-event bound. */
export const PI_RPC_CHUNK_BYTES_DEFAULT = 4 * 1024 * 1024;
/** Absolute reassembled-payload ceiling; this is protection, not a normal path. */
export const PI_RPC_CHUNK_HARD_MAX_BYTES = 256 * 1024 * 1024;
/** How long an incomplete group may hold memory before it is discarded. */
export const PI_RPC_CHUNK_TIMEOUT_MS = 30_000;
/** Bounded concurrency: how many partially received records may be pending. */
export const PI_RPC_CHUNK_MAX_PENDING = 8;
/** Guard against `total` being used to allocate unbounded maps. */
export const PI_RPC_CHUNK_MAX_PARTS = 4096;

/** #944 灰度开关：默认关闭，关闭时行为与修复前完全一致。 */
export const PI_RPC_CHUNKING_ENV = "DEEPSONAR_PI_RPC_CHUNKING";

export function piRpcChunkingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PI_RPC_CHUNKING_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export const PI_RPC_CHUNK_TYPE = "chunk";

export interface PiRpcChunkFrame {
  type: typeof PI_RPC_CHUNK_TYPE;
  id: string;
  /** 1-based, inclusive. */
  seq: number;
  total: number;
  /** base64 of this slice. */
  data: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const isSafePositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function isPiRpcChunkFrame(record: Record<string, unknown>): boolean {
  return record.type === PI_RPC_CHUNK_TYPE;
}

/**
 * Split one serialized record into chunk frames. `chunkBytes` is the raw byte
 * size per slice before base64 expansion.
 */
export function chunkPiRpcRecord(
  record: Record<string, unknown>,
  { id, chunkBytes = PI_RPC_CHUNK_BYTES_DEFAULT }: { id: string; chunkBytes?: number },
): PiRpcChunkFrame[] {
  if (!id) throw new Error("PI_RPC_CHUNK_ID_INVALID");
  if (!isSafePositiveInt(chunkBytes)) throw new Error("PI_RPC_CHUNK_SIZE_INVALID");
  const serialized = Buffer.from(JSON.stringify(record), "utf8");
  if (serialized.length > PI_RPC_CHUNK_HARD_MAX_BYTES) throw new Error("PI_RPC_MESSAGE_TOO_LARGE");
  const total = Math.max(1, Math.ceil(serialized.length / chunkBytes));
  if (total > PI_RPC_CHUNK_MAX_PARTS) throw new Error("PI_RPC_CHUNK_TOO_MANY_PARTS");
  const frames: PiRpcChunkFrame[] = [];
  for (let index = 0; index < total; index += 1) {
    const slice = serialized.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    frames.push({ type: PI_RPC_CHUNK_TYPE, id, seq: index + 1, total, data: slice.toString("base64") });
  }
  return frames;
}

interface PendingGroup {
  total: number;
  parts: Map<number, Buffer>;
  bytes: number;
  startedAt: number;
  /** Real deadline: fires without waiting for the next frame on the stream. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Reassemble chunk frames. Not thread-safe by design: it is driven from the
 * single RPC read loop, so ordering is the loop's ordering.
 */
export class PiRpcChunkAssembler {
  private readonly groups = new Map<string, PendingGroup>();

  constructor(
    private readonly options: {
      hardMaxBytes?: number;
      timeoutMs?: number;
      maxPending?: number;
      maxParts?: number;
      now?: () => number;
      /**
       * Called when a group passes its deadline while the stream is silent.
       * The runner wires this to its process-termination path so an incomplete
       * record fails the attempt instead of holding memory indefinitely.
       */
      onExpire?: (id: string) => void;
      /**
       * Arm real deadline timers. Defaults to on, except when a custom `now` is
       * injected: that means the caller drives the clock and calls `sweep()`.
       */
      armTimers?: boolean;
    } = {},
  ) {}

  private get hardMaxBytes() { return this.options.hardMaxBytes ?? PI_RPC_CHUNK_HARD_MAX_BYTES; }
  private get timeoutMs() { return this.options.timeoutMs ?? PI_RPC_CHUNK_TIMEOUT_MS; }
  private get maxPending() { return this.options.maxPending ?? PI_RPC_CHUNK_MAX_PENDING; }
  private get maxParts() { return this.options.maxParts ?? PI_RPC_CHUNK_MAX_PARTS; }
  private now() { return (this.options.now ?? Date.now)(); }
  private get armTimers() { return this.options.armTimers ?? !this.options.now; }

  /** Bytes currently held for incomplete groups. */
  get pendingBytes(): number {
    let total = 0;
    for (const group of this.groups.values()) total += group.bytes;
    return total;
  }

  get pendingGroups(): number {
    return this.groups.size;
  }

  /** Remove a group and cancel its deadline timer. */
  private drop(id: string): void {
    const group = this.groups.get(id);
    if (!group) return;
    if (group.timer) clearTimeout(group.timer);
    this.groups.delete(id);
  }

  /** A group passed its deadline while nothing else arrived on the stream. */
  private expire(id: string): void {
    if (!this.groups.has(id)) return;
    this.drop(id);
    this.options.onExpire?.(id);
  }

  /** Clear every timer; called when the attempt ends. */
  dispose(): void {
    for (const id of [...this.groups.keys()]) this.drop(id);
  }

  /**
   * Feed one frame. Returns `undefined` while the group is still incomplete, or
   * the parsed record once the last slice arrives.
   */
  accept(frame: PiRpcChunkFrame): Record<string, unknown> | undefined {
    this.sweep();
    if (typeof frame.id !== "string" || !frame.id) throw new Error("PI_RPC_CHUNK_ID_INVALID");
    if (!isSafePositiveInt(frame.seq) || !isSafePositiveInt(frame.total)) throw new Error("PI_RPC_CHUNK_INDEX_INVALID");
    if (frame.total > this.maxParts) throw new Error("PI_RPC_CHUNK_TOO_MANY_PARTS");
    if (frame.seq > frame.total) throw new Error("PI_RPC_CHUNK_INDEX_INVALID");
    if (typeof frame.data !== "string" || !BASE64.test(frame.data)) throw new Error("PI_RPC_CHUNK_DATA_INVALID");

    const slice = Buffer.from(frame.data, "base64");
    let group = this.groups.get(frame.id);
    if (!group) {
      if (this.groups.size >= this.maxPending) throw new Error("PI_RPC_CHUNK_TOO_MANY_PENDING");
      group = { total: frame.total, parts: new Map(), bytes: 0, startedAt: this.now() };
      this.groups.set(frame.id, group);
      // #944 review P2: `sweep()` only runs when another frame arrives, so a
      // half-received group on a silent stream never expired. A real timer makes
      // the deadline independent of the read loop.
      if (this.armTimers) {
        group.timer = setTimeout(() => this.expire(frame.id), this.timeoutMs);
        group.timer.unref?.();
      }
    } else if (group.total !== frame.total) {
      this.drop(frame.id);
      throw new Error("PI_RPC_CHUNK_TOTAL_MISMATCH");
    }

    const existing = group.parts.get(frame.seq);
    if (existing) {
      // Idempotent replay: identical bytes are ignored, conflicting bytes are a
      // corrupt stream rather than a retry.
      if (!existing.equals(slice)) {
        this.drop(frame.id);
        throw new Error("PI_RPC_CHUNK_DUPLICATE_CONFLICT");
      }
      return undefined;
    }

    if (group.bytes + slice.length > this.hardMaxBytes) {
      this.drop(frame.id);
      throw new Error("PI_RPC_MESSAGE_TOO_LARGE");
    }
    group.parts.set(frame.seq, slice);
    group.bytes += slice.length;
    if (group.parts.size < group.total) return undefined;

    this.drop(frame.id);
    const ordered: Buffer[] = [];
    for (let seq = 1; seq <= group.total; seq += 1) {
      const part = group.parts.get(seq);
      if (!part) throw new Error("PI_RPC_CHUNK_INCOMPLETE");
      ordered.push(part);
    }
    const payload = Buffer.concat(ordered);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new Error("PI_RPC_CHUNK_INVALID_JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PI_RPC_CHUNK_RECORD_NOT_OBJECT");
    return parsed as Record<string, unknown>;
  }

  /** Drop groups past their deadline. Call from the read loop and before dispatch. */
  sweep(now = this.now()): void {
    const expired: string[] = [];
    for (const [id, group] of this.groups) {
      if (now - group.startedAt >= this.timeoutMs) expired.push(id);
    }
    if (!expired.length) return;
    for (const id of expired) this.drop(id);
    throw new Error("PI_RPC_CHUNK_INCOMPLETE");
  }

  /** True when nothing is buffered; used by tests and by graceful shutdown checks. */
  get idle(): boolean {
    return this.groups.size === 0;
  }
}
