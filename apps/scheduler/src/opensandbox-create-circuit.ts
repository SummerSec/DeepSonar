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
 * cooldown the dispatcher admits one half-open creation seat under its DB claim
 * lock, including when ordinary quotas are unlimited. It rechecks the episode before
 * outbound creation and defers expired admissions through the no-start lifecycle.
 * A successful canary in the current episode closes the circuit; a failed canary
 * reopens it. Counts and episodes live in this process.
 *
 * State and logs carry only a fixed failure code (`classifyProvisionFailure`), never the
 * dispatcher error text: that text can contain provider bodies, headers or a credential.
 */
import { inc, setGauge } from "./metrics.js";
import { config } from "./config.js";
import type { ProvisionFailureDiagnostic } from "@deepsonar/runtime-sandbox";

export const OPENSANDBOX_CREATE_CIRCUIT_OPEN = "opensandbox_create_circuit_open";

/** Dispatcher-observed provision failures inside the window required to trip. */
export const CREATE_CIRCUIT_FAILURES_TO_TRIP = config.runtime.openSandbox.createCircuit.failuresToTrip;
/** Sliding window for the failure count (ms). */
export const CREATE_CIRCUIT_WINDOW_MS = config.runtime.openSandbox.createCircuit.windowMs;
/** Minimum time to stay open before admitting a half-open creation probe (ms). */
export const CREATE_CIRCUIT_COOLDOWN_MS = config.runtime.openSandbox.createCircuit.cooldownMs;
export const CREATE_CIRCUIT_MAX_COOLDOWN_MS = config.runtime.openSandbox.createCircuit.maxCooldownMs;

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

/** A process observing half-open counts all DB claimed/provisioning work. */
export function createCircuitClaimSlots(probe: CreateCircuitProbe | null, activeProvisioning: number): number {
  return probe?.canary ? Math.max(0, 1 - activeProvisioning) : Number.POSITIVE_INFINITY;
}

export class OpenSandboxCreateAdmissionExpiredError extends Error {
  readonly code = OPENSANDBOX_CREATE_CIRCUIT_OPEN;
  constructor() { super(`${OPENSANDBOX_CREATE_CIRCUIT_OPEN}: create admission expired before outbound`); }
}

/** Synchronous fence immediately before invoking the external create path. */
export function assertOpenSandboxCreateAdmission(probe: CreateCircuitProbe | null): void {
  if (state === "closed") return;
  if (state === "half_open" && probe?.canary && probe.episode === episode) return;
  throw new OpenSandboxCreateAdmissionExpiredError();
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
let cooldownMs = CREATE_CIRCUIT_COOLDOWN_MS;
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
 * a half-open probe whose success in the current episode closes the circuit.
 */
export function openSandboxCreateCircuitAllowsClaim(
  status: OpenSandboxCreateCircuitStatus = openSandboxCreateCircuitStatus(),
): { allowed: boolean; canary: boolean; episode: number | null } {
  if (status.state === "closed") return { allowed: true, canary: false, episode: null };
  // No seat is reserved before finding work. The dispatcher enforces a separate
  // single creation seat under its DB advisory lock, including unlimited quotas.
  if (status.state === "half_open") return { allowed: true, canary: true, episode };
  const openedAt = openedAtMs;
  if (openedAt != null && clock() - openedAt >= cooldownMs) {
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
  if (state === "half_open" && probe?.canary === true && probe.episode != null && probe.episode === episode) {
    cooldownMs = Math.min(CREATE_CIRCUIT_MAX_COOLDOWN_MS, cooldownMs * 2);
    reTrip(now, code);
  } else if (failureTimes.length >= CREATE_CIRCUIT_FAILURES_TO_TRIP) {
    reTrip(now, code);
  }
  return openSandboxCreateCircuitStatus();
}

/** A transient error is only a retry candidate. Effect/owner checks still decide replay. */
export function isOpenSandboxTransientProvisionFailure(text: string): boolean {
  return /CONTAINER_START_FAILED|SANDBOX_START_FAILED|Egress sidecar (?:container failed to start|did not become ready)|bind:\s*(?:.*\b(?:socket|port)|An attempt was made to access a socket)|Sandbox health check timed out|Server disconnected without sending a response|Upload failed\s*\(\s*status\s*=\s*5\d\d\s*\)|UNEXPECTED_RESPONSE|An internal error occurred in the proxy|websocket proxy failure/i.test(text);
}

/** Observe service health independently of whether the failed effect can be replayed. */
export function recordOpenSandboxProvisionError(reason: string, diagnostic?: ProvisionFailureDiagnostic,
  probe: CreateCircuitProbe | null = null): void {
  if (diagnostic?.cancelled) return;
  if (CREATE_DIRECTORY_5XX.test(reason)) {
    recordOpenSandboxProvisionFailure("SANDBOX_CREATE_DIRECTORY_FAILED", probe);
  } else if (diagnostic?.stage === "create" && diagnostic.http_status != null
    && diagnostic.http_status >= 500 && diagnostic.http_status <= 599) {
    recordOpenSandboxProvisionFailure("SANDBOX_CREATE_SERVER_ERROR", probe);
  } else if (isOpenSandboxTransientProvisionFailure(reason)) {
    recordOpenSandboxProvisionFailure(reason, probe);
  }
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
  cooldownMs = CREATE_CIRCUIT_COOLDOWN_MS;
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

// Known create-path failure codes only (#1046 review), including the #1119 fixed
// directory/server projections (bare or protocol-qualified). Any other value —
// including arbitrary upper-case/underscore shapes, private labels or long tails —
// falls back to "unclassified" so the circuit never promotes error content into
// state or logs.
const KNOWN_PROVISION_FAILURE_CODES = Object.freeze([
  "SANDBOX_START_FAILED",
  "CONTAINER_START_FAILED",
  "UNEXPECTED_RESPONSE",
  "SANDBOX_CREATE_DIRECTORY_FAILED",
  "SANDBOX_CREATE_SERVER_ERROR",
] as const satisfies readonly string[]);
const CREATE_DIRECTORY_5XX = /Failed to create directory \/opt\/opensandbox(?:\/[^\s:]*)? in sandbox:\s*5\d\d\b/iu;
const PROTOCOL_FAILURE_CODE_RE = /\b(OPENSANDBOX|OPEN_SANDBOX|SANDBOX|DOCKER)::([A-Z][A-Z0-9_]{1,63})\b/u;
const BARE_FAILURE_CODE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,4}\b/gu;
const isKnownProvisionCode = (code: unknown): code is (typeof KNOWN_PROVISION_FAILURE_CODES)[number] =>
  (KNOWN_PROVISION_FAILURE_CODES as readonly string[]).includes(String(code));
/** One pause log per minute per process: a denial path must not log once per claim call. */
const CREATE_CIRCUIT_PAUSE_LOG_INTERVAL_MS = 60 * 1000;
let lastPauseLogAtMs: number | null = null;

/**
 * Fixed projection of a dispatcher provision error (#1046).
 *
 * Only an allowlisted code survives. Free text — which can carry provider bodies,
 * headers or a leaked credential — is never truncated into state or logs, because
 * truncation is not a secret-safe boundary.
 */
export function classifyProvisionFailure(reason: string): string {
  if (CREATE_DIRECTORY_5XX.test(reason)) return "SANDBOX_CREATE_DIRECTORY_FAILED";
  // Allowlist only: protocol-qualified candidates win when their code itself is known
  // (a private value after the namespace must not promote); otherwise the first known
  // bare code anywhere in the text. Any other content falls back to "unclassified".
  const protocol = PROTOCOL_FAILURE_CODE_RE.exec(reason);
  if (protocol && isKnownProvisionCode(protocol[2])) return protocol[0];
  for (const bare of reason.matchAll(BARE_FAILURE_CODE_RE)) {
    if (isKnownProvisionCode(bare[0])) return bare[0];
  }
  return "unclassified";
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
  cooldownMs = CREATE_CIRCUIT_COOLDOWN_MS;
  lastPauseLogAtMs = null;
  clock = clockOverride ?? (() => Date.now());
}
