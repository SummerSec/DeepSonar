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
 *
 * State and logs carry only a fixed failure code (`classifyProvisionFailure`), never the
 * dispatcher error text: that text can contain provider bodies, headers or a credential.
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

/**
 * Claim-time probe identity. The circuit does not sample its own state when an
 * outcome arrives: the claim that admitted the Job carries the canary flag and the
 * open->half-open episode it was admitted in, so a provision that started earlier
 * can neither be counted as the probe nor close a circuit opened after it started.
 */
export type CreateCircuitProbe = { canary: boolean; episode: number | null };

/** Bind an admission result to the probe identity it must be attributed with. */
export function createCircuitProbeFor(admission: { canary: boolean; episode: number | null }): CreateCircuitProbe | null {
  return admission.canary ? { canary: true, episode: admission.episode } : null;
}

export type OpenSandboxCreateCircuitStatus = {
  state: OpenSandboxCreateCircuitState;
  episode: number;
  openedAt: string | null;
  lastTripReason: string | null;
  recentFailures: number;
};

let state: OpenSandboxCreateCircuitState = "closed";
/** Bumped on every trip; half-open admissions and their outcomes share one episode. */
let episode = 0;
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
    episode,
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
): { allowed: boolean; canary: boolean; episode: number | null } {
  if (status.state === "closed") return { allowed: true, canary: false, episode: null };
  // Half-open admits claims as canaries until a provision outcome arrives. No seat is
  // reserved here: an admitted claim that finds no pending Job must not deadlock the
  // gate, and the existing provisioning concurrency cap bounds concurrent canaries.
  if (status.state === "half_open") return { allowed: true, canary: true, episode };
  const openedAt = openedAtMs;
  if (openedAt != null && clock() - openedAt >= CREATE_CIRCUIT_COOLDOWN_MS) {
    state = "half_open";
    setGauge("deepsonar_opensandbox_create_circuit", 1);
    return { allowed: true, canary: true, episode };
  }
  return { allowed: false, canary: false, episode: null };
}

/** Record a dispatcher-observed provision failure; trip once the window threshold is reached. */
export function recordOpenSandboxProvisionFailure(
  reason: string,
  probe: CreateCircuitProbe | null = null,
): OpenSandboxCreateCircuitStatus {
  const now = clock();
  const code = classifyProvisionFailure(reason);
  // #1046: every observed failure counts, including a failed half-open canary. Accounting
  // must not depend on which branch the trip decision takes.
  failureTimes.push(now);
  prune(now);
  inc("deepsonar_opensandbox_create_failures_total");
  // Only the probe admitted in the current episode can prove the backend is still
  // unstable on its own; an outcome from an earlier claim is ordinary window evidence.
  if (probe?.canary === true && probe.episode != null && probe.episode === episode) {
    reTrip(now, code);
  } else if (failureTimes.length >= CREATE_CIRCUIT_FAILURES_TO_TRIP) {
    reTrip(now, code);
  }
  return openSandboxCreateCircuitStatus();
}

/** A successful provision closes the circuit (including a successful half-open canary). */
export function recordOpenSandboxProvisionSuccess(probe: CreateCircuitProbe | null = null): void {
  if (state !== "closed" && (probe?.episode == null || probe.episode !== episode)) {
    // Not the probe of the current episode: this provision began before the circuit
    // opened (or belongs to an older episode), so it cannot prove recovery.
    inc("deepsonar_opensandbox_create_circuit_close_ignored_total");
    return;
  }
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

function reTrip(now: number, code: string): void {
  state = "open";
  episode += 1;
  openedAtMs = now;
  lastTripReason = code;
  setGauge("deepsonar_opensandbox_create_circuit", 1);
  inc("deepsonar_opensandbox_create_circuit_open_total");
  console.error(`[opensandbox-create-circuit] ${OPENSANDBOX_CREATE_CIRCUIT_OPEN} reason=${code}`);
}

// Protocol-qualified code first (the shape real dispatcher errors carry), then a bare
// upper-case identifier with underscores; free text, base64/mixed-case secrets and
// provider prose never match either alternative.
const PROVISION_FAILURE_CODE_RE = /\b(?:OPENSANDBOX|OPEN_SANDBOX|SANDBOX|DOCKER)::[A-Z][A-Z0-9_]{1,63}\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,4}\b/u;
/** One pause log per minute per process: a denial path must not log once per claim call. */
const CREATE_CIRCUIT_PAUSE_LOG_INTERVAL_MS = 60 * 1000;
let lastPauseLogAtMs: number | null = null;

/**
 * Fixed projection of a dispatcher provision error (#1046).
 *
 * Only a protocol-style code survives. Free text — which can carry provider bodies,
 * headers or a leaked credential — is never truncated into state or logs, because
 * truncation is not a secret-safe boundary.
 */
export function classifyProvisionFailure(reason: string): string {
  const match = PROVISION_FAILURE_CODE_RE.exec(reason);
  return match ? match[0] : "unclassified";
}

export function shouldLogCreateCircuitPause(): boolean {
  const now = clock();
  if (lastPauseLogAtMs != null && now - lastPauseLogAtMs < CREATE_CIRCUIT_PAUSE_LOG_INTERVAL_MS) return false;
  lastPauseLogAtMs = now;
  return true;
}

/** Test-only: reset all state and optionally pin the clock. */
export function resetOpenSandboxCreateCircuitForTests(clockOverride?: () => number): void {
  state = "closed";
  episode = 0;
  openedAtMs = null;
  lastTripReason = null;
  failureTimes = [];
  lastPauseLogAtMs = null;
  clock = clockOverride ?? (() => Date.now());
}