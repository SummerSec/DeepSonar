import type { SandboxLimits } from "@deepsonar/runtime-sandbox";

type NetworkPolicyQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;

export interface FrozenNetworkPolicy {
  allow_egress: boolean;
}

/**
 * Project-owned resource overrides are deliberately narrower than the full
 * runtime sandbox contract.  Linux capability and privilege settings remain
 * server-owned and are never accepted from RoleConfig input.
 */
export interface SandboxLimitsOverride {
  cpu?: number;
  memoryMiB?: number;
  pidsLimit?: number;
}

/** Runtime images that need outbound target-network access to fetch in-scope source. */
export const CHROME_RUNTIME_IMAGE_KEYS = new Set([
  "deepsonar-chrome-audit",
  "deepsonar-chrome-test",
  "deepsonar-chrome-fuzz",
]);

export const CLICKHOUSE_RUNTIME_IMAGE_KEYS = new Set([
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-fuzz",
]);

/**
 * Enforce the scheduler-owned network policy for browser runtimes.  Keep this
 * at the snapshot boundary so create/retry/dispatch paths share one rule and
 * never infer policy from Agent or Hub payloads.
 */
export function assertChromeRuntimeEgressAllowed(
  runtimeImageKey: unknown,
  allowEgress: unknown,
): void {
  const key = typeof runtimeImageKey === "string" ? runtimeImageKey : "";
  if (CHROME_RUNTIME_IMAGE_KEYS.has(key) && allowEgress !== true) {
    throw new Error(
      `Chrome runtime ${key} requires canvas network_policy.allow_egress=true`,
    );
  }
  if (CLICKHOUSE_RUNTIME_IMAGE_KEYS.has(key) && allowEgress !== true) {
    throw new Error(
      `ClickHouse runtime ${key} requires canvas network_policy.allow_egress=true`,
    );
  }
}

/** Read the immutable canvas target's effective egress bit without trusting
 * arbitrary Job payload metadata. Undefined means the canvas is malformed or
 * not available; browser runtimes fail closed through the shared assertion. */
export function frozenCanvasAllowEgress(target: unknown): boolean | undefined {
  if (!target || typeof target !== "object" || Array.isArray(target))
    return undefined;
  const policy = (target as Record<string, unknown>).network_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy))
    return undefined;
  const value = (policy as Record<string, unknown>).allow_egress;
  return typeof value === "boolean" ? value : undefined;
}

function snapshotRuntimeImageKey(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return undefined;
  const value = snapshot as Record<string, unknown>;
  const runtimeImage = value.runtime_image;
  const imageKey =
    runtimeImage &&
    typeof runtimeImage === "object" &&
    !Array.isArray(runtimeImage)
      ? ((runtimeImage as Record<string, unknown>).image_key ??
        value.runtime_image_key)
      : value.runtime_image_key;
  return typeof imageKey === "string" ? imageKey : undefined;
}

/**
 * Freeze the canvas-owned task policy into the Job snapshot immediately
 * before a Job INSERT.  Payloads, Hub proposals, and mutable project config
 * are intentionally not consulted here.  A missing or malformed canvas
 * policy rejects every new Job so execution can never guess a network mode.
 */
export async function freezeAgentSnapshotNetworkPolicy<T extends object>(
  db: NetworkPolicyQuery,
  canvasId: string | null | undefined,
  snapshot: T,
): Promise<T & { network_policy: FrozenNetworkPolicy }> {
  if (!canvasId)
    throw new Error(
      "Job 创建缺少 canvas_id，无法冻结 network_policy.allow_egress",
    );
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(
      "Job 创建缺少合法的 Agent 运行快照，无法冻结 network_policy.allow_egress",
    );
  }
  const [canvas] =
    (await db`SELECT target_json FROM canvases WHERE id = ${canvasId} FOR SHARE`) as Array<{
      target_json?: unknown;
    }>;
  if (!canvas)
    throw new Error(
      `canvas ${canvasId} 不存在，无法冻结 network_policy.allow_egress`,
    );
  const allowEgress = frozenCanvasAllowEgress(canvas.target_json);
  if (typeof allowEgress !== "boolean") {
    throw new Error(
      `canvas ${canvasId} 缺少合法的 network_policy.allow_egress`,
    );
  }
  assertChromeRuntimeEgressAllowed(
    snapshotRuntimeImageKey(snapshot),
    allowEgress,
  );
  return {
    ...snapshot,
    network_policy: { allow_egress: allowEgress },
  };
}

/** Read only the immutable network policy embedded in a Job snapshot; undefined when absent. */
export function frozenSnapshotAllowEgress(
  snapshot: unknown,
): boolean | undefined {
  const value =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).network_policy
      : undefined;
  const allowEgress =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).allow_egress
      : undefined;
  return typeof allowEgress === "boolean" ? allowEgress : undefined;
}

/** 同一读取，但缺失视为硬错误：执行期不允许猜网络模式。 */
export function requireFrozenSnapshotAllowEgress(
  snapshot: unknown,
  jobId?: string,
): boolean {
  const allowEgress = frozenSnapshotAllowEgress(snapshot);
  if (allowEgress === undefined) {
    throw new Error(
      `${jobId ? `job ${jobId}` : "Job"} 缺少冻结的 network_policy.allow_egress`,
    );
  }
  return allowEgress;
}

export type EffectiveSandboxLimits = Required<SandboxLimits>;

export const SANDBOX_LIMIT_BOUNDS = Object.freeze({
  cpu: Object.freeze({ min: 0.25, max: 64 }),
  memoryMiB: Object.freeze({ min: 256, max: 131_072 }),
  pidsLimit: Object.freeze({ min: 64, max: 32_768 }),
});

const SERVER_DEFAULTS: EffectiveSandboxLimits = Object.freeze({
  cpu: 2,
  memoryMiB: 2_048,
  pidsLimit: 512,
  capDropAll: true,
  noNewPrivileges: true,
});

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validCpu(value: unknown): value is number {
  return (
    finiteNumber(value) &&
    value >= SANDBOX_LIMIT_BOUNDS.cpu.min &&
    value <= SANDBOX_LIMIT_BOUNDS.cpu.max
  );
}

function validPositiveInteger(
  value: unknown,
  bounds: { min: number; max: number },
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= bounds.min &&
    (value as number) <= bounds.max
  );
}

/**
 * Validate a RoleConfig JSONB override. Unknown keys and server-governed
 * capability flags are rejected rather than silently discarded.
 */
export function parseSandboxLimitsOverride(
  value: unknown,
): SandboxLimitsOverride {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sandbox_limits must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["cpu", "memoryMiB", "pidsLimit"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`sandbox_limits contains unsupported field: ${key}`);
    }
  }
  if (input.cpu !== undefined && !validCpu(input.cpu)) {
    throw new Error(
      `sandbox_limits.cpu must be between ${SANDBOX_LIMIT_BOUNDS.cpu.min} and ${SANDBOX_LIMIT_BOUNDS.cpu.max}`,
    );
  }
  if (
    input.memoryMiB !== undefined &&
    !validPositiveInteger(input.memoryMiB, SANDBOX_LIMIT_BOUNDS.memoryMiB)
  ) {
    throw new Error(
      `sandbox_limits.memoryMiB must be an integer between ${SANDBOX_LIMIT_BOUNDS.memoryMiB.min} and ${SANDBOX_LIMIT_BOUNDS.memoryMiB.max}`,
    );
  }
  if (
    input.pidsLimit !== undefined &&
    !validPositiveInteger(input.pidsLimit, SANDBOX_LIMIT_BOUNDS.pidsLimit)
  ) {
    throw new Error(
      `sandbox_limits.pidsLimit must be an integer between ${SANDBOX_LIMIT_BOUNDS.pidsLimit.min} and ${SANDBOX_LIMIT_BOUNDS.pidsLimit.max}`,
    );
  }
  return {
    ...(input.cpu === undefined ? {} : { cpu: input.cpu }),
    ...(input.memoryMiB === undefined ? {} : { memoryMiB: input.memoryMiB }),
    ...(input.pidsLimit === undefined ? {} : { pidsLimit: input.pidsLimit }),
  };
}

function boundedServerNumber(
  value: unknown,
  fallback: number,
  validate: (candidate: unknown) => candidate is number,
): number {
  return validate(value) ? value : fallback;
}

/**
 * Platform resource ceiling from env/config. Static SANDBOX_LIMIT_BOUNDS remain
 * the absolute parse ceiling; projects may only tighten at or below this floor.
 */
export function platformSandboxResourceCeiling(
  serverDefaults: SandboxLimits | null | undefined,
): Pick<EffectiveSandboxLimits, "cpu" | "memoryMiB" | "pidsLimit"> {
  const defaults = serverDefaults ?? {};
  return {
    cpu: boundedServerNumber(defaults.cpu, SERVER_DEFAULTS.cpu, validCpu),
    memoryMiB: boundedServerNumber(
      defaults.memoryMiB,
      SERVER_DEFAULTS.memoryMiB,
      (value) => validPositiveInteger(value, SANDBOX_LIMIT_BOUNDS.memoryMiB),
    ),
    pidsLimit: boundedServerNumber(
      defaults.pidsLimit,
      SERVER_DEFAULTS.pidsLimit,
      (value) => validPositiveInteger(value, SANDBOX_LIMIT_BOUNDS.pidsLimit),
    ),
  };
}

export const SANDBOX_LIMITS_EXCEED_PLATFORM = "SANDBOX_LIMITS_EXCEED_PLATFORM" as const;

/**
 * True when any project override dimension exceeds the platform env default.
 * Used by RoleConfig PUT and transfer import clamp paths (#697).
 */
export function sandboxLimitsExceedPlatform(
  override: SandboxLimitsOverride,
  serverDefaults: SandboxLimits | null | undefined,
): boolean {
  const ceiling = platformSandboxResourceCeiling(serverDefaults);
  if (override.cpu !== undefined && override.cpu > ceiling.cpu) return true;
  if (override.memoryMiB !== undefined && override.memoryMiB > ceiling.memoryMiB) return true;
  if (override.pidsLimit !== undefined && override.pidsLimit > ceiling.pidsLimit) return true;
  return false;
}

/**
 * Clamp project overrides to the platform ceiling (idempotent). Dimensions
 * omitted stay omitted; only explicit raises are pressed down.
 */
export function clampSandboxLimitsOverrideToPlatform(
  override: SandboxLimitsOverride,
  serverDefaults: SandboxLimits | null | undefined,
): { clamped: SandboxLimitsOverride; changed: boolean } {
  const ceiling = platformSandboxResourceCeiling(serverDefaults);
  const clamped: SandboxLimitsOverride = { ...override };
  let changed = false;
  if (clamped.cpu !== undefined && clamped.cpu > ceiling.cpu) {
    clamped.cpu = ceiling.cpu;
    changed = true;
  }
  if (clamped.memoryMiB !== undefined && clamped.memoryMiB > ceiling.memoryMiB) {
    clamped.memoryMiB = ceiling.memoryMiB;
    changed = true;
  }
  if (clamped.pidsLimit !== undefined && clamped.pidsLimit > ceiling.pidsLimit) {
    clamped.pidsLimit = ceiling.pidsLimit;
    changed = true;
  }
  return { clamped, changed };
}

/**
 * Merge a project override under the platform defaults (per-dimension min) and
 * return the complete runtime contract consumed by Dispatcher. Capability flags
 * stay server-owned. Projects can only tighten resources (#697 / DESIGN §8).
 */
export function resolveEffectiveSandboxLimits(
  override: unknown,
  serverDefaults: SandboxLimits | null | undefined,
): EffectiveSandboxLimits {
  const parsed = parseSandboxLimitsOverride(override);
  const defaults = serverDefaults ?? {};
  const ceiling = platformSandboxResourceCeiling(serverDefaults);
  return {
    cpu: parsed.cpu === undefined ? ceiling.cpu : Math.min(parsed.cpu, ceiling.cpu),
    memoryMiB: parsed.memoryMiB === undefined ? ceiling.memoryMiB : Math.min(parsed.memoryMiB, ceiling.memoryMiB),
    pidsLimit: parsed.pidsLimit === undefined ? ceiling.pidsLimit : Math.min(parsed.pidsLimit, ceiling.pidsLimit),
    capDropAll: defaults.capDropAll ?? SERVER_DEFAULTS.capDropAll,
    noNewPrivileges:
      defaults.noNewPrivileges ?? SERVER_DEFAULTS.noNewPrivileges,
  };
}
