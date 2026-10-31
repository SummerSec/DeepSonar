/**
 * Adaptive runtime-image pull timeout, failure classification, and pull-speed history (#724).
 *
 * Timeout resolution order:
 * 1. Explicit `DEEPSONAR_RUNTIME_IMAGE_PULL_TIMEOUT_SEC` when set and in range → use as-is.
 * 2. Else estimate from size_bytes / effective speed (historical EWMA, else conservative default),
 *    floored at AUTO_MIN_SEC and capped at AUTO_MAX_SEC.
 * 3. Missing size_bytes → AUTO_MIN_SEC (conservative default).
 */

export const RUNTIME_IMAGE_PULL_TIMEOUT_ENV = "DEEPSONAR_RUNTIME_IMAGE_PULL_TIMEOUT_SEC";

/** Automatic estimate never goes below this (seconds). */
export const RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC = 300;
/** Automatic estimate hard upper bound (seconds). */
export const RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MAX_SEC = 3_600;
/** Explicit env override legal range (seconds), inclusive. */
export const RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MIN_SEC = 60;
export const RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MAX_SEC = 7_200;
/** Conservative default download speed when no history exists (~2 MiB/s). */
export const RUNTIME_IMAGE_PULL_DEFAULT_SPEED_BPS = 2 * 1024 * 1024;

export type RuntimeImagePullFailureClass =
  | "timeout"
  | "transport"
  | "auth"
  | "digest_missing"
  | "disk_full"
  | "other";

export type RuntimeImagePullTimeoutSource = "env" | "estimate" | "default_min";

export interface RuntimeImagePullTimeoutResolution {
  timeout_sec: number;
  source: RuntimeImagePullTimeoutSource;
  size_bytes: number | null;
  speed_bps: number | null;
  env_raw: string | null;
  env_rejected: boolean;
}

let speedEwmaBps: number | null = null;
const SPEED_EWMA_ALPHA = 0.35;

export function resetRuntimeImagePullSpeedHistory(): void {
  speedEwmaBps = null;
}

export function recordRuntimeImagePullSpeed(sizeBytes: number, durationMs: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return;
  if (!Number.isFinite(durationMs) || durationMs < 50) return;
  const sample = (sizeBytes * 1000) / durationMs;
  if (!Number.isFinite(sample) || sample <= 0) return;
  speedEwmaBps = speedEwmaBps === null
    ? sample
    : SPEED_EWMA_ALPHA * sample + (1 - SPEED_EWMA_ALPHA) * speedEwmaBps;
}

export function historicalRuntimeImagePullSpeedBps(): number | null {
  return speedEwmaBps;
}

function parseEnvTimeoutSec(raw: string | undefined): { value: number | null; rejected: boolean; raw: string | null } {
  if (raw === undefined || raw.trim() === "") return { value: null, rejected: false, raw: null };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { value: null, rejected: true, raw: trimmed };
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MIN_SEC || n > RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MAX_SEC) {
    return { value: null, rejected: true, raw: trimmed };
  }
  return { value: n, rejected: false, raw: trimmed };
}

export function resolveRuntimeImagePullTimeoutSec(input: {
  sizeBytes?: number | null;
  historicalSpeedBps?: number | null;
  envRaw?: string | undefined;
} = {}): RuntimeImagePullTimeoutResolution {
  const env = parseEnvTimeoutSec(
    input.envRaw !== undefined ? input.envRaw : process.env[RUNTIME_IMAGE_PULL_TIMEOUT_ENV],
  );
  if (env.value !== null) {
    return {
      timeout_sec: env.value,
      source: "env",
      size_bytes: normalizeSizeBytes(input.sizeBytes),
      speed_bps: input.historicalSpeedBps ?? historicalRuntimeImagePullSpeedBps(),
      env_raw: env.raw,
      env_rejected: false,
    };
  }
  if (env.rejected) {
    console.warn(
      `[runtime-images] ${RUNTIME_IMAGE_PULL_TIMEOUT_ENV}=${env.raw} 非法（须为 ${RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MIN_SEC}..${RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MAX_SEC} 的整数秒）；回退自动估算`,
    );
  }

  const sizeBytes = normalizeSizeBytes(input.sizeBytes);
  const speed = (input.historicalSpeedBps ?? historicalRuntimeImagePullSpeedBps()) || RUNTIME_IMAGE_PULL_DEFAULT_SPEED_BPS;
  if (sizeBytes === null) {
    return {
      timeout_sec: RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC,
      source: "default_min",
      size_bytes: null,
      speed_bps: speed,
      env_raw: env.raw,
      env_rejected: env.rejected,
    };
  }
  const estimated = Math.ceil(sizeBytes / speed);
  const timeoutSec = Math.min(
    RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MAX_SEC,
    Math.max(RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC, estimated),
  );
  return {
    timeout_sec: timeoutSec,
    source: "estimate",
    size_bytes: sizeBytes,
    speed_bps: speed,
    env_raw: env.raw,
    env_rejected: env.rejected,
  };
}

function normalizeSizeBytes(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function classifyRuntimeImagePullFailure(error: unknown): RuntimeImagePullFailureClass {
  const text = typeof error === "string"
    ? error
    : error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error ?? "");
  if (/no space left|disk (?:is )?full|ENOSPC|out of disk|insufficient storage/i.test(text)) return "disk_full";
  if (/unauthorized|authentication required|denied|forbidden|401|403|invalid username\/password|access denied/i.test(text)) {
    return "auth";
  }
  if (/digest not found|manifest unknown|not found|no such image|unknown blob|repository does not exist/i.test(text)) {
    return "digest_missing";
  }
  if (/超时|timeout|timed out|deadline exceeded|i\/o timeout/i.test(text)) return "timeout";
  if (/\beof\b|unexpected eof|httpReadSeeker|aliregistry\.oss|connection reset|connection refused|ECONNRESET|ECONNREFUSED|broken pipe|TLS handshake/i.test(text)) {
    return "transport";
  }
  return "other";
}

/** Timeout and transient transport failures may consume the single unified retry slot. */
export function isRetryableRuntimeImagePullFailure(failureClass: RuntimeImagePullFailureClass): boolean {
  return failureClass === "timeout" || failureClass === "transport";
}

/** Unified pull budget: first attempt + at most one retry (same-digest fallback consumes that slot). */
export const RUNTIME_IMAGE_PULL_MAX_ATTEMPTS = 2;

export function logRuntimeImagePullAttempt(input: {
  imageRef: string;
  attempt: number;
  maxAttempts: number;
  timeoutSec: number;
  durationMs: number;
  failureClass: RuntimeImagePullFailureClass | null;
  outcome: "succeeded" | "failed" | "retrying" | "exhausted";
  sizeBytes?: number | null;
  source?: RuntimeImagePullTimeoutSource;
}): void {
  const parts = [
    `ref=${input.imageRef}`,
    `attempt=${input.attempt}/${input.maxAttempts}`,
    `timeout_sec=${input.timeoutSec}`,
    `duration_ms=${Math.round(input.durationMs)}`,
    `outcome=${input.outcome}`,
  ];
  if (input.source) parts.push(`timeout_source=${input.source}`);
  if (input.sizeBytes != null) parts.push(`size_bytes=${input.sizeBytes}`);
  if (input.failureClass) parts.push(`failure_class=${input.failureClass}`);
  const line = `[runtime-images] pull attempt ${parts.join(" ")}`;
  if (input.outcome === "succeeded") console.log(line);
  else console.warn(line);
}
