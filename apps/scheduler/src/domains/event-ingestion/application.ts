import {
  EventEnvelope as EventEnvelopeSchema,
  type EventEnvelope,
  type EventEnvelopeInput,
} from "@deepsonar/shared-types";
import { sql } from "../../db.js";

/** The Scheduler SQL facade and a transaction callback share this shape. */
export type EventIngestionDatabase = typeof sql;
export type EventIngestionTransaction = EventIngestionDatabase;

export interface EventIngestionResult {
  deduped: boolean;
  seq?: number;
}

/**
 * Semantic convergence stays in core until the Hub/Verify/Report contexts are
 * extracted.  This callback is deliberately the only escape hatch from the
 * ingestion boundary; it receives the already-ordered transaction owned by
 * this application service.
 */
export type EventSideEffects = (
  tx: EventIngestionTransaction,
  jobId: string,
  envelope: EventEnvelope,
) => Promise<void>;

export interface EventIngestionApplication {
  ingestEvent(jobId: string, envelope: EventEnvelopeInput): Promise<EventIngestionResult>;
}

export interface EventIngestionOptions {
  maxPayloadBytes?: number;
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

async function appendAndApply(
  db: EventIngestionDatabase,
  jobId: string,
  envelope: EventEnvelope,
  hint: CanvasHint,
  sideEffects: EventSideEffects,
): Promise<EventIngestionResult> {
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

    const [job] = await tx<{ id: string; canvas_id: string | null }[]>`
      SELECT id, canvas_id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    if (!job) throw new Error(`job ${jobId} does not exist`);

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

    const dedup = await tx`
      INSERT INTO event_dedup (event_id, job_id) VALUES (${envelope.event_id}, ${jobId})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id`;
    if (dedup.length === 0) return { deduped: true };

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
    // effect therefore rolls back event_dedup/events as well, making retry of
    // the same event safe without a new schema-level processed marker.
    await sideEffects(tx, jobId, envelope);
    return { deduped: false, seq: next };
  });
}

export function createEventIngestionApplication(
  db: EventIngestionDatabase = sql,
  sideEffects: EventSideEffects,
  options: EventIngestionOptions = {},
): EventIngestionApplication {
  const maxPayloadBytes = options.maxPayloadBytes ?? 256 * 1024;
  return {
    async ingestEvent(jobId, input) {
      const envelope = EventEnvelopeSchema.parse(input);
      const payloadSize = Buffer.byteLength(JSON.stringify(envelope.payload ?? {}), "utf8");
      if (payloadSize > maxPayloadBytes) {
        throw new Error(`event payload 超限：${payloadSize}B > ${maxPayloadBytes / 1024}KB`);
      }

      // A Job's canvas_id is immutable in normal operation.  One retry keeps
      // this boundary safe if a legacy repair path changes it between the
      // lock-target read and the transaction.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const hint = await resolveCanvasHint(db, jobId, envelope);
        try {
          return await appendAndApply(db, jobId, envelope, hint, sideEffects);
        } catch (error) {
          if (error instanceof RetryCanvasResolution && attempt === 0) continue;
          throw error;
        }
      }
      throw new Error(`event ${envelope.event_id} could not stabilize its Canvas lock target`);
    },
  };
}
