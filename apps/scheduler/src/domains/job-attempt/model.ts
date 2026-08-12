import type { ContextState } from "@deepsonar/runtime-sandbox";

/**
 * Job Attempt 的持久执行模型。
 *
 * Job 是宏观生命周期权威，Attempt 只表示一次具体执行的当前程序计数器。
 * 这里的校验位于数据库 JSONB 之前，避免 Agent 输入把高基数或敏感正文写入账本。
 */

export const ATTEMPT_PHASES = [
  "preparing",
  "provision.effect_pending",
  "provisioned",
  "agent.ready",
  "agent.effect_pending",
  "agent.suspended",
  "settling",
  "terminal",
  "interrupted",
  "unknown",
] as const;

export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

export const ATTEMPT_STATUSES = [
  "active",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  "orphan",
  "interrupted",
  "unknown",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const REPLAY_POLICIES = ["never", "safe"] as const;
export type ReplayPolicy = (typeof REPLAY_POLICIES)[number];

export const EFFECT_STATUSES = ["planned", "effect_pending", "settled", "unknown"] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

/** 只允许平台内部定义的低基数外部效果种类。 */
export const EFFECT_KINDS = [
  "provision",
  "agent_run",
  "agent_resume",
  "sandbox_destroy",
  "canvas_delivery",
  "gateway_model_request",
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

/** 当前实现中只有销毁动作具备可重复调用的幂等语义。 */
export const SAFE_REPLAY_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set(["sandbox_destroy"]);

export type AttemptSnapshotIdentity = {
  snapshot_sha256?: string;
  agent_cli?: string;
  adapter_id?: string;
  adapter_version?: string;
  runtime_image_ref?: string;
  runtime_image_key?: string;
};

export type AttemptState = {
  version: 1;
  attempt_id: string;
  job_id: string;
  attempt_no: number;
  phase: AttemptPhase;
  replay_policy: ReplayPolicy;
  cancel_requested: boolean;
  current_effect_id: string | null;
  sandbox_id: string | null;
  session_id: string | null;
  resource_labels: Record<string, string>;
  snapshot_identity: AttemptSnapshotIdentity;
  /** 仅保存上下文身份与变换摘要，不保存 prompt 或 provider 原文。 */
  runtime_context?: ContextState;
  outcome: Record<string, unknown>;
};

export type EffectDescriptor = {
  effectId: string;
  kind: EffectKind;
  step?: number;
  replayPolicy?: ReplayPolicy;
  inputDigest?: string | null;
  resourceIdentity?: Record<string, unknown>;
  intent?: Record<string, unknown>;
};

export type EffectSettlement = {
  status: "settled" | "unknown";
  outcome?: Record<string, unknown>;
  error?: string | null;
  evidenceRef?: string | null;
};

export const EFFECT_CRASH_POINTS = [
  "before_intent",
  "after_intent_before_external",
  "after_external_before_settlement",
  "after_settlement",
] as const;
export type EffectCrashPoint = (typeof EFFECT_CRASH_POINTS)[number];

/**
 * 故障点只产生确定的恢复结论：未观察到 settlement 时标 unknown，
 * 绝不依赖进程内 Promise 是否仍然存在，也不默认再次触发外部副作用。
 */
export function effectCrashRecovery(point: EffectCrashPoint): "retry_new_attempt" | "mark_unknown" | "continue" {
  switch (point) {
    case "before_intent":
      return "retry_new_attempt";
    case "after_settlement":
      return "continue";
    case "after_intent_before_external":
    case "after_external_before_settlement":
      return "mark_unknown";
  }
}

export const ATTEMPT_MAX_STATE_BYTES = 32 * 1024;
export const ATTEMPT_MAX_IDENTITY_BYTES = 4 * 1024;
export const ATTEMPT_MAX_RESOURCE_BYTES = 4 * 1024;
export const ATTEMPT_MAX_EFFECT_JSON_BYTES = 8 * 1024;
export const ATTEMPT_MAX_ERROR_CHARS = 500;

const EFFECT_ID_RE = /^[a-z][a-z0-9_.:-]{1,127}$/u;
const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/iu;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
}

export function assertBoundedJson(value: unknown, label: string, maxBytes: number): void {
  if (jsonBytes(value) > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节限制`);
}

export function normalizeLowCardinalityText(value: unknown, label: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} 格式非法或超出长度限制`);
  }
  return normalized;
}

export function validateEffectDescriptor(input: EffectDescriptor): Required<Pick<EffectDescriptor, "effectId" | "kind" | "step" | "replayPolicy">> & EffectDescriptor {
  if (!EFFECT_ID_RE.test(input.effectId)) throw new Error("effect_id 格式非法或超出长度限制");
  if (!(EFFECT_KINDS as readonly string[]).includes(input.kind)) throw new Error("effect_kind 不在平台允许清单中");
  const step = input.step ?? 1;
  if (!Number.isSafeInteger(step) || step < 1 || step > 1_000_000) throw new Error("effect step 超出范围");
  const replayPolicy = input.replayPolicy ?? "never";
  if (!(REPLAY_POLICIES as readonly string[]).includes(replayPolicy)) throw new Error("replay_policy 非法");
  if (replayPolicy === "safe" && !SAFE_REPLAY_EFFECT_KINDS.has(input.kind)) {
    throw new Error(`效果 ${input.kind} 当前未声明 safe 重放能力`);
  }
  if (input.inputDigest !== undefined && input.inputDigest !== null && !DIGEST_RE.test(input.inputDigest)) {
    throw new Error("input_digest 必须是 sha256 摘要");
  }
  const resourceIdentity = input.resourceIdentity ?? {};
  const intent = input.intent ?? {};
  assertObject(resourceIdentity, "resource_identity");
  assertObject(intent, "intent");
  assertBoundedJson(resourceIdentity, "resource_identity", ATTEMPT_MAX_EFFECT_JSON_BYTES);
  assertBoundedJson(intent, "intent", ATTEMPT_MAX_EFFECT_JSON_BYTES);
  return { ...input, step, replayPolicy, resourceIdentity, intent };
}

export function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, ATTEMPT_MAX_ERROR_CHARS);
}

export function buildAttemptState(input: {
  attemptId: string;
  jobId: string;
  attemptNo: number;
  phase?: AttemptPhase;
  replayPolicy?: ReplayPolicy;
  snapshotIdentity?: AttemptSnapshotIdentity;
  resourceLabels?: Record<string, string>;
}): AttemptState {
  const phase = input.phase ?? "preparing";
  if (!(ATTEMPT_PHASES as readonly string[]).includes(phase)) throw new Error("Attempt phase 非法");
  const snapshotIdentity = input.snapshotIdentity ?? {};
  const resourceLabels = input.resourceLabels ?? {};
  assertBoundedJson(snapshotIdentity, "snapshot_identity", ATTEMPT_MAX_IDENTITY_BYTES);
  assertBoundedJson(resourceLabels, "resource_labels", ATTEMPT_MAX_RESOURCE_BYTES);
  const state: AttemptState = {
    version: 1,
    attempt_id: input.attemptId,
    job_id: input.jobId,
    attempt_no: input.attemptNo,
    phase,
    replay_policy: input.replayPolicy ?? "never",
    cancel_requested: false,
    current_effect_id: null,
    sandbox_id: null,
    session_id: null,
    resource_labels: resourceLabels,
    snapshot_identity: snapshotIdentity,
    outcome: {},
  };
  assertBoundedJson(state, "attempt state", ATTEMPT_MAX_STATE_BYTES);
  return state;
}

export function canReplayEffect(
  descriptor: Pick<EffectDescriptor, "kind" | "replayPolicy">,
  currentSnapshot: AttemptSnapshotIdentity,
  persistedSnapshot: AttemptSnapshotIdentity,
): boolean {
  if (descriptor.replayPolicy !== "safe" || !SAFE_REPLAY_EFFECT_KINDS.has(descriptor.kind)) return false;
  return ["snapshot_sha256", "agent_cli", "adapter_id", "adapter_version", "runtime_image_ref"]
    .every((key) => (currentSnapshot[key as keyof AttemptSnapshotIdentity] ?? null) === (persistedSnapshot[key as keyof AttemptSnapshotIdentity] ?? null));
}
