import type { FastifyInstance } from "fastify";
import { sql } from "../../db.js";
import { readNormalizedStreamPage } from "../../evidence.js";
import { CursorError, pageLimit } from "../../pagination.js";
import { isUuid } from "../../project-scope.js";
import { streamCursor, streamItemKey, streamWindow, subscribeStream, STREAM_SUBSCRIBER_QUEUE_MAX } from "../../stream-bus.js";
import { consumeWsTicket } from "../../ws-tickets.js";
import { WsSendQueue } from "../../ws-send-queue.js";
import { installWsCloseGuard } from "../../ws-early-close.js";

const STREAMABLE_JOB_STATUSES = new Set(["running", "waiting_human"]);

export function registerStreamRoutes(app: FastifyInstance): void {
  // ---------- Agent 实时流（WS /ws?job_id=...&ticket=...） ----------
  // Browser upgrades consume a short-lived one-use ticket.  A small outbound
  // queue bounds memory; when a slow client cannot keep up we close with 1013
  // so the UI can backfill over HTTP and reconnect.
  app.get("/ws", { websocket: true }, async (socket, req) => {
    // Install this before the first database/evidence await.  The client can
    // close while those reads are in flight; the guard then prevents a late
    // subscribe and invokes the stream cleanup once it exists.
    let cleanup: () => void = () => {};
    const closeGuard = installWsCloseGuard(socket, () => cleanup());
    const abortIfClosed = () => {
      if (closeGuard.isOpen()) return false;
      closeGuard.dispose();
      return true;
    };
    const q = req.query as { job_id?: string; ticket?: string; after?: string; limit?: string };
    const jobId = q.job_id?.trim();
    if (!jobId) {
      closeGuard.dispose();
      socket.close(4400, "missing job_id");
      return;
    }
    if (!isUuid(jobId)) {
      closeGuard.dispose();
      socket.close(4400, "invalid job_id");
      return;
    }
    const actor = consumeWsTicket(q.ticket ?? "", jobId);
    if (!actor) {
      closeGuard.dispose();
      socket.close(4401, "invalid or expired websocket ticket");
      return;
    }
    if (abortIfClosed()) return;
    const [job] = await sql`SELECT id, project_id, status FROM jobs WHERE id = ${jobId}`;
    if (abortIfClosed()) return;
    if (!job) {
      closeGuard.dispose();
      socket.close(4404, "job not found");
      return;
    }
    if (actor.projectId && actor.projectId !== job.project_id) {
      closeGuard.dispose();
      socket.close(4403, "project scope denied");
      return;
    }
    if (!STREAMABLE_JOB_STATUSES.has(String(job.status))) {
      closeGuard.dispose();
      socket.close(4409, "job is not running");
      return;
    }

    // Validate an opaque cursor against durable/active evidence before the
    // in-memory bus snapshot.  A bus restart is allowed to have no matching
    // frame, but an evidence gap must be explicit rather than a silent reset.
    if (q.after) {
      try {
        await readNormalizedStreamPage(jobId, { after: q.after, limit: 1, live: true });
      } catch (error) {
        const code = error instanceof CursorError ? error.code : "INVALID_CURSOR";
        closeGuard.dispose();
        socket.close(code === "CURSOR_GAP" ? 4410 : 4400, code);
        return;
      }
      if (abortIfClosed()) return;
    }

    let closed = false;
    let unsub = () => {};
    let queue: WsSendQueue;
    let cleaned = false;
    cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      closed = true;
      queue?.stop();
      unsub();
      closeGuard.dispose();
    };
    const closeStream = (code: number, reason: string) => {
      if (cleaned) return;
      cleanup();
      try { socket.close(code, reason); } catch { /* ignore */ }
    };
    queue = new WsSendQueue(socket, {
      maxItems: STREAM_SUBSCRIBER_QUEUE_MAX,
      maxBytes: STREAM_SUBSCRIBER_QUEUE_MAX * 16 * 1024,
      onClose: () => cleanup(),
    });
    const enqueue = (value: unknown) => {
      if (!closed) queue.enqueue(value);
    };

    if (abortIfClosed()) return;

    // Subscribe before taking the snapshot.  Anything published during the
    // synchronous snapshot is held in this pending list and drained after the
    // initial page, preventing the classic snapshot/subscribe race.
    const pendingItems: ReturnType<typeof streamWindow>["items"] = [];
    let snapshotting = true;
    let after = q.after ?? null;
    const seen = new Set<string>();
    const emitLive = (item: (typeof pendingItems)[number]) => {
      const key = streamItemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      const next = streamCursor(item);
      enqueue({
        items: [item],
        events: [item],
        after,
        next_cursor: next,
        has_more: false,
        watermark: next,
        live: true,
      });
      after = next;
    };
    unsub = subscribeStream(jobId, (item) => {
      if (snapshotting) pendingItems.push(item);
      else emitLive(item);
    });
    // Check again immediately after subscribing.  No await occurs between
    // this check and subscribe, but a close event may already have been
    // observed by the early guard while setup was finishing.
    if (abortIfClosed()) {
      cleanup();
      return;
    }
    let initial;
    try {
      // The HTTP evidence endpoint validates a durable cursor before opening
      // this connection.  A valid cursor may still be absent after a restart
      // because the in-memory bus is best effort, so allow that case here.
      initial = streamWindow(jobId, {
        after: q.after ?? null,
        limit: pageLimit(q.limit),
        allowMissingCursor: Boolean(q.after),
      });
    } catch (error) {
      const code = error instanceof CursorError ? error.code : "INVALID_CURSOR";
      closeStream(code === "CURSOR_GAP" ? 4410 : 4400, code);
      return;
    }
    if (abortIfClosed()) {
      cleanup();
      return;
    }
    for (const item of initial.items) seen.add(streamItemKey(item));
    enqueue({ ...initial, events: initial.items });
    after = initial.next_cursor ?? after;
    snapshotting = false;
    for (const item of pendingItems) emitLive(item);
  });
}
