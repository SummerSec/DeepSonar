import {
  EventEnvelope as EventEnvelopeSchema,
  SEMANTIC_EVENT_PAYLOAD_MAX_BYTES,
  type EventEnvelope,
  type EventEnvelopeInput,
} from "@deepsonar/shared-types";
import { sql } from "../../db.js";
import { CONTROL_INPUT_ERROR_CODES, ControlInputError } from "../../control-input.js";
import {
  consumeEventRateLimit,
  EventRateLimitError,
  type EventRateLimitPolicy,
} from "./rate-limit.js";

/** The Scheduler SQL facade and a transaction callback share this shape. */
export type EventIngestionDatabase = typeof sql;
export type EventIngestionTransaction = EventIngestionDatabase;

export interface EventIngestionResult {
  deduped: boolean;
  seq?: number;
}

/** Snapshot of the Job row at ingest-transaction lock time. */
export interface EventIngestContext {
  /** `jobs.status` when this ingest transaction locked the row. */
  jobStatusAtLock: string;
}

/**
 * Semantic convergence is an explicit application callback so the append
 * boundary can remain transaction-owned. Production composition uses the
 * typed side-effect ports in `side-effects.ts`; this callback stays available
 * for focused adapters and characterization tests.
 */
export type EventSideEffects = (
  tx: EventIngestionTransaction,
  jobId: string,
  envelope: EventEnvelope,
  ingest?: EventIngestContext,
) => Promise<void>;

/**
 * Hub complete/intents must land before mark_job_done finalizes the Job.
 * A same-turn close may arrive as `done` then `hub_decision`; keep other
 * events in their original relative order.
 */
export function orderSemanticIngestBundle<T extends { type: string }>(envelopes: readonly T[]): T[] {
  const rest: T[] = [];
  const hub: T[] = [];
  const done: T[] = [];
  for (const envelope of envelopes) {
    if (envelope.type === "hub_decision") hub.push(envelope);
    else if (envelope.type === "done") done.push(envelope);
    else rest.push(envelope);
  }
  return [...rest, ...hub, ...done];
}

/** Same-turn mark_job_done / submit_hub_decision after an accepted request_human must not roll back the wait. */
export function shouldSkipTerminalAfterAcceptedHuman(type: string, acceptedHuman: boolean): boolean {
  return acceptedHuman && (type === "done" || type === "hub_decision");
}

export interface EventIngestionApplication {
  ingestEvent(jobId: string, envelope: EventEnvelopeInput): Promise<EventIngestionResult>;
  /** Append and apply a same-Job semantic terminal bundle atomically. */
  ingestEventBundle(jobId: string, envelopes: readonly EventEnvelopeInput[]): Promise<EventIngestionResult[]>;
}

function payloadErrorCode(type: string) {
  if (type === "progress") return CONTROL_INPUT_ERROR_CODES.invalidProgress;
  if (type === "done") return CONTROL_INPUT_ERROR_CODES.invalidDone;
  if (type === "human") return CONTROL_INPUT_ERROR_CODES.invalidHuman;
  return CONTROL_INPUT_ERROR_CODES.invalidPayload;
}

export function assertSemanticEventPayloadSize(
  type: string,
  payload: unknown,
  maxBytes = SEMANTIC_EVENT_PAYLOAD_MAX_BYTES,
): void {
  let payloadSize: number;
  try {
    payloadSize = Buffer.byteLength(JSON.stringify(payload ?? {}), "utf8");
  } catch {
    throw new ControlInputError(payloadErrorCode(type), "语义事件参数无法编码为有界 JSON。", "payload");
  }
  if (payloadSize > maxBytes) {
    throw new ControlInputError(
      payloadErrorCode(type),
      `语义事件参数超过 ${maxBytes} UTF-8 字节限制；请减少字段或条目后重试。`,
      "payload",
    );
  }
}

export interface EventIngestionOptions {
  maxPayloadBytes?: number;
  rateLimit?: Partial<EventRateLimitPolicy>;
  /** Scheduler-owned low-cardinality observation for authoritative rejects. */
  onRateLimited?: (error: EventRateLimitError, jobId: string) => void;
  /** Override only in deterministic tests; production uses PostgreSQL time. */
  clock?: () => Date;
}

class RetryCanvasResolution extends Error {
  readonly code = "EVENT_CANVAS_CHANGED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type CanvasNodeSnapshot = {
  id: string;
  canvasId: string | null;
};

type CanvasHintSource = "job" | "fact-intent-node" | "job-node" | "none";

type CanvasHint = {
  /** The immutable Job-owned canvas, when one exists. */
  jobCanvasId: string | null;
  /** A convergence canvas inferred from the Job or an event target node. */
  canvasId: string | null;
  /** How the lock target was resolved; kept for transaction re-validation. */
  source: CanvasHintSource;
  /** A fact's optional intent target, including a missing-row snapshot. */
  targetNodeId: string | null;
  targetNode: CanvasNodeSnapshot | null;
  /** All Job/Intent/Report nodes used by Canvas-aware side effects. */
  jobNodes: CanvasNodeSnapshot[];
};

function nodeSnapshot(row: { id: string; canvas_id: string | null }): CanvasNodeSnapshot {
  return { id: String(row.id), canvasId: (row.canvas_id as string | null) ?? null };
}

function sameNodeSnapshot(left: CanvasNodeSnapshot | null, right: CanvasNodeSnapshot | null): boolean {
  return left?.id === right?.id && left?.canvasId === right?.canvasId;
}

function sameNodeSnapshots(left: CanvasNodeSnapshot[], right: CanvasNodeSnapshot[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((snapshot, index) => sameNodeSnapshot(snapshot, right[index] ?? null));
}

/**
 * Resolve the lock target without taking a Job lock.  The subsequent
 * transaction re-checks the Job after acquiring Canvas, so a concurrent
 * canvas reassignment cannot silently invert the lock order.
 */
async function resolveCanvasHint(
  db: EventIngestionDatabase,
  jobId: string,
  envelope: EventEnvelope,
): Promise<CanvasHint> {
  const [job] = await db<{ canvas_id: string | null }[]>`
    SELECT canvas_id FROM jobs WHERE id = ${jobId}`;
  if (!job) throw new Error(`job ${jobId} does not exist`);

  const jobCanvasId = (job.canvas_id as string | null) ?? null;
  const targetNodeId =
    envelope.type === "fact" && isRecord(envelope.payload) && typeof envelope.payload.intent_node_id === "string"
      ? envelope.payload.intent_node_id
      : null;

  let targetNode: CanvasNodeSnapshot | null = null;
  // A fact can target an existing Intent node even when the producing Job is
  // legacy data without canvas_id.  Lock that canvas before the Job row too.
  if (targetNodeId) {
    const [node] = await db<{ id: string; canvas_id: string | null }[]>`
      SELECT id, canvas_id FROM canvas_nodes WHERE id = ${targetNodeId}`;
    if (node) targetNode = nodeSnapshot(node);
  }

  const jobNodes = await db<{ id: string; canvas_id: string | null }[]>`
    SELECT id, canvas_id FROM canvas_nodes
    WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})
    ORDER BY id`;
  const jobNodeSnapshots = jobNodes.map((node) => nodeSnapshot(node));
  const jobNodeCanvasIds = [...new Set(jobNodeSnapshots.map((node) => node.canvasId))];
  const targetCanvasId = targetNode?.canvasId ?? null;
  const resolvedCanvasId = targetCanvasId ?? jobCanvasId ?? jobNodeCanvasIds.find(Boolean) ?? null;
  if (targetCanvasId && jobCanvasId && targetCanvasId !== jobCanvasId) {
    throw new Error(`event intent node ${targetNodeId} does not belong to job canvas ${jobCanvasId}`);
  }
  if (jobNodeSnapshots.some((node) => !node.canvasId)) {
    throw new Error(`job ${jobId} has a Job/Intent/Report node without a Canvas`);
  }
  if (jobNodeCanvasIds.some((canvasId) => canvasId !== resolvedCanvasId)) {
    throw new Error(`job ${jobId} has a job node outside canvas ${resolvedCanvasId ?? "<none>"}`);
  }
  if (jobNodeCanvasIds.length > 1) {
    throw new Error(`job ${jobId} has multiple convergence canvases`);
  }

  return {
    jobCanvasId,
    canvasId: resolvedCanvasId,
    source: targetCanvasId ? "fact-intent-node" : jobCanvasId ? "job" : jobNodeCanvasIds[0] ? "job-node" : "none",
    targetNodeId,
    targetNode,
    jobNodes: jobNodeSnapshots,
  };
}

async function revalidateCanvasHint(
  tx: EventIngestionTransaction,
  jobId: string,
  hint: CanvasHint,
): Promise<void> {
  const [target] = hint.targetNodeId
    ? await tx<{ id: string; canvas_id: string | null }[]>`
        SELECT id, canvas_id FROM canvas_nodes WHERE id = ${hint.targetNodeId} FOR UPDATE`
    : [];
  const currentTarget = target ? nodeSnapshot(target) : null;
  if (!sameNodeSnapshot(currentTarget, hint.targetNode)) {
    throw new RetryCanvasResolution("event target node changed while resolving lock order");
  }

  const currentJobNodes = (
    await tx<{ id: string; canvas_id: string | null }[]>`
      SELECT id, canvas_id FROM canvas_nodes
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})
      ORDER BY id
      FOR UPDATE`
  ).map((node) => nodeSnapshot(node));
  if (!sameNodeSnapshots(currentJobNodes, hint.jobNodes)) {
    throw new RetryCanvasResolution("Job/Intent/Report nodes changed while resolving lock order");
  }

  if (currentTarget?.canvasId && currentTarget.canvasId !== hint.canvasId) {
    throw new RetryCanvasResolution("event target node moved to another Canvas");
  }
  if (currentJobNodes.some((node) => node.canvasId !== hint.canvasId)) {
    throw new RetryCanvasResolution("Job/Intent/Report node moved to another Canvas");
  }
  if (!hint.canvasId && (currentTarget?.canvasId || currentJobNodes.length > 0)) {
    throw new RetryCanvasResolution("a Canvas appeared after the lock target preflight");
  }
}

async function appendAndApplyBundle(
  db: EventIngestionDatabase,
  jobId: string,
  envelopes: readonly EventEnvelope[],
  hint: CanvasHint,
  sideEffects: EventSideEffects,
  options: EventIngestionOptions,
): Promise<EventIngestionResult[]> {
  return db.begin(async (rawTx) => {
    const tx = rawTx as unknown as EventIngestionTransaction;

    // Canvas-aware events use the proven single-transaction variant: the
    // Canvas lock is acquired before the Job lock, and append plus semantic
    // convergence commit or roll back together.  This removes the crash gap
    // that a Job-only append followed by a second transaction would create.
    if (hint.canvasId) {
      const [canvas] = await tx`SELECT id FROM canvases WHERE id = ${hint.canvasId} FOR UPDATE`;
      if (!canvas) throw new Error(`canvas ${hint.canvasId} does not exist`);
    }

    const [job] = await tx<{ id: string; canvas_id: string | null; status: string }[]>`
      SELECT id, canvas_id, status FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    if (!job) throw new Error(`job ${jobId} does not exist`);
    const ingest: EventIngestContext = { jobStatusAtLock: String(job.status) };

    const actualJobCanvasId = (job.canvas_id as string | null) ?? null;
    if (actualJobCanvasId !== hint.jobCanvasId) {
      throw new RetryCanvasResolution("Job canvas changed while resolving event lock order");
    }
    if (hint.canvasId && actualJobCanvasId && hint.canvasId !== actualJobCanvasId) {
      throw new RetryCanvasResolution("event canvas target changed while resolving lock order");
    }
    if (!hint.canvasId && actualJobCanvasId) {
      throw new RetryCanvasResolution("Job acquired a canvas after the preflight read");
    }
    await revalidateCanvasHint(tx, jobId, hint);

    const results: EventIngestionResult[] = [];
    let finalizedInThisIngest = false;
    let acceptedHumanInThisIngest = false;
    for (const envelope of orderSemanticIngestBundle(envelopes)) {
      // A later mark_job_done in the same ingest must not roll back a
      // successful close that already left running.
      if (finalizedInThisIngest && envelope.type === "done") {
        results.push({ deduped: true });
        continue;
      }
      // request_human is also a successful close. A same-turn done/hub after it
      // is a no-op so the wait gate is not rolled back by exclusivity.
      if (shouldSkipTerminalAfterAcceptedHuman(envelope.type, acceptedHumanInThisIngest)) {
        results.push({ deduped: true });
        continue;
      }
      const dedup = await tx`
        INSERT INTO event_dedup (event_id, job_id) VALUES (${envelope.event_id}, ${jobId})
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id`;
      if (dedup.length === 0) {
        results.push({ deduped: true });
        continue;
      }

      // The durable bucket is consumed only after the idempotency gate. A
      // replay therefore returns above without touching quota, while a
      // rejected event rolls back this marker together with every earlier
      // event and side effect in the bundle.
      const now = options.clock
        ? options.clock()
        : (await tx<{ now: Date }[]>`SELECT statement_timestamp() AS now`)[0]?.now;
      if (!now) throw new Error("event rate-limit clock unavailable");
      try {
        await consumeEventRateLimit(tx, jobId, envelope.type, new Date(now), options.rateLimit);
      } catch (error) {
        if (error instanceof EventRateLimitError) options.onRateLimited?.(error, jobId);
        throw error;
      }

      const [{ next }] = await tx<[{ next: number }]>`
        SELECT COALESCE(MAX(job_seq), 0) + 1 AS next FROM events WHERE job_id = ${jobId}`;

      await tx`
        INSERT INTO events ${tx({
          job_id: jobId,
          event_id: envelope.event_id,
          job_seq: next,
          type: envelope.type,
          payload_json: (envelope.payload ?? {}) as never,
        })}`;

      // The callback runs before this transaction commits.  A thrown side
      // effect rolls back every event_dedup/events row and side effect in the
      // bundle, making retry of the same bundle safe without a new marker.
      await sideEffects(tx, jobId, envelope, ingest);
      if (envelope.type === "done" || envelope.type === "human") {
        const [current] = await tx<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
        if (envelope.type === "done") finalizedInThisIngest = current?.status === "succeeded";
        if (envelope.type === "human") acceptedHumanInThisIngest = current?.status === "waiting_human";
      }
      results.push({ deduped: false, seq: next });
    }
    return results;
  });
}

export function createEventIngestionApplication(
  db: EventIngestionDatabase = sql,
  sideEffects: EventSideEffects,
  options: EventIngestionOptions = {},
): EventIngestionApplication {
  const maxPayloadBytes = options.maxPayloadBytes ?? SEMANTIC_EVENT_PAYLOAD_MAX_BYTES;
  const ingestEventBundle = async (
    jobId: string,
    inputs: readonly EventEnvelopeInput[],
  ): Promise<EventIngestionResult[]> => {
    if (inputs.length === 0) throw new Error("event bundle must not be empty");
    const envelopes = inputs.map((input) => {
      const parsed = EventEnvelopeSchema.safeParse(input);
      if (parsed.success) return parsed.data;
      const type = typeof input === "object" && input !== null && "type" in input
        ? (input as { type?: unknown }).type
        : undefined;
      const code = type === "done"
        ? CONTROL_INPUT_ERROR_CODES.invalidDone
        : type === "progress"
          ? CONTROL_INPUT_ERROR_CODES.invalidProgress
          : type === "human"
            ? CONTROL_INPUT_ERROR_CODES.invalidHuman
            : CONTROL_INPUT_ERROR_CODES.invalidPayload;
      const rejectedPath = parsed.error.issues[0]?.path.at(-1);
      throw new ControlInputError(
        code,
        "语义事件参数不符合严格契约；请修正后重试。",
        typeof rejectedPath === "string" ? rejectedPath : undefined,
      );
    });
    for (const envelope of envelopes) assertSemanticEventPayloadSize(envelope.type, envelope.payload, maxPayloadBytes);

    // A Job's canvas_id is immutable in normal operation.  One retry keeps
    // this boundary safe if a legacy repair path changes it between the
    // lock-target read and the transaction.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const hint = await resolveCanvasHint(db, jobId, envelopes[0]!);
      try {
        return await appendAndApplyBundle(db, jobId, envelopes, hint, sideEffects, options);
      } catch (error) {
        if (error instanceof RetryCanvasResolution && attempt === 0) continue;
        throw error;
      }
    }
    throw new Error(`event ${envelopes[0]!.event_id} could not stabilize its Canvas lock target`);
  };
  return {
    async ingestEvent(jobId, input) {
      const [result] = await ingestEventBundle(jobId, [input]);
      return result!;
    },
    ingestEventBundle,
  };
}
