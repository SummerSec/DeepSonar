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
  shouldLogCreateCircuitPause,
  classifyProvisionFailure,
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
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(status), { allowed: true, canary: false, episode: null });
});

test("#1046 create circuit pauses claims after the configured 5xx burst and holds them during cooldown", () => {
  const { clock } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED)");
  recordOpenSandboxProvisionFailure("Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED)");
  const status = openSandboxCreateCircuitStatus();
  assert.equal(status.state, "open");
  assert.match(status.lastTripReason ?? "", /SANDBOX_START_FAILED/);
  assert.deepEqual(openSandboxCreateCircuitAllowsClaim(status), { allowed: false, canary: false, episode: null });
});

test("#1046 open circuit admits half-open canary claims after the cooldown without reserving a seat", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  advance(CREATE_CIRCUIT_COOLDOWN_MS - 1);
  assert.equal(openSandboxCreateCircuitAllowsClaim().allowed, false, "cooldown must still hold claims");
  advance(1);
  const admitted = openSandboxCreateCircuitAllowsClaim();
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.canary, true);
  assert.equal(typeof admitted.episode, "number", "the probe carries its episode, not a sampled state");
  // An admitted claim that finds no work must not deadlock the gate.
  const second = openSandboxCreateCircuitAllowsClaim();
  assert.equal(second.allowed, true);
  assert.equal(second.episode, admitted.episode, "every claim in the same half-open window shares one episode");
  assert.equal(openSandboxCreateCircuitStatus().state, "half_open");
});

test("#1046 failed canary reopens; successful provision closes and clears the failure window", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  advance(CREATE_CIRCUIT_COOLDOWN_MS);
  const firstProbe = openSandboxCreateCircuitAllowsClaim();
  assert.equal(firstProbe.canary, true);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED",
    { canary: true, episode: firstProbe.episode });
  const reopened = openSandboxCreateCircuitStatus();
  assert.equal(reopened.state, "open");
  advance(CREATE_CIRCUIT_COOLDOWN_MS);
  const secondProbe = openSandboxCreateCircuitAllowsClaim();
  assert.equal(secondProbe.canary, true);
  assert.notEqual(secondProbe.episode, firstProbe.episode, "each trip opens a new episode");
  recordOpenSandboxProvisionSuccess({ canary: true, episode: secondProbe.episode });
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

test("#1046 a failed half-open canary is counted like any other failure", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  advance(CREATE_CIRCUIT_COOLDOWN_MS);
  const probe = openSandboxCreateCircuitAllowsClaim();
  assert.equal(probe.canary, true);
  const reopened = recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED",
    { canary: true, episode: probe.episode });
  assert.equal(reopened.state, "open");
  assert.equal(reopened.recentFailures, 3,
    "the canary failure is counted too: the two original failures are still inside the 5-minute window");
  assert.equal(reopened.lastTripReason, "DOCKER::SANDBOX_START_FAILED");
});

test("#1046 circuit state and logs keep only a fixed failure code, never dispatcher error text", () => {
  const { clock } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  const secret = "deepsonarjob_live_" + "a".repeat(40);
  const opened = recordOpenSandboxProvisionFailure(
    `Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED) authorization=Bearer ${secret}`,
  );
  assert.equal(opened.state, "closed", "a single failure stays below the trip threshold");
  assert.equal(opened.lastTripReason, null);
  recordOpenSandboxProvisionFailure(
    `Egress sidecar container failed to start. (500; DOCKER::SANDBOX_START_FAILED) authorization=Bearer ${secret}`,
  );
  const tripped = openSandboxCreateCircuitStatus();
  assert.equal(tripped.state, "open");
  assert.equal(tripped.lastTripReason, "DOCKER::SANDBOX_START_FAILED", "only the protocol code survives");
  assert.ok(!JSON.stringify(tripped).includes(secret), "no credential fragment may be retained in state");
  assert.equal(classifyProvisionFailure("socket hang up for up_9f due to provider body"), "unclassified",
    "free text is not promoted into a code");
  assert.equal(classifyProvisionFailure("SANDBOX_START_FAILED"), "SANDBOX_START_FAILED");
  assert.equal(classifyProvisionFailure("docker::sandbox_start_failed"), "unclassified", "codes are upper-case only");
});

test("#1046 claim-pause logging is throttled instead of once per claim call", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  assert.equal(shouldLogCreateCircuitPause(), true);
  assert.equal(shouldLogCreateCircuitPause(), false);
  advance(60 * 1000);
  assert.equal(shouldLogCreateCircuitPause(), true);
});

test("#1046 dispatcher wires the circuit into claims, provision failures and recovery", () => {
  const source = readDispatcher();
  assert.ok(source.includes("OPENSANDBOX_CREATE_CIRCUIT_OPEN"), "claim pause must log the circuit code");
  const gate = source.indexOf("openSandboxCreateCircuitAllowsClaim(createCircuit)");
  const claimScan = source.indexOf("type ClaimCursor");
  assert.ok(gate > 0 && gate < claimScan, "the gate must run before claim scanning");
  assert.ok(source.includes("recordOpenSandboxProvisionFailure("), "provision failures must feed the circuit");
  assert.ok(source.includes("recordOpenSandboxProvisionSuccess(createProbe)"),
    "successful provision must close it only through the claim-time probe");
  assert.ok(source.includes("isRetryableProvisionFailure(error)"), "only retryable service shapes should trip");
  assert.ok(source.includes("shouldLogCreateCircuitPause()"), "the pause log must be throttled at the circuit");
  assert.ok(source.includes("createProbe = createCircuitProbeFor(createAdmission)"),
    "probe identity must be bound at admission time");
  assert.ok(!source.includes('openSandboxCreateCircuitStatus().state === "half_open",'),
    "the outcome must not sample the global circuit state when it is recorded");
});

test("#1046 an outcome from a claim admitted before the trip cannot close or own the new episode", () => {
  const { clock, advance } = clockAt();
  resetOpenSandboxCreateCircuitForTests(clock);
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
  advance(CREATE_CIRCUIT_COOLDOWN_MS);
  const probe = openSandboxCreateCircuitAllowsClaim();
  assert.equal(probe.canary, true);
  // A provision that was claimed while the circuit was closed carries no probe.
  recordOpenSandboxProvisionSuccess(null);
  assert.equal(openSandboxCreateCircuitStatus().state, "half_open",
    "an earlier ordinary provision cannot prove the probe recovered the backend");
  // An outcome from a previous episode is equally unable to close the current one.
  recordOpenSandboxProvisionSuccess({ canary: true, episode: (probe.episode ?? 0) - 1 });
  assert.equal(openSandboxCreateCircuitStatus().state, "half_open");
  recordOpenSandboxProvisionSuccess({ canary: true, episode: probe.episode });
  assert.equal(openSandboxCreateCircuitStatus().state, "closed",
    "only the probe of the current episode closes the circuit");
});

function readDispatcher(): string {
  return readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
}
