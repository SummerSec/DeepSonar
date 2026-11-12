// #944: an unacknowledged input is retried with the exact same bytes before the
// Job fails, and a late duplicate reply to a retransmit is not a protocol error.
import assert from "node:assert/strict";
import test from "node:test";
import { ACK_MEMORY, MAX_ACK_RETRIES, PiRpcDriver } from "./pi-rpc-driver.js";
import type { RuntimeProcess, RuntimeProcessChunk } from "./runtime-host.js";

const sessionFile = "/workspace/.deepsonar-home/.pi/agent/session.jsonl";

class SilentProcess implements RuntimeProcess {
  stdinClosed = false;
  writes: string[] = [];
  killed = false;
  async write(data: string) { this.writes.push(data); }
  async closeStdin() { this.stdinClosed = true; }
  async kill() { this.killed = true; }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    // The driver tests only observe writes; no stdout is produced.
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an unacknowledged input is resent with identical bytes, then fails", async () => {
  const proc = new SilentProcess();
  const driver = new PiRpcDriver(proc, () => {}, undefined, 10);
  try {
    await driver.initialize("initial");
    assert.equal(proc.writes.length, 1, "the first write happens immediately");
    const firstId = JSON.parse(proc.writes[0]!).id as string;

    await wait(200);
    assert.ok(driver.error, "the driver gives up after the retry budget");
    assert.match(driver.error!.message, /PI_RPC_ACK_TIMEOUT/);
    assert.equal(proc.writes.length, 1 + MAX_ACK_RETRIES, "one send plus three retransmits");
    for (const write of proc.writes) {
      assert.equal(JSON.parse(write).id, firstId, "a retransmit reuses the same id");
      assert.equal(write, proc.writes[0], "a retransmit resends the exact same bytes");
    }
  } finally {
    driver.dispose();
  }
});

test("a late duplicate reply to a retransmit is ignored, not a mismatch", async () => {
  const proc = new SilentProcess();
  const driver = new PiRpcDriver(proc, () => {}, undefined, 5_000);
  try {
    await driver.initialize("initial");
    const stateId = JSON.parse(proc.writes[0]!).id as string;
    const reply = { type: "response", id: stateId, command: "get_state", success: true, data: { sessionId: "s1", sessionFile } };
    assert.equal(await driver.observe(reply), true, "the first reply is accepted");
    // The prompt triggered by get_state is still outstanding; ignore it here.
    assert.equal(await driver.observe(reply), false, "the duplicate reply is tolerated but not redispatched to recovery");
    await driver.queryState();
    const writes = proc.writes.length;
    assert.equal(await driver.observe(reply), false, "an older state must not settle a new recovery query");
    assert.equal(proc.writes.length, writes, "the duplicate cannot replay bootstrap or issue a recovery input");
    assert.equal(driver.error, undefined);
  } finally {
    driver.dispose();
  }
});

test("an unknown response id is still rejected", async () => {
  const proc = new SilentProcess();
  const driver = new PiRpcDriver(proc, () => {}, undefined, 5_000);
  try {
    await driver.initialize("initial");
    await assert.rejects(
      async () => driver.observe({ type: "response", id: "not-issued", command: "get_state", success: true }),
      /PI_RPC_RESPONSE_ID_MISMATCH/,
    );
  } finally {
    driver.dispose();
  }
});

test("the ack memory stays bounded", () => {
  assert.equal(ACK_MEMORY, 256);
  assert.equal(MAX_ACK_RETRIES, 3);
});

test("an unacknowledged prompt is never retransmitted", async () => {
  // Pi 1.5.2 hands every `prompt` frame to `session.prompt` and never keys it by
  // request id, so a resend could run the same turn twice. Only read-only
  // commands may be retried; prompt stays fail closed.
  const proc = new SilentProcess();
  const driver = new PiRpcDriver(proc, () => {}, undefined, 10);
  try {
    await driver.initialize("initial");
    const stateId = JSON.parse(proc.writes[0]!).id as string;
    await driver.observe({ type: "response", id: stateId, command: "get_state", success: true, data: { sessionId: "s1", sessionFile } });
    assert.equal(proc.writes.length, 2, "get_state plus the bootstrap prompt");
    assert.equal(JSON.parse(proc.writes[1]!).type, "prompt");

    await wait(200);
    assert.ok(driver.error, "the driver gives up");
    assert.equal(proc.writes.length, 2, "the prompt is written exactly once");
    assert.equal(proc.killed, true);
  } finally {
    driver.dispose();
  }
});
