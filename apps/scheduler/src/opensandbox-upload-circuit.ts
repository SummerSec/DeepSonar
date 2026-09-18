/**
 * OpenSandbox worker-upload persistent-failure circuit (#605).
 *
 * Per-call isTransientOpenSandboxUploadError + writeFilesWithRetry (3x) only
 * covers transient hostfwd/proxy churn. When canvas/project-scoped waves keep
 * dying on that same classifier, trip a process-local circuit, pause new
 * opensandbox claims, emit an ops alert, and optionally `docker restart` the
 * OpenSandbox server when DEEPSONAR_OPENSANDBOX_AUTO_RESTART=true.
 */
import { isTransientOpenSandboxUploadError } from "@deepsonar/runtime-sandbox";
import { config } from "./config.js";
import { inc, setGauge } from "./metrics.js";

export const OPENSANDBOX_UPLOAD_CIRCUIT_OPEN = "opensandbox_upload_circuit_open";

/** Consecutive all-upload-failure waves required to trip. */
export const UPLOAD_CIRCUIT_WAVES_TO_TRIP = 2;
/** Absolute upload-classified job failures inside the sliding window to trip. */
export const UPLOAD_CIRCUIT_JOBS_TO_TRIP = 6;
/** Sliding window for absolute job-count trip (ms). */
export const UPLOAD_CIRCUIT_WINDOW_MS = 30 * 60 * 1000;
/** Idle gap that closes the current wave (ms). */
export const UPLOAD_CIRCUIT_WAVE_GAP_MS = 3 * 60 * 1000;
/** After trip, remain open at least this long before half-open (ms). */
export const UPLOAD_CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000;
/** Run a pre-dispatch upload probe after this many recent upload failures. */
export const UPLOAD_CIRCUIT_PROBE_AFTER_FAILURES = 3;
/** Treat circuit as "recently open" for probe purposes (ms). */
export const UPLOAD_CIRCUIT_RECENT_OPEN_MS = 15 * 60 * 1000;

export type OpenSandboxUploadCircuitState = "closed" | "open" | "half_open";

export type OpenSandboxUploadCircuitStatus = {
  state: OpenSandboxUploadCircuitState;
  openedAt: string | null;
  lastTripReason: string | null;
  consecutiveUploadWaves: number;
  recentUploadFailures: number;
  healAttemptedAt: string | null;
  healResult: string | null;
};

type Wave = {
  uploadFailures: number;
  otherFailures: number;
  lastAtMs: number;
};

type ScopeState = {
  consecutiveUploadWaves: number;
  currentWave: Wave | null;
  recentUploadAt: number[];
};

type Clock = () => number;
type DockerRestart = (containerName: string) => Promise<void>;
type UploadProbe = () => Promise<void | { skipped: true }>;
type AlertSink = (line: string, detail: Record<string, unknown>) => void;

let clock: Clock = () => Date.now();
let dockerRestart: DockerRestart | null = null;
let uploadProbe: UploadProbe | null = null;
let alertSink: AlertSink | null = null;
let autoRestartOverride: boolean | null = null;

let globalState: OpenSandboxUploadCircuitState = "closed";
let openedAtMs: number | null = null;
let lastTripReason: string | null = null;
let healAttemptedAtMs: number | null = null;
let healResult: string | null = null;
let lastAlertAtMs: number | null = null;
const scopes = new Map<string, ScopeState>();

function autoRestartEnabled(): boolean {
  if (autoRestartOverride != null) return autoRestartOverride;
  return Boolean(config.runtime.openSandbox.autoRestart);
}

function containerName(): string {
  const fromConfig = config.runtime.openSandbox.containerName?.trim() ?? "";
  if (fromConfig) return fromConfig;
  const fromEnv = (process.env.OPEN_SANDBOX_CONTAINER_NAME ?? "").trim();
  return fromEnv || "deepsonar-opensandbox";
}

function scopeKey(projectId: string | null | undefined, canvasId: string | null | undefined): string {
  return `${projectId?.trim() || "_"}:${canvasId?.trim() || "_"}`;
}

function scopeOf(key: string): ScopeState {
  let state = scopes.get(key);
  if (!state) {
    state = { consecutiveUploadWaves: 0, currentWave: null, recentUploadAt: [] };
    scopes.set(key, state);
  }
  return state;
}

function pruneRecent(state: ScopeState, now: number): void {
  state.recentUploadAt = state.recentUploadAt.filter((ts) => now - ts <= UPLOAD_CIRCUIT_WINDOW_MS);
}

function publishGauge(): void {
  // 0=closed, 1=half_open, 2=open
  setGauge(
    "deepsonar_opensandbox_upload_circuit_open",
    globalState === "open" ? 2 : globalState === "half_open" ? 1 : 0,
  );
}

function emitAlert(detail: Record<string, unknown>): void {
  const now = clock();
  if (lastAlertAtMs != null && now - lastAlertAtMs < UPLOAD_CIRCUIT_COOLDOWN_MS) return;
  lastAlertAtMs = now;
  const line = `ALERT opensandbox_upload_persistent ${JSON.stringify(detail)}`;
  console.error(line);
  // Structured ops event (dashboard/ops has no outbound webhook yet — audit_logs + JSON log).
  console.error(JSON.stringify({
    level: "alert",
    code: "opensandbox_upload_persistent",
    ops_event: "opensandbox.upload_circuit",
    ...detail,
  }));
  if (alertSink) alertSink(line, detail);
  void writeOpsAudit(detail).catch((error) => {
    console.error("[opensandbox-upload-circuit] audit write failed:", error instanceof Error ? error.message : error);
  });
  inc("deepsonar_opensandbox_upload_alerts_total");
}

async function writeOpsAudit(detail: Record<string, unknown>): Promise<void> {
  const { sql } = await import("./db.js");
  await sql`
    INSERT INTO audit_logs (
      actor_type, actor_id, action, resource_type, resource_id, after_json, result, error_code
    ) VALUES (
      'internal',
      'opensandbox-upload-circuit',
      'opensandbox.upload_circuit.alert',
      'opensandbox',
      ${String(detail.scope ?? detail.reason ?? "global")},
      ${sql.json(detail as never)},
      'error',
      ${OPENSANDBOX_UPLOAD_CIRCUIT_OPEN}
    )`;
}

function finalizeWave(state: ScopeState): void {
  const wave = state.currentWave;
  state.currentWave = null;
  if (!wave) return;
  if (wave.uploadFailures > 0 && wave.otherFailures === 0) {
    state.consecutiveUploadWaves += 1;
  } else if (wave.otherFailures > 0) {
    state.consecutiveUploadWaves = 0;
  }
}

async function defaultDockerRestart(name: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  await execFileP("docker", ["restart", name], {
    timeout: 60_000,
    windowsHide: true,
  });
}

export function openSandboxUploadCircuitStatus(): OpenSandboxUploadCircuitStatus {
  const now = clock();
  let consecutive = 0;
  let recent = 0;
  for (const state of scopes.values()) {
    consecutive = Math.max(consecutive, state.consecutiveUploadWaves);
    pruneRecent(state, now);
    recent = Math.max(recent, state.recentUploadAt.length);
  }
  return {
    state: globalState,
    openedAt: openedAtMs != null ? new Date(openedAtMs).toISOString() : null,
    lastTripReason,
    consecutiveUploadWaves: consecutive,
    recentUploadFailures: recent,
    healAttemptedAt: healAttemptedAtMs != null ? new Date(healAttemptedAtMs).toISOString() : null,
    healResult,
  };
}

export function openSandboxUploadCircuitAllowsDispatch(
  status: OpenSandboxUploadCircuitStatus = openSandboxUploadCircuitStatus(),
): boolean {
  return status.state === "closed" || status.state === "half_open";
}

export function isOpenSandboxUploadCircuitFailure(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    if (String((error as { code?: unknown }).code) === OPENSANDBOX_UPLOAD_CIRCUIT_OPEN) return true;
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.includes(OPENSANDBOX_UPLOAD_CIRCUIT_OPEN);
}

export function createOpenSandboxUploadCircuitError(
  status: OpenSandboxUploadCircuitStatus = openSandboxUploadCircuitStatus(),
): Error {
  const err = new Error(
    `${OPENSANDBOX_UPLOAD_CIRCUIT_OPEN}: OpenSandbox upload path circuit is open`
    + (status.lastTripReason ? ` (${status.lastTripReason})` : "")
    + "; new worker dispatch paused until recovery",
  );
  (err as Error & { code: string }).code = OPENSANDBOX_UPLOAD_CIRCUIT_OPEN;
  return err;
}

export function classifyOpenSandboxUploadFailure(error: unknown): boolean {
  if (isOpenSandboxUploadCircuitFailure(error)) return false;
  return isTransientOpenSandboxUploadError(error);
}

async function attemptSelfHeal(reason: string): Promise<void> {
  healAttemptedAtMs = clock();
  if (!autoRestartEnabled()) {
    healResult = "skipped_auto_restart_disabled";
    console.error(
      `[opensandbox-upload-circuit] self-heal skipped (set DEEPSONAR_OPENSANDBOX_AUTO_RESTART=true to docker restart); reason=${reason}`,
    );
    inc("deepsonar_opensandbox_upload_self_heal_total", { result: "skipped" });
    return;
  }
  const name = containerName();
  const restart = dockerRestart ?? defaultDockerRestart;
  try {
    await restart(name);
    healResult = `restarted:${name}`;
    console.warn(`[opensandbox-upload-circuit] self-heal restarted container ${name}`);
    inc("deepsonar_opensandbox_upload_self_heal_total", { result: "restarted" });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    healResult = `restart_failed:${message}`;
    console.error(`[opensandbox-upload-circuit] self-heal restart failed for ${name}: ${message}`);
    inc("deepsonar_opensandbox_upload_self_heal_total", { result: "failed" });
  }
}

export async function tripOpenSandboxUploadCircuit(
  reason: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const now = clock();
  const alreadyOpen = globalState === "open";
  globalState = "open";
  openedAtMs = openedAtMs ?? now;
  lastTripReason = reason;
  publishGauge();
  if (!alreadyOpen) {
    inc("deepsonar_opensandbox_upload_circuit_trips_total");
    console.error(JSON.stringify({
      level: "error",
      code: OPENSANDBOX_UPLOAD_CIRCUIT_OPEN,
      reason,
      ...detail,
    }));
  }
  emitAlert({ reason, state: globalState, ...detail });
  if (!alreadyOpen || healAttemptedAtMs == null) {
    await attemptSelfHeal(reason);
  }
}

export function markOpenSandboxUploadCircuitHalfOpen(): void {
  if (globalState !== "open") return;
  const now = clock();
  if (openedAtMs != null && now - openedAtMs < UPLOAD_CIRCUIT_COOLDOWN_MS) return;
  globalState = "half_open";
  publishGauge();
  console.warn("[opensandbox-upload-circuit] entering half_open after cooldown");
}

export function closeOpenSandboxUploadCircuit(reason = "recovered"): void {
  globalState = "closed";
  openedAtMs = null;
  lastTripReason = null;
  healAttemptedAtMs = null;
  healResult = null;
  for (const state of scopes.values()) {
    state.consecutiveUploadWaves = 0;
    state.currentWave = null;
    state.recentUploadAt = [];
  }
  publishGauge();
  console.warn(`[opensandbox-upload-circuit] closed (${reason})`);
}

export async function recordOpenSandboxJobOutcome(input: {
  projectId?: string | null;
  canvasId?: string | null;
  ok: boolean;
  error?: unknown;
}): Promise<OpenSandboxUploadCircuitStatus> {
  const key = scopeKey(input.projectId, input.canvasId);
  const state = scopeOf(key);
  const now = clock();

  if (input.ok) {
    state.consecutiveUploadWaves = 0;
    state.currentWave = null;
    state.recentUploadAt = [];
    if (globalState === "half_open" || globalState === "open") {
      closeOpenSandboxUploadCircuit("job_success");
    }
    return openSandboxUploadCircuitStatus();
  }

  const upload = classifyOpenSandboxUploadFailure(input.error);
  if (upload) {
    inc("deepsonar_opensandbox_upload_failures_total");
  }

  if (state.currentWave && now - state.currentWave.lastAtMs > UPLOAD_CIRCUIT_WAVE_GAP_MS) {
    finalizeWave(state);
  }
  if (!state.currentWave) {
    state.currentWave = { uploadFailures: 0, otherFailures: 0, lastAtMs: now };
  }
  if (upload) {
    state.currentWave.uploadFailures += 1;
    state.recentUploadAt.push(now);
  } else {
    state.currentWave.otherFailures += 1;
  }
  state.currentWave.lastAtMs = now;
  pruneRecent(state, now);

  if (state.recentUploadAt.length >= UPLOAD_CIRCUIT_JOBS_TO_TRIP) {
    await tripOpenSandboxUploadCircuit("upload_failures_in_window", {
      scope: key,
      recentUploadFailures: state.recentUploadAt.length,
    });
    return openSandboxUploadCircuitStatus();
  }

  if (state.consecutiveUploadWaves >= UPLOAD_CIRCUIT_WAVES_TO_TRIP) {
    await tripOpenSandboxUploadCircuit("consecutive_upload_waves", {
      scope: key,
      consecutiveUploadWaves: state.consecutiveUploadWaves,
    });
  }

  return openSandboxUploadCircuitStatus();
}

/** Force-close the current wave for a scope (idle gap / end-of-batch). */
export async function sealOpenSandboxUploadWave(input: {
  projectId?: string | null;
  canvasId?: string | null;
}): Promise<OpenSandboxUploadCircuitStatus> {
  const key = scopeKey(input.projectId, input.canvasId);
  const state = scopeOf(key);
  finalizeWave(state);
  if (state.consecutiveUploadWaves >= UPLOAD_CIRCUIT_WAVES_TO_TRIP) {
    await tripOpenSandboxUploadCircuit("consecutive_upload_waves", {
      scope: key,
      consecutiveUploadWaves: state.consecutiveUploadWaves,
    });
  }
  return openSandboxUploadCircuitStatus();
}

export function shouldProbeOpenSandboxUpload(
  status: OpenSandboxUploadCircuitStatus = openSandboxUploadCircuitStatus(),
): boolean {
  if (status.state === "half_open") return true;
  if (status.state === "open") return true;
  if (status.recentUploadFailures >= UPLOAD_CIRCUIT_PROBE_AFTER_FAILURES) return true;
  if (openedAtMs != null && clock() - openedAtMs <= UPLOAD_CIRCUIT_RECENT_OPEN_MS) return true;
  return false;
}

export async function probeOpenSandboxUploadBeforeDispatch(): Promise<{ ok: boolean; error?: string }> {
  markOpenSandboxUploadCircuitHalfOpen();
  if (!shouldProbeOpenSandboxUpload()) return { ok: true };

  const probe = uploadProbe
    ?? (await import("./opensandbox-upload-probe.js")).defaultOpenSandboxUploadProbe;

  try {
    const result = await probe();
    if (result && typeof result === "object" && "skipped" in result && result.skipped) {
      if (globalState === "open") {
        return { ok: false, error: "upload_probe_unavailable" };
      }
      return { ok: true };
    }
    if (globalState !== "closed") closeOpenSandboxUploadCircuit("probe_ok");
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    inc("deepsonar_opensandbox_upload_probe_failures_total");
    await tripOpenSandboxUploadCircuit("upload_probe_failed", { error: message });
    return { ok: false, error: message };
  }
}

export function resetOpenSandboxUploadCircuitForTests(): void {
  globalState = "closed";
  openedAtMs = null;
  lastTripReason = null;
  healAttemptedAtMs = null;
  healResult = null;
  lastAlertAtMs = null;
  scopes.clear();
  clock = () => Date.now();
  dockerRestart = null;
  uploadProbe = null;
  alertSink = null;
  autoRestartOverride = null;
  publishGauge();
}

export function setOpenSandboxUploadCircuitTestHooks(hooks: {
  now?: Clock;
  dockerRestart?: DockerRestart | null;
  uploadProbe?: UploadProbe | null;
  alertSink?: AlertSink | null;
  autoRestart?: boolean | null;
}): void {
  if (hooks.now) clock = hooks.now;
  if ("dockerRestart" in hooks) dockerRestart = hooks.dockerRestart ?? null;
  if ("uploadProbe" in hooks) uploadProbe = hooks.uploadProbe ?? null;
  if ("alertSink" in hooks) alertSink = hooks.alertSink ?? null;
  if ("autoRestart" in hooks) autoRestartOverride = hooks.autoRestart ?? null;
}
