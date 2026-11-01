import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Use exactly the production LF-only framer/allowlist when loading this client.
// No unknown record is ignored, and every record is retained for assertions.
export class RpcClient {
  records = [];
  wireRecalls = [];
  stderr = "";
  sequence = 0;
  pending = new Map();
  waiters = new Set();
  error;
  constructor(cli, args, options, Framer, parse) {
    this.child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-approve", "--offline", "--no-extensions", ...args],
      { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const framer = new Framer();
    this.child.stdout.on("data", (chunk) => {
      try {
        for (const line of framer.push(chunk)) {
          const wire = JSON.parse(line);
          if (wire.type === "tool_execution_end" && wire.toolName === "recall") this.wireRecalls.push(wire);
          const record = parse(line);
          this.records.push(record);
          if (record.type === "response") {
            const pending = this.pending.get(record.id);
            if (pending) { this.pending.delete(record.id); pending.resolve(record); }
          }
          for (const waiter of [...this.waiters]) if (waiter.predicate(record)) waiter.resolve(record);
        }
      } catch (error) { this.fail(error); }
    });
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16384); });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) => {
      try { framer.finish(); } catch (error) { this.fail(error); }
      this.fail(new Error(`Pi exited (${code}); ${this.stderr.slice(-512)}`));
    });
  }
  fail(error) {
    this.error ??= error;
    for (const pending of this.pending.values()) pending.reject(this.error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(this.error);
  }
  command(type, args = {}) {
    if (this.error) return Promise.reject(this.error);
    const id = `rpc-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${type}`)); }, 20000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(JSON.stringify({ type, id, ...args }) + "\n");
    });
  }
  until(predicate) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => waiter.reject(new Error("RPC event timeout")), 20000);
      const waiter = { predicate,
        resolve: (record) => { clearTimeout(timer); this.waiters.delete(waiter); resolve(record); },
        reject: (error) => { clearTimeout(timer); this.waiters.delete(waiter); reject(error); } };
      this.waiters.add(waiter);
    });
  }
  async turn(message, hardFailure = false) {
    const end = this.until((record) => record.type === (hardFailure ? "extension_error" : "agent_settled"));
    // Attach rejection before awaiting command acceptance (a failed boot may
    // reject both promises in the same event-loop tick).
    const accepted = this.command("prompt", { message });
    const [response, settled] = await Promise.all([accepted, end]);
    assert.equal(response.success, true);
    if (!hardFailure) assert.equal(settled.aborted, false);
    return settled;
  }
  async stop(kill = false) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("close", resolve));
    if (kill) this.child.kill("SIGKILL");
    else this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  }
}
