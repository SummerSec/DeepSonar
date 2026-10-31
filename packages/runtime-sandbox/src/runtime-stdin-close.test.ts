import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STDIN_CLOSE_KILL_MS,
  createStdinCloseKiller,
  resolveStdinCloseKillMs,
} from "./runtime-stdin-close.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("resolveStdinCloseKillMs prefers explicit grace then env then default", () => {
  assert.equal(resolveStdinCloseKillMs(20), 20);
  assert.equal(resolveStdinCloseKillMs(undefined, { DEEPSONAR_STDIN_CLOSE_KILL_MS: "50" }), 50);
  assert.equal(resolveStdinCloseKillMs(undefined, {}), DEFAULT_STDIN_CLOSE_KILL_MS);
  assert.equal(resolveStdinCloseKillMs(0, { DEEPSONAR_STDIN_CLOSE_KILL_MS: "nope" }), DEFAULT_STDIN_CLOSE_KILL_MS);
});

test("terminal_result closeStdin schedules kill; initial_input does not", async () => {
  let killed = 0;
  const killer = createStdinCloseKiller({
    kill: () => {
      killed += 1;
    },
    graceMs: 20,
  });
  killer.afterClose("initial_input");
  await wait(40);
  assert.equal(killed, 0);
  killer.afterClose("terminal_result");
  killer.afterClose("terminal_result");
  await wait(40);
  assert.equal(killed, 1);
});

test("cancel prevents the stdin-close kill", async () => {
  let killed = 0;
  const killer = createStdinCloseKiller({
    kill: () => {
      killed += 1;
    },
    graceMs: 20,
  });
  killer.afterClose("terminal_result");
  killer.cancel();
  await wait(40);
  assert.equal(killed, 0);
});
