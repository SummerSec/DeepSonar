/**
 * OpenSandbox create-path instability circuit (#1046).
 *
 * The existing server gate only inspects `GET /v1/sandboxes` (list/heartbeat), and
 * the upload circuit only covers the worker-upload path. A service window where the
 * list API answers 200 while `POST /v1/sandboxes` (and egress sidecar creation)
 * returns 500 therefore stayed invisible: claims kept arriving, and the single
 * automatic provision retry replayed the same 500.
 *
 * This process-local circuit observes the failures the dispatcher itself sees on the
 * provision path. Trip -> new opensandbox claims pause (retry attempts land back in
 * `pending` through the existing retry lifecycle and simply are not claimed). After a
 * cooldown exactly one half-open canary claim is admitted; a successful provision
 * closes the circuit, a failed canary reopens it. No new server endpoint, config knob
 * or persisted state is introduced; counts live only in this process.
 */
import { inc, setGauge } from "./metrics.js";

export const OPENSANDBOX_CREATE_CIRCUIT_OPEN = "opensandbox_create_circuit_open";

/** Dispatcher-observed provision failures inside the window required to trip. */
export const CREATE_CIRCUIT_FAILURES_TO_TRIP = 2;
/** Sliding window for the failure count (ms). */
export const CREATE_CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
/** Minimum time to stay open before admitting one half-open canary (ms). */
export const CREATE_CIRCUIT_COOLDOWN_MS = 90 * 1000;

export type OpenSandboxCreateCircuitState = "closed" | "open" | "half_open";

export type OpenSandboxCreateCircuitStatus = {
  state: OpenSandboxCreateCircuitState;
  openedAt: string | null;
  lastTripReason: string | null;
  recentFailures: number;
};

let state: OpenSandboxCreateCircuitState = "closed";
let openedAtMs: number | null = null;
let lastTripReason: string | null = null;
let failureTimes: number[] = [];
let clock: () => number = () => Date.now();

function prune(now: number): void {
  failureTimes = failureTimes.filter((at) => now - at <= CREATE_CIRCUIT_WINDOW_MS);
}

export function openSandboxCreateCircuitStatus(): OpenSandboxCreateCircuitStatus {
  const now = clock();
  prune(now);
  return {
    state,
    openedAt: openedAtMs != null ? new Date(openedAtMs).toISOString() : null,
    lastTripReason,
    recentFailures: failureTimes.length,
  };
}

/**
 * Admit a claim on the opensandbox create path. `canary` tells the dispatcher this is
 * the single half-open probe whose success closes the circuit.
 */
export function openSandboxCreateCircuitAllowsClaim(
  status: OpenSandboxCreateCircuitStatus = openSandboxCreateCircuitStatus(),
): { allowed: boolean; canary: boolean } {
  if (status.state === "closed") return { allowed: true, canary: false };
  // Half-open admits claims as canaries until a provision outcome arrives. No seat is
  // reserved here: an admitted claim that finds no pending Job must not deadlock the
  // gate, and the existing provisioning concurrency cap bounds concurrent canaries.
  if (status.state === "half_open") return { allowed: true, canary: true };
  const openedAt = openedAtMs;
  if (openedAt != null && clock() - openedAt >= CREATE_CIRCUIT_COOLDOWN_MS) {
    state = "half_open";
    setGauge("deepsonar_opensandbox_create_circuit", 1);
    return { allowed: true, canary: true };
  }
  return { allowed: false, canary: false };
}

/** Record a dispatcher-observed provision failure; trip once the window threshold is reached. */
export function recordOpenSandboxProvisionFailure(reason: string, canary = false): OpenSandboxCreateCircuitStatus {
  const now = clock();
  if (canary) {
    // A failed half-open canary proves the backend is still unstable: reopen immediately.
    reTrip(now, reason);
    return openSandboxCreateCircuitStatus();
  }
  failureTimes.push(now);
  prune(now);
  inc("deepsonar_opensandbox_create_failures_total");
  if (state === "closed" && failureTimes.length >= CREATE_CIRCUIT_FAILURES_TO_TRIP) {
    reTrip(now, reason);
  } else if (state === "half_open") {
    reTrip(now, reason);
  }
  return openSandboxCreateCircuitStatus();
}

/** A successful provision closes the circuit (including a successful half-open canary). */
export function recordOpenSandboxProvisionSuccess(): void {
  if (state !== "closed") {
    console.error(`[opensandbox-create-circuit] closed after successful provision (state=${state})`);
    inc("deepsonar_opensandbox_create_circuit_close_total");
  }
  state = "closed";
  openedAtMs = null;
  lastTripReason = null;
  failureTimes = [];
  setGauge("deepsonar_opensandbox_create_circuit", 0);
}

function reTrip(now: number, reason: string): void {
  state = "open";
  openedAtMs = now;
  lastTripReason = reason.slice(0, 300);
  setGauge("deepsonar_opensandbox_create_circuit", 1);
  inc("deepsonar_opensandbox_create_circuit_open_total");
  console.error(`[opensandbox-create-circuit] ${OPENSANDBOX_CREATE_CIRCUIT_OPEN} reason=${lastTripReason}`);
}

/** Test-only: reset all state and optionally pin the clock. */
export function resetOpenSandboxCreateCircuitForTests(clockOverride?: () => number): void {
  state = "closed";
  openedAtMs = null;
  lastTripReason = null;
  failureTimes = [];
  clock = clockOverride ?? (() => Date.now());
}