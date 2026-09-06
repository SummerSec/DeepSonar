import type { FastifyInstance } from "fastify";
import { sql } from "../../db.js";
import { CursorError, pageLimit } from "../../pagination.js";
import { subscribeThenCatchUp, processStreamItemKey } from "../../process-stream-live.js";
import { isUuid } from "../../project-scope.js";
import { streamCursor, STREAM_SUBSCRIBER_QUEUE_MAX } from "../../stream-bus.js";
import { consumeWsTicket } from "../../ws-tickets.js";
import { WsSendQueue } from "../../ws-send-queue.js";
import { installWsCloseGuard } from "../../ws-early-close.js";
import { audit } from "../../audit.js";
import { runner } from "../../runtime.js";

const STREAMABLE_JOB_STATUSES = new Set(["running", "waiting_human"]);
const TERMINAL_INPUT_MAX_BYTES = 1024 * 1024;
const TERMINAL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const TERMINAL_FRAME_MAX_BYTES = 16 * 1024;
const TERMINAL_IDLE_MS = 15 * 60 * 1000;

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

    // Subscribe before the durable evidence snapshot.  The bus is delivery
    // only; catch-up always reads local BLOB_DIR.  A replica that cannot see
    // those files reports visibility=unavailable instead of inventing a gap.
    let after = q.after ?? null;
    const seen = new Set<string>();
    const emitLive = (item: { attempt_id?: unknown; seq?: unknown; cursor?: unknown }) => {
      const key = processStreamItemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      const next = typeof item.cursor === "string"
        ? item.cursor
        : streamCursor({
          attempt_id: typeof item.attempt_id === "string" ? item.attempt_id : "",
          seq: Number(item.seq),
        });
      enqueue({
        items: [item],
        after,
        next_cursor: next,
        has_more: false,
        watermark: next,
        live: true,
        source: "evidence",
      });
      after = next;
    };
    try {
      const opened = await subscribeThenCatchUp(jobId, {
        after: q.after ?? null,
        limit: pageLimit(q.limit),
        live: true,
        expectLocal: true,
      });
      unsub = opened.unsubscribe;
      if (abortIfClosed()) {
        cleanup();
        return;
      }
      for (const item of opened.snapshot.items) seen.add(processStreamItemKey(item));
      enqueue(opened.snapshot);
      after = opened.snapshot.next_cursor ?? after;
      opened.startLive(emitLive);
    } catch (error) {
      const code = error instanceof CursorError ? error.code : "INVALID_CURSOR";
      closeStream(code === "CURSOR_GAP" ? 4410 : 4400, code);
    }
  });

  // ---------- Governed interactive PTY (/terminal-ws) ----------
  app.get("/terminal-ws", { websocket: true }, async (socket, req) => {
    const q = req.query as { job_id?: string; ticket?: string; cols?: string; rows?: string };
    const jobId = q.job_id?.trim() ?? "";
    if (!isUuid(jobId)) return socket.close(4400, "invalid job_id");
    const actor = consumeWsTicket(q.ticket ?? "", jobId, "terminal");
    if (!actor) return socket.close(4401, "invalid or expired terminal ticket");
    if (!actor.scopes.includes("admin") && !actor.scopes.includes("jobs:control")) {
      return socket.close(4403, "terminal permission denied");
    }
    const [job] = await sql`
      SELECT id, project_id, status, sandbox_id, lease_expires_at, agent_snapshot_json
      FROM jobs WHERE id = ${jobId}`;
    if (!job) return socket.close(4404, "job not found");
    if (actor.projectId && actor.projectId !== job.project_id) return socket.close(4403, "project scope denied");
    if (!STREAMABLE_JOB_STATUSES.has(String(job.status))) return socket.close(4409, "job is not running");
    if (!job.sandbox_id) return socket.close(4411, "job sandbox is unavailable");
    if (job.lease_expires_at && new Date(String(job.lease_expires_at)).getTime() <= Date.now()) {
      return socket.close(4411, "job lease expired");
    }
    const snapshot = job.agent_snapshot_json as Record<string, unknown> | null;
    const runtime = snapshot?.agent_runtime as { capabilities?: { interactiveTerminal?: boolean } } | undefined;
    if (runtime?.capabilities?.interactiveTerminal !== true) return socket.close(4412, "runtime terminal unsupported");
    if (!runner.openTerminal || !await runner.isAlive({ sandboxId: String(job.sandbox_id) }).catch(() => false)) {
      return socket.close(4411, "job sandbox is unavailable");
    }

    const cols = Number.parseInt(q.cols ?? "120", 10);
    const rows = Number.parseInt(q.rows ?? "32", 10);
    let terminal;
    try {
      terminal = await runner.openTerminal({ sandboxId: String(job.sandbox_id) }, { cols, rows });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 80) : "TERMINAL_OPEN_FAILED";
      await audit(req, { action: "terminal.open", projectId: String(job.project_id), resourceType: "job", resourceId: jobId, result: "error", errorCode: code });
      return socket.close(code === "TERMINAL_PROVIDER_UNSUPPORTED" ? 4412 : 4411, code);
    }

    let inputBytes = 0;
    let outputBytes = 0;
    let closeReason = "client_disconnect";
    let closed = false;
    let idleTimer: NodeJS.Timeout;
    const queue = new WsSendQueue(socket, {
      maxItems: 256,
      maxBytes: 512 * 1024,
      onClose: () => void close("backpressure"),
    });
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void close("idle_timeout", 4413), TERMINAL_IDLE_MS);
      idleTimer.unref?.();
    };
    const close = async (reason: string, code?: number) => {
      if (closed) return;
      closed = true;
      closeReason = reason;
      clearTimeout(idleTimer);
      queue.stop();
      await terminal.close().catch(() => undefined);
      await audit(req, {
        action: "terminal.close",
        projectId: String(job.project_id),
        resourceType: "job",
        resourceId: jobId,
        after: { session_id: terminal.id, input_bytes: inputBytes, output_bytes: outputBytes, close_reason: closeReason },
      });
      if (code && socket.readyState < 2) socket.close(code, reason);
    };
    resetIdle();
    await audit(req, {
      action: "terminal.open",
      projectId: String(job.project_id),
      resourceType: "job",
      resourceId: jobId,
      after: { session_id: terminal.id },
    });
    queue.enqueue({ type: "ready", session_id: terminal.id });

    socket.on("message", (raw: unknown) => {
      if (closed) return;
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
      if (!text || Buffer.byteLength(text) > TERMINAL_FRAME_MAX_BYTES) return void close("frame_too_large", 4414);
      let message: { type?: string; data?: string; cols?: number; rows?: number };
      try { message = JSON.parse(text) as typeof message; } catch { return void close("invalid_frame", 4400); }
      resetIdle();
      if (message.type === "input" && typeof message.data === "string") {
        const bytes = Buffer.byteLength(message.data);
        inputBytes += bytes;
        if (inputBytes > TERMINAL_INPUT_MAX_BYTES) return void close("input_limit", 4414);
        void terminal.write(message.data).catch(() => close("write_failed", 4411));
      } else if (message.type === "resize" && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
        void terminal.resize(message.cols!, message.rows!).catch(() => close("resize_failed", 4412));
      } else if (message.type === "close") {
        void close("client_close", 1000);
      } else {
        void close("invalid_frame", 4400);
      }
    });
    socket.on("close", () => void close("client_disconnect"));
    socket.on("error", () => void close("socket_error"));

    try {
      for await (const data of terminal.output) {
        if (closed) break;
        outputBytes += Buffer.byteLength(data);
        if (outputBytes > TERMINAL_OUTPUT_MAX_BYTES) {
          await close("output_limit", 4414);
          break;
        }
        queue.enqueue({ type: "output", data });
      }
      await close("pty_exit", 1000);
    } catch {
      await close("pty_error", 4411);
    }
  });
}
