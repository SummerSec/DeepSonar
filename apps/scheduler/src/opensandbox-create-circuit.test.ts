import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CREATE_CIRCUIT_COOLDOWN_MS,
  CREATE_CIRCUIT_FAILURES_TO_TRIP,
  CREATE_CIRCUIT_WINDOW_MS,
  openSandboxCreateCircuitAllowsClaim,
  openSandboxCreateCircuitStatus,
  recordOpenSandboxProvisionFailure,
  recordOpenSandboxProvisionSuccess,
  resetOpenSandboxCreateCircuitForTests,
} from "./opensandbox-create-circuit.js";

function clockAt(start = 1_000_000) {
  let now = start;
  const advance = (ms: number) => { now += ms; };
  return { clock: () => now, advance };
}

test("#1046 create circuit stays closed below the failure threshold and admits claims", () => {
  resetOpenSandboxCreateCircuitForTests(() => 1_000_000);
  // #1046: the trip threshold is the dispatcher-observed failure count in the window.
  assert.ok(CREATE_CIRCUIT_FAILURES_TO_TRIP >= 2);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  const status = openSandboxCreateCircuitStatus();
  assert.equal(status.state, "closed");
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(status), { allowed: true, canary: false });
});

test("#1046 create circuit pauses claims after the configured 5xx burst and holds them during cooldown", () => {
  const { clock } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED)");
  recordOpenSandboxProvisionFailure("Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED)");
  const status = openSandboxCreateCircuitStatus();
  assert.equal(status.state, "open");
  assert.match(status.lastTripReason ?? "", /SANDBOX_START_FAILED/);
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(status), { allowed: false, canary: false });
});

test("#1046 open circuit admits half-open canary claims after the cooldown without reserving a seat", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  advance(CREATE_CIRCUIT_COOLDOWN_MS - 1);
  assert.equal(openSandboxCreateCircuitAllowsClaim().allowed, false, "cooldown must still hold claims");
  advance(1);
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(), { allowed: true, canary: true });
  // An admitted claim that finds no work must not deadlock the gate.
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(), { allowed: true, canary: true });
  assert.equal(openSandboxCreateCircuitStatus().state, "half_open");
});

test("#1046 failed canary reopens; successful provision closes and clears the failure window", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  advance(CREATE_CIRCUIT_COOLDOWN_MS);
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(), { allowed: true, canary: true });
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED", true);
  const reopened = openSandboxCreateCircuitStatus();
  assert.equal(reopened.state, "open");
  advance(CREATE_CIRCUIT_COOLDOWN_MS);
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(), { allowed: true, canary: true });
  recordOpenSandboxProvisionSuccess();
  const closed = openSandboxCreateCircuitStatus();
  assert.equal(closed.state, "closed");
  assert.equal(closed.recentFailures, 0);
  assert.equal(closed.lastTripReason, null);
});

test("#1046 failures older than the window no longer trip the circuit", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  advance(CREATE_CIRCUIT_WINDOW_MS + 1);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  assert.equal(openSandboxCreateCircuitStatus().state, "closed");
});

test("#1046 dispatcher wires the circuit into claims, provision failures and recovery", () => {
  const source = readDispatcher();
  assert.ok(source.includes("OPENSANDBOX_CREATE_CIRCUIT_OPEN"), "claim pause must log the circuit code");
  const gate = source.indexOf("openSandboxCreateCircuitAllowsClaim(createCircuit)");
  const claimScan = source.indexOf("type ClaimCursor");
  assert.ok(gate > 0 && gate < claimScan, "the gate must run before claim scanning");
  assert.ok(source.includes("recordOpenSandboxProvisionFailure("), "provision failures must feed the circuit");
  assert.ok(source.includes("recordOpenSandboxProvisionSuccess()"), "successful provision must close it");
  assert.ok(source.includes("isRetryableProvisionFailure(error)"), "only retryable service shapes should trip");
});

function readDispatcher(): string {
  return readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
}
