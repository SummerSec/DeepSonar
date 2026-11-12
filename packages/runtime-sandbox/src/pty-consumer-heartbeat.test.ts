import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { WebSocket } from "undici";
import { runRealAgent } from "./runtime-agent.js";
import { createOpenSandboxRuntimeHost, type OpenSandboxSession } from "./opensandbox.js";
import { openOpenSandboxPty, type WebSocketLike } from "./opensandbox-pty.js";

test("real Undici Pong survives slow Pi progress consumption within one WS message", { timeout: 60_000 }, async context => {
  const progress = "BUILD_OK\n" + "AddressSanitizer:DEADLYSIGNAL\n".repeat(1800);
  const progressConsumed = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(new URL("../../../agent-harness/fixtures/pty-consumer-heartbeat.cjs", import.meta.url), {
    workerData: { schedulerPackage: fileURLToPath(new URL("../../../apps/scheduler/package.json", import.meta.url)), progress,
      progressConsumed: progressConsumed.buffer },
  });
  const sequences: number[] = [];
  let pongAt = -1;
  let heartbeatTimedOut = false;
  let promptCount = 0;
  let starts = 0;
  let activeHandle: Awaited<ReturnType<typeof openOpenSandboxPty>> | undefined;
  let fixtureFailure: Error | undefined;
  let stopping = false;
  let cleanupPromise: Promise<void> | undefined;
  let rejectReady!: (error: Error) => void;
  const cleanup = () => cleanupPromise ??= (async () => {
    stopping = true;
    try { await activeHandle?.kill().catch(() => {}); }
    finally { await worker.terminate(); }
  })();
  const failFixture = (error: Error) => {
    if (stopping) return;
    fixtureFailure ??= error;
    rejectReady(error);
    // Wake the production reader as well as a still-pending startup promise.
    void activeHandle?.kill().catch(() => {});
  };
  context.after(cleanup);
  context.signal.addEventListener("abort", () => {
    rejectReady(new Error("heartbeat fixture aborted"));
    void cleanup();
  }, { once: true });
  const ready = new Promise<{ url: string; count: number; deadlineMs: number }>((resolve, reject) => {
    rejectReady = reject;
    worker.on("error", failFixture);
    worker.on("exit", code => { if (!stopping) failFixture(new Error(`heartbeat worker exited unexpectedly: ${code}`)); });
    worker.on("message", message => {
      if (stopping) return;
      if (message.type === "ready") resolve(message);
      else if (message.type === "fixture_error") failFixture(new Error(message.message));
      else if (message.type === "pong") { pongAt = message.progressConsumed; promptCount = message.prompts; context.diagnostic(`Pong observed at progress ${pongAt}, server elapsed ${Math.round(message.elapsed)}ms`); }
      else if (message.type === "heartbeat_timeout") { heartbeatTimedOut = true; promptCount = message.prompts; }
    });
  });
  try {
    const { url, count } = await ready;
    const session: OpenSandboxSession = {
      id: "heartbeat-sandbox",
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
      async runAsync() {
        starts++;
        activeHandle = await openOpenSandboxPty({ httpUrl: url, headers: {} }, { pty: false }, {
          openWebSocket: endpoint => new WebSocket(endpoint) as unknown as WebSocketLike,
        });
        if (fixtureFailure || context.signal.aborted) {
          await activeHandle.kill();
          throw fixtureFailure ?? new Error("heartbeat fixture aborted");
        }
        return activeHandle;
      },
      async writeFile() {}, async readFile() { return Buffer.from(""); },
      async getState() { return "Running"; }, async kill() {}, async close() {},
    };
    const result = await runRealAgent(createOpenSandboxRuntimeHost(session), {
      provider: "pi", env: {}, input: "synthetic progress fixture", completionGate: () => true,
      onEvent: event => {
        if (event.type !== "tool.call.progress") return;
        const content = event.content as { content: Array<{ text: string }>; details: { sequence: number } };
        assert.equal(content.content[0]?.text, progress, "all progress bytes survive");
        sequences.push(content.details.sequence);
        if (sequences.length === 1) worker.postMessage("consuming");
        // A bounded synchronous consumer makes fairness deterministic without a
        // machine-speed performance threshold or a real model/tool execution.
        const until = performance.now() + 200;
        while (performance.now() < until) { /* intentional synthetic work */ }
        Atomics.store(progressConsumed, 0, sequences.length);
        if (sequences.length === count) worker.postMessage("consumed");
      },
    });
    assert.equal(fixtureFailure, undefined);
    assert.equal(heartbeatTimedOut, false, "the independent server missed Pong");
    assert.ok(pongAt > 0 && pongAt < count, `Pong serviced after ${pongAt}/${count} progress records`);
    assert.deepEqual(sequences, Array.from({ length: count }, (_, n) => n));
    assert.equal(starts, 1);
    assert.equal(promptCount, 1, "no process/prompt replay to recover heartbeat");
    assert.equal(result.error, undefined);
    assert.equal(result.terminalOutcome, "success");
  } finally { await cleanup(); }
});
