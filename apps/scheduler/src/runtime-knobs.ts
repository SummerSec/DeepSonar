import { config } from "./config.js";
import { resolveJobStallSec } from "./domains/job-lifecycle/stall-policy.js";

/** Precedence for batch-1 runtime knobs: job > role > project > platform > env bootstrap. */
export const RUNTIME_KNOB_SOURCES = ["job", "role", "project", "platform", "env"] as const;
export type RuntimeKnobSource = (typeof RUNTIME_KNOB_SOURCES)[number];

export const RUNTIME_KNOB_BOUNDS = Object.freeze({
  stallSec: { min: 0, max: 172_800 },
  jobTokenMaxRequests: { min: 0, max: 1_000_000 },
  timeoutSec: { min: 60, max: 172_800 },
  provisionTimeoutSec: { min: 30, max: 7_200 },
});

/** Job 创建覆盖可短于角色/平台默认（测试与短任务）；上限与平台一致。 */
export const JOB_TIMEOUT_BOUNDS = Object.freeze({ min: 1, max: 172_800 });

export interface RuntimeKnobOverride {
  stallSec?: number | null;
  jobTokenMaxRequests?: number | null;
  timeoutSec?: number | null;
}

export interface RuntimeKnobLayer {
  stallSec?: number | null;
  jobTokenMaxRequests?: number | null;
  auditTimeoutSec?: number | null;
  verifyTimeoutSec?: number | null;
  provisionTimeoutSec?: number | null;
}

export interface ResolvedRuntimeKnobs {
  stallSec: number;
  jobTokenMaxRequests: number;
  timeoutSec: number;
  provisionTimeoutSec: number;
  sources: {
    stallSec: RuntimeKnobSource;
    jobTokenMaxRequests: RuntimeKnobSource;
    timeoutSec: RuntimeKnobSource;
    provisionTimeoutSec: RuntimeKnobSource;
  };
}

/** Frozen onto `agent_snapshot_json.runtime_knobs` so the next Job sees current DB values. */
export interface FrozenRuntimeKnobs {
  stall_sec: number;
  job_token_max_requests: number;
  timeout_sec: number;
  provision_timeout_sec: number;
  sources: ResolvedRuntimeKnobs["sources"];
}

export function envRuntimeKnobDefaults(): {
  stallSec: number;
  jobTokenMaxRequests: number;
  auditTimeoutSec: number;
  verifyTimeoutSec: number;
  provisionTimeoutSec: number;
} {
  return {
    stallSec: config.timeouts.stallSec,
    jobTokenMaxRequests: config.gateway.maxRequests,
    auditTimeoutSec: config.timeouts.auditSec,
    verifyTimeoutSec: config.timeouts.verifySec,
    provisionTimeoutSec: config.timeouts.provisionSec,
  };
}

export function asBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function parseOptionalBoundedInt(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

export function parseRuntimeKnobLayer(value: unknown): RuntimeKnobLayer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const stallSec = parseOptionalBoundedInt(raw.stallSec, RUNTIME_KNOB_BOUNDS.stallSec.min, RUNTIME_KNOB_BOUNDS.stallSec.max);
  const jobTokenMaxRequests = parseOptionalBoundedInt(
    raw.jobTokenMaxRequests,
    RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.min,
    RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.max,
  );
  const auditTimeoutSec = parseOptionalBoundedInt(raw.auditTimeoutSec, RUNTIME_KNOB_BOUNDS.timeoutSec.min, RUNTIME_KNOB_BOUNDS.timeoutSec.max);
  const verifyTimeoutSec = parseOptionalBoundedInt(raw.verifyTimeoutSec, RUNTIME_KNOB_BOUNDS.timeoutSec.min, RUNTIME_KNOB_BOUNDS.timeoutSec.max);
  const provisionTimeoutSec = parseOptionalBoundedInt(
    raw.provisionTimeoutSec,
    RUNTIME_KNOB_BOUNDS.provisionTimeoutSec.min,
    RUNTIME_KNOB_BOUNDS.provisionTimeoutSec.max,
  );
  return {
    ...(stallSec === undefined ? {} : { stallSec }),
    ...(jobTokenMaxRequests === undefined ? {} : { jobTokenMaxRequests }),
    ...(auditTimeoutSec === undefined ? {} : { auditTimeoutSec }),
    ...(verifyTimeoutSec === undefined ? {} : { verifyTimeoutSec }),
    ...(provisionTimeoutSec === undefined ? {} : { provisionTimeoutSec }),
  };
}

const ROLE_KNOB_WRITE_KEYS = new Set(["stallSec", "jobTokenMaxRequests", "timeoutSec"]);
const ROLE_KNOB_SNAKE_KEYS: Record<string, keyof RuntimeKnobOverride> = {
  stall_sec: "stallSec",
  job_token_max_requests: "jobTokenMaxRequests",
  timeout_sec: "timeoutSec",
};

export function validateRuntimeKnobOverride(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "runtime_knobs 必须是对象";
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key in ROLE_KNOB_SNAKE_KEYS) return `runtime_knobs 已删除 snake_case 别名 ${key}，请使用 ${ROLE_KNOB_SNAKE_KEYS[key]}`;
    if (!ROLE_KNOB_WRITE_KEYS.has(key)) return `runtime_knobs 包含不支持的字段: ${key}`;
  }
  const parsed = parseRuntimeKnobOverride(raw);
  if (hasInvalidOptionalInt(raw, ["stallSec", "stall_sec"], parsed.stallSec)) {
    return `stallSec 必须是 ${RUNTIME_KNOB_BOUNDS.stallSec.min}-${RUNTIME_KNOB_BOUNDS.stallSec.max} 的整数（0 关闭）`;
  }
  if (hasInvalidOptionalInt(raw, ["jobTokenMaxRequests", "job_token_max_requests"], parsed.jobTokenMaxRequests)) {
    return `jobTokenMaxRequests 必须是 ${RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.min}-${RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.max} 的整数（0 不限制）`;
  }
  if (hasInvalidOptionalInt(raw, ["timeoutSec", "timeout_sec"], parsed.timeoutSec)) {
    return `timeoutSec 必须是 ${RUNTIME_KNOB_BOUNDS.timeoutSec.min}-${RUNTIME_KNOB_BOUNDS.timeoutSec.max} 的整数`;
  }
  return null;
}

function hasInvalidOptionalInt(raw: Record<string, unknown>, keys: string[], parsed: number | null | undefined): boolean {
  const present = keys.find((key) => Object.prototype.hasOwnProperty.call(raw, key));
  if (!present) return false;
  return raw[present] !== null && parsed === undefined;
}

export function canonicalizeRoleRuntimeKnobsJson(value: unknown): { next: Record<string, unknown>; changed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { next: {}, changed: Boolean(value) };
  const raw = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [key, item] of Object.entries(raw)) {
    const canonical = ROLE_KNOB_SNAKE_KEYS[key] ?? (ROLE_KNOB_WRITE_KEYS.has(key) ? key : null);
    if (!canonical) {
      changed = true;
      continue;
    }
    if (canonical !== key) changed = true;
    if (next[canonical] === undefined) next[canonical] = item;
  }
  return { next, changed };
}

export function parseRuntimeKnobOverride(
  value: unknown,
  timeoutBounds: { min: number; max: number } = RUNTIME_KNOB_BOUNDS.timeoutSec,
): RuntimeKnobOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = canonicalizeRoleRuntimeKnobsJson(value).next;
  const stallSec = parseOptionalBoundedInt(raw.stallSec, RUNTIME_KNOB_BOUNDS.stallSec.min, RUNTIME_KNOB_BOUNDS.stallSec.max);
  const jobTokenMaxRequests = parseOptionalBoundedInt(
    raw.jobTokenMaxRequests,
    RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.min,
    RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.max,
  );
  const timeoutSec = parseOptionalBoundedInt(
    raw.timeoutSec,
    timeoutBounds.min,
    timeoutBounds.max,
  );
  return {
    ...(stallSec === undefined ? {} : { stallSec }),
    ...(jobTokenMaxRequests === undefined ? {} : { jobTokenMaxRequests }),
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
  };
}

function pickLayerValue(
  layers: Array<{ value: number | null | undefined; source: RuntimeKnobSource }>,
  fallback: number,
  fallbackSource: RuntimeKnobSource,
): { value: number; source: RuntimeKnobSource } {
  for (const layer of layers) {
    if (typeof layer.value === "number" && Number.isInteger(layer.value)) {
      return { value: layer.value, source: layer.source };
    }
  }
  return { value: fallback, source: fallbackSource };
}

export function defaultTimeoutForJobType(jobType: string, layer: RuntimeKnobLayer): number | undefined {
  const verify = jobType === "verify_finding" || jobType === "verify";
  return verify ? layer.verifyTimeoutSec ?? undefined : layer.auditTimeoutSec ?? undefined;
}

/**
 * Tighten a lower-layer knob against a platform/global ceiling (#697 / DESIGN §8).
 *
 * For stallSec / jobTokenMaxRequests: **0 means unlimited / disabled**. Unlimited is the
 * widest setting, so a project/role `0` cannot widen a finite platform ceiling — it is
 * clamped back to the ceiling. A finite override under an unlimited (0) ceiling is a
 * valid tighten. Timeout has no unlimited-zero semantics (min bound ≥ 1 or 60).
 */
export function tightenRuntimeKnobValue(
  override: number | null | undefined,
  ceiling: number | null | undefined,
  opts: { zeroIsUnlimited: boolean },
): number | undefined {
  // Absent override does not invent a value — callers that want "inherit ceiling"
  // (RoleConfig merge) use `override ?? ceiling` themselves.
  if (override === undefined || override === null) return undefined;
  if (ceiling === undefined || ceiling === null) return override;
  if (opts.zeroIsUnlimited) {
    if (ceiling === 0) return override; // platform unlimited: finite override tightens
    if (override === 0) return ceiling; // project unlimited would widen
    return Math.min(override, ceiling);
  }
  return Math.min(override, ceiling);
}

/**
 * Resolve batch-1 knobs. Precedence remains Job > role > project > platform > env, but
 * role/project layers are clamped to the platform/env ceiling (项目只能收紧, #697).
 * Chrome image floors still raise stall unless the winning value is 0 (disabled).
 * Job-layer overrides are not clamped (per-Job intent).
 */
export function resolveRuntimeKnobs(input: {
  job?: RuntimeKnobOverride;
  role?: RuntimeKnobOverride;
  project?: RuntimeKnobLayer;
  platform?: RuntimeKnobLayer;
  env?: RuntimeKnobLayer;
  jobType: string;
  imageKey?: string | null;
}): ResolvedRuntimeKnobs {
  const envDefaults = envRuntimeKnobDefaults();
  const envLayer = parseRuntimeKnobLayer(input.env);
  const env = {
    stallSec: envLayer.stallSec ?? envDefaults.stallSec,
    jobTokenMaxRequests: envLayer.jobTokenMaxRequests ?? envDefaults.jobTokenMaxRequests,
    auditTimeoutSec: envLayer.auditTimeoutSec ?? envDefaults.auditTimeoutSec,
    verifyTimeoutSec: envLayer.verifyTimeoutSec ?? envDefaults.verifyTimeoutSec,
    provisionTimeoutSec: envLayer.provisionTimeoutSec ?? envDefaults.provisionTimeoutSec,
  };
  const job = parseRuntimeKnobOverride(input.job, JOB_TIMEOUT_BOUNDS);
  const role = parseRuntimeKnobOverride(input.role);
  const project = parseRuntimeKnobLayer(input.project);
  const platform = parseRuntimeKnobLayer(input.platform);

  const stallCeiling = typeof platform.stallSec === "number" ? platform.stallSec : env.stallSec;
  const requestsCeiling = typeof platform.jobTokenMaxRequests === "number"
    ? platform.jobTokenMaxRequests
    : env.jobTokenMaxRequests;
  const timeoutCeiling = defaultTimeoutForJobType(input.jobType, platform)
    ?? defaultTimeoutForJobType(input.jobType, env)
    ?? env.auditTimeoutSec;

  const roleStall = tightenRuntimeKnobValue(role.stallSec, stallCeiling, { zeroIsUnlimited: true });
  const projectStall = tightenRuntimeKnobValue(project.stallSec, stallCeiling, { zeroIsUnlimited: true });
  const roleRequests = tightenRuntimeKnobValue(role.jobTokenMaxRequests, requestsCeiling, { zeroIsUnlimited: true });
  const projectRequests = tightenRuntimeKnobValue(project.jobTokenMaxRequests, requestsCeiling, { zeroIsUnlimited: true });
  const roleTimeout = tightenRuntimeKnobValue(role.timeoutSec, timeoutCeiling, { zeroIsUnlimited: false });
  const projectTimeout = tightenRuntimeKnobValue(
    defaultTimeoutForJobType(input.jobType, project),
    timeoutCeiling,
    { zeroIsUnlimited: false },
  );

  const stall = pickLayerValue(
    [
      { value: job.stallSec, source: "job" },
      { value: roleStall, source: "role" },
      { value: projectStall, source: "project" },
      { value: platform.stallSec, source: "platform" },
    ],
    env.stallSec,
    "env",
  );
  const requests = pickLayerValue(
    [
      { value: job.jobTokenMaxRequests, source: "job" },
      { value: roleRequests, source: "role" },
      { value: projectRequests, source: "project" },
      { value: platform.jobTokenMaxRequests, source: "platform" },
    ],
    env.jobTokenMaxRequests,
    "env",
  );
  const timeout = pickLayerValue(
    [
      { value: job.timeoutSec, source: "job" },
      { value: roleTimeout, source: "role" },
      { value: projectTimeout, source: "project" },
      { value: defaultTimeoutForJobType(input.jobType, platform), source: "platform" },
    ],
    defaultTimeoutForJobType(input.jobType, env) ?? env.auditTimeoutSec,
    "env",
  );
  const provision = pickLayerValue(
    [{ value: platform.provisionTimeoutSec, source: "platform" }],
    env.provisionTimeoutSec,
    "env",
  );

  return {
    stallSec: resolveJobStallSec(input.imageKey, stall.value),
    jobTokenMaxRequests: requests.value,
    timeoutSec: timeout.value,
    provisionTimeoutSec: provision.value,
    sources: {
      stallSec: stall.source,
      jobTokenMaxRequests: requests.source,
      timeoutSec: timeout.source,
      provisionTimeoutSec: provision.source,
    },
  };
}

export function freezeRuntimeKnobs(resolved: ResolvedRuntimeKnobs): FrozenRuntimeKnobs {
  return {
    stall_sec: resolved.stallSec,
    job_token_max_requests: resolved.jobTokenMaxRequests,
    timeout_sec: resolved.timeoutSec,
    provision_timeout_sec: resolved.provisionTimeoutSec,
    sources: resolved.sources,
  };
}

export function frozenRuntimeKnobsFromSnapshot(snapshot: unknown): FrozenRuntimeKnobs | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const raw = (snapshot as Record<string, unknown>).runtime_knobs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const stallSec = parseOptionalBoundedInt(value.stall_sec, RUNTIME_KNOB_BOUNDS.stallSec.min, RUNTIME_KNOB_BOUNDS.stallSec.max);
  const jobTokenMaxRequests = parseOptionalBoundedInt(
    value.job_token_max_requests,
    RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.min,
    RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests.max,
  );
  const timeoutSec = parseOptionalBoundedInt(value.timeout_sec, JOB_TIMEOUT_BOUNDS.min, JOB_TIMEOUT_BOUNDS.max);
  const provisionTimeoutSec = parseOptionalBoundedInt(
    value.provision_timeout_sec,
    RUNTIME_KNOB_BOUNDS.provisionTimeoutSec.min,
    RUNTIME_KNOB_BOUNDS.provisionTimeoutSec.max,
  );
  if (
    stallSec === undefined
    || jobTokenMaxRequests === undefined
    || timeoutSec === undefined
    || provisionTimeoutSec === undefined
  ) {
    return null;
  }
  return {
    stall_sec: stallSec,
    job_token_max_requests: jobTokenMaxRequests,
    timeout_sec: timeoutSec,
    provision_timeout_sec: provisionTimeoutSec,
    sources: parseFrozenKnobSources(value.sources),
  };
}

function parseFrozenKnobSources(value: unknown): FrozenRuntimeKnobs["sources"] {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const pick = (key: keyof FrozenRuntimeKnobs["sources"]): RuntimeKnobSource => {
    const candidate = raw[key];
    return typeof candidate === "string" && (RUNTIME_KNOB_SOURCES as readonly string[]).includes(candidate)
      ? candidate as RuntimeKnobSource
      : "job";
  };
  return {
    stallSec: pick("stallSec"),
    jobTokenMaxRequests: pick("jobTokenMaxRequests"),
    timeoutSec: pick("timeoutSec"),
    provisionTimeoutSec: pick("provisionTimeoutSec"),
  };
}

/** 0 means unlimited: skip the used_requests cap. */
export function jobTokenQuotaExhausted(usedRequests: number, maxRequests: number): boolean {
  if (!Number.isFinite(usedRequests) || !Number.isFinite(maxRequests)) return false;
  if (maxRequests <= 0) return false;
  return usedRequests >= maxRequests;
}

/**
 * Merge project RoleConfig knobs over global: project may only tighten (#697).
 * stallSec / jobTokenMaxRequests treat 0 as unlimited (widest).
 */
export function mergeRoleRuntimeKnobOverrides(
  globalKnobs: unknown,
  projectKnobs: unknown,
): RuntimeKnobOverride {
  const global = parseRuntimeKnobOverride(globalKnobs);
  const project = parseRuntimeKnobOverride(projectKnobs);
  return {
    stallSec: project.stallSec === undefined
      ? global.stallSec
      : tightenRuntimeKnobValue(project.stallSec, global.stallSec, { zeroIsUnlimited: true }),
    jobTokenMaxRequests: project.jobTokenMaxRequests === undefined
      ? global.jobTokenMaxRequests
      : tightenRuntimeKnobValue(
        project.jobTokenMaxRequests,
        global.jobTokenMaxRequests,
        { zeroIsUnlimited: true },
      ),
    timeoutSec: project.timeoutSec === undefined
      ? global.timeoutSec
      : tightenRuntimeKnobValue(project.timeoutSec, global.timeoutSec, { zeroIsUnlimited: false }),
  };
}
