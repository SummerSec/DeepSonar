import type { RuntimeProcess } from "./runtime-host.js";

/** #944: how many times an unacknowledged input is resent before the Job fails. */
export const MAX_ACK_RETRIES = 3;
/**
 * #944: only idempotent, read-only commands may be retransmitted.
 *
 * The pinned Pi 1.4.0 RPC handler calls `session.prompt` for every `prompt`
 * frame and never keys it by request id, so "same id" only correlates the
 * reply. Resending a prompt can therefore run the model (and its tools) twice.
 * Anything not listed here fails closed on the first missed ACK.
 */
export const RETRYABLE_COMMANDS: ReadonlySet<string> = new Set(["get_state"]);
/** #944: bounded memory of settled ids so late duplicate replies stay harmless. */
export const ACK_MEMORY = 256;

/** One process, one serialized command stream. Never replay an unacknowledged input. */
export class PiRpcDriver {
  private serial = 0;
  private writes: Promise<void> = Promise.resolve();
  private ready = false;
  private active = false;
  private started = false;
  private bootstrap = "";
  private beforePrompt?: () => Promise<void>;
  private commands = new Map<string, string>();
  /** #944: last serialized payload per id so an unacknowledged input can be resent. */
  private payloads = new Map<string, string>();
  /** #944: how many times each id has been retransmitted. */
  private attempts = new Map<string, number>();
  /** #944: ids already acknowledged, so a duplicate reply to a retransmit is not a mismatch. */
  private acked: string[] = [];
  private readonly ackedSet = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  private captureDepth = 0;
  private startPending = false;
  private startTimer?: ReturnType<typeof setTimeout>;
  error?: Error;

  constructor(
    private readonly process: RuntimeProcess,
    private readonly resetTurn: () => void,
    private readonly expected?: { sessionId: string; sessionFile: string },
    private readonly timeoutMs = 10_000,
  ) {}

  private watch(id: string, code: string): void {
    this.timers.set(id, this.captureDepth ? undefined : setTimeout(() => this.onAckTimeout(id, code), this.timeoutMs));
  }

  /**
   * #944: `PI_RPC_INPUT_UNACKNOWLEDGED` used to be terminal on the first missed
   * ACK, even though a read-only probe often succeeds on a retry. Resend the
   * exact bytes (same id) up to MAX_ACK_RETRIES times with exponential backoff,
   * then fail.
   *
   * Only `RETRYABLE_COMMANDS` qualifies. A `prompt` is not retransmitted: the
   * pinned Pi 1.4.0 does not dedupe by request id, so a resend could execute the
   * same turn twice. For prompt the ACK deadline stays terminal, which also
   * removes the old conflict where the earlier `watchStart` deadline killed the
   * process before any retry could run.
   */
  private onAckTimeout(id: string, code: string): void {
    if (this.error) return;
    const attempt = this.attempts.get(id) ?? 0;
    const payload = this.payloads.get(id);
    const command = this.commands.get(id) ?? "";
    if (attempt >= MAX_ACK_RETRIES || payload === undefined || !RETRYABLE_COMMANDS.has(command)) {
      this.fail(code);
      return;
    }
    this.attempts.set(id, attempt + 1);
    const backoff = Math.min(this.timeoutMs * 2 ** attempt, this.timeoutMs * 4);
    const next = this.writes.then(() => this.process.write(payload));
    this.writes = next.catch(() => {});
    this.timers.set(id, this.captureDepth ? undefined : setTimeout(() => this.onAckTimeout(id, code), backoff));
  }

  private rememberAck(id: string): void {
    if (this.ackedSet.has(id)) return;
    this.ackedSet.add(id);
    this.acked.push(id);
    while (this.acked.length > ACK_MEMORY) {
      const evicted = this.acked.shift();
      if (evicted) this.ackedSet.delete(evicted);
    }
  }

  private watchStart(): void {
    this.startPending = true;
    this.startTimer = this.captureDepth ? undefined : setTimeout(() => this.fail("PI_RPC_START_TIMEOUT"), this.timeoutMs);
  }

  /** Host output persistence is bounded separately; it must not count as missing provider ACK time. */
  async whileCapturing<T>(capture: () => Promise<T>): Promise<T> {
    this.captureDepth++;
    for (const [id, timer] of this.timers) { clearTimeout(timer); this.timers.set(id, undefined); }
    clearTimeout(this.startTimer);
    try { return await capture(); }
    finally {
      this.captureDepth--;
      if (!this.captureDepth && !this.error) {
        for (const id of this.timers.keys()) this.watch(id, `PI_RPC_ACK_TIMEOUT: ${this.commands.get(id)}`);
        if (this.startPending) this.watchStart();
      }
    }
  }

  private fail(code: string): void {
    this.error ??= new Error(code);
    this.dispose();
    void this.process.kill().catch(() => {});
  }

  private command(command: Record<string, unknown>): Promise<void> {
    const id = `deepsonar-${++this.serial}`;
    this.commands.set(id, String(command.type));
    this.watch(id, `PI_RPC_ACK_TIMEOUT: ${String(command.type)}`);
    const payload = `${JSON.stringify({ ...command, id })}\n`;
    this.payloads.set(id, payload);
    const next = this.writes.then(() => this.process.write(payload));
    this.writes = next.catch(() => {});
    return next;
  }

  async initialize(input: string, beforePrompt?: () => Promise<void>): Promise<void> {
    this.bootstrap = input;
    this.beforePrompt = beforePrompt;
    await this.command({ type: "get_state" });
  }

  async send(content: string): Promise<void> {
    if (this.error) throw this.error;
    if (!this.ready) throw new Error("PI_SESSION_NOT_READY");
    // prompt with streamingBehavior is atomic in Pi: it starts an idle loop or
    // queues on a running loop. Bare steer/follow_up can strand input if the
    // process settles between our observation and the RPC handler.
    if (!this.active) {
      this.active = true;
      this.started = false;
      this.resetTurn();
      this.watchStart();
    }
    await this.command({ type: "prompt", message: content, streamingBehavior: "steer" });
  }

  async observe(record: Record<string, unknown>): Promise<boolean> {
    if (this.error) throw this.error;
    if (record.type === "response") {
      const id = typeof record.id === "string" ? record.id : "";
      if (!this.timers.has(id)) {
        // A retransmit can produce a second reply for an id we already settled.
        // Treat it as the duplicate it is instead of failing the Job.
        if (this.ackedSet.has(id)) return true;
        throw new Error("PI_RPC_RESPONSE_ID_MISMATCH");
      }
      if (this.commands.get(id) !== record.command) throw new Error("PI_RPC_RESPONSE_ID_MISMATCH");
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.commands.delete(id);
      this.payloads.delete(id);
      this.attempts.delete(id);
      this.rememberAck(id);
      if (record.success !== true) return true; // Adapter owns the terminal error detail.
      if (record.command === "prompt") {
        const disposition = (record.data as { disposition?: unknown } | undefined)?.disposition;
        if (disposition !== "started" && disposition !== "queued") throw new Error("PI_RPC_INPUT_NOT_STARTED");
        if (!this.active && disposition === "started") {
          this.watchStart();
        }
      }
      if (record.command === "get_state") {
        const data = record.data as { sessionId?: unknown; sessionFile?: unknown } | undefined;
        if (typeof data?.sessionId !== "string" || !data.sessionId || typeof data.sessionFile !== "string"
          || !data.sessionFile.startsWith("/workspace/.deepsonar-home/.pi/agent/")
          || data.sessionFile.includes("/../") || data.sessionFile.includes("\0")) {
          throw new Error("PI_SESSION_IDENTITY_MISSING");
        }
        if (this.expected && (data.sessionId !== this.expected.sessionId || data.sessionFile !== this.expected.sessionFile)) {
          throw new Error("CONTEXT_RESUME_SESSION_IDENTITY_MISMATCH");
        }
        this.ready = true;
        await this.beforePrompt?.();
        await this.send(this.bootstrap);
      }
    } else if (record.type === "agent_start") {
      if (!this.active) this.resetTurn();
      this.started = true;
      this.active = true;
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
      this.startPending = false;
    } else if (record.type === "agent_settled") {
      if (!this.started) throw new Error("PI_RPC_SETTLED_WITHOUT_START");
      this.active = false;
      this.started = false;
      // A concurrent input may be accepted after this settlement. Do not close
      // stdin or issue another completion nudge while its ACK is outstanding.
      if (this.timers.size) return false;
    }
    return true;
  }

  finishError(): Error | undefined {
    return this.error ?? (this.timers.size ? new Error("PI_RPC_INPUT_UNACKNOWLEDGED") : undefined);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.commands.clear();
    this.payloads.clear();
    this.attempts.clear();
    clearTimeout(this.startTimer);
    this.startTimer = undefined;
    this.startPending = false;
  }
}
