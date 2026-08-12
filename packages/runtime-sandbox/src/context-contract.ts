import { createHash } from "node:crypto";

export const CONTEXT_CONTRACT_VERSION = 1 as const;
export const CONTEXT_MAX_TRANSFORMS = 32;
export const CONTEXT_MAX_COMPACTIONS = 32;
export const CONTEXT_MAX_EVENT_IDS = 64;
export const CONTEXT_MAX_JSON_BYTES = 16 * 1024;

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu;

export type ContextSource = "scheduler" | "adapter" | "provider" | "unknown" | "unsupported";
export type ContextObservation = "observed" | "unknown" | "unsupported";
export type ContextTransformStage =
  | "initial_input"
  | "graph_scope"
  | "budget_truncation"
  | "summary_handoff"
  | "provider_compaction";

export interface ContextBudget {
  unit: "chars" | "tokens" | "items";
  limit: number;
  observed: number | null;
}

export interface ContextOmission {
  kind: string;
  count: number | null;
  reason: string;
  truncated: boolean;
}

export interface ContextTransformManifest {
  stage: ContextTransformStage;
  version: number;
  revision: number;
  input_digest: string;
  output_digest: string;
  budget: ContextBudget | null;
  omission: ContextOmission | null;
  source: ContextSource;
}

export interface ContextBoundary {
  kind: "tail" | "turn" | "session" | "unknown";
  retained_tail_count: number | null;
  retained_tail_digest: string | null;
}

export interface ContextCompactionEvent {
  type: "context.compacted";
  event_id: string;
  context_id: string;
  context_revision: number;
  adapter_id: string;
  adapter_version: string;
  runtime_identity: string;
  transform_chain_digest: string;
  policy: string;
  boundary: ContextBoundary;
  input_digest: string;
  output_digest: string;
  budget: ContextBudget | null;
  omission: ContextOmission | null;
  source: "adapter" | "provider";
}

export interface ContextCompactionStatus {
  observation: ContextObservation;
  source: ContextSource;
  policy: string;
  reason: string | null;
  last_event_id: string | null;
}

export interface ContextState {
  version: typeof CONTEXT_CONTRACT_VERSION;
  context_id: string;
  context_revision: number;
  attempt_id: string | null;
  adapter_id: string;
  adapter_version: string;
  runtime_identity: string;
  policy: string;
  transform_chain_digest: string;
  transforms: ContextTransformManifest[];
  compactions: ContextCompactionEvent[];
  event_ids: string[];
  compaction: ContextCompactionStatus;
}

export interface ContextIdentity {
  context_id: string;
  context_revision: number;
  adapter_id: string;
  adapter_version: string;
  runtime_identity: string;
  transform_chain_digest: string;
  /** 首次结构化 init/get_state 观察到的稳定会话标识。 */
  session_id?: string;
  /** Pi 恢复使用的精确 session 文件；不包含会话正文。 */
  session_file?: string;
}

export interface ContextResumeMismatch {
  ok: false;
  code: "context_id" | "context_revision" | "adapter_id" | "adapter_version" | "runtime_identity" | "transform_chain_digest" | "session_id" | "session_file";
  message: string;
}

export interface ContextResumeMatch {
  ok: true;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
}

function assertString(value: unknown, label: string, max = 160): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} 格式非法或超出长度限制`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) throw new Error(`${label} 必须是 sha256 摘要`);
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new Error(`${label} 必须是合法的非负整数`);
  }
}

function assertBounded(value: unknown, label: string): void {
  if (jsonBytes(value) > CONTEXT_MAX_JSON_BYTES) throw new Error(`${label} 超过 ${CONTEXT_MAX_JSON_BYTES} 字节限制`);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function stableContextJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function contextDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableContextJson(value)).digest("hex")}`;
}

export function contextTextDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeDigest(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function validateBudget(value: ContextBudget | null, label: string): ContextBudget | null {
  if (value === null) return null;
  assertObject(value, label);
  if (!("chars" === value.unit || "tokens" === value.unit || "items" === value.unit)) {
    throw new Error(`${label}.unit 非法`);
  }
  if (!Number.isSafeInteger(value.limit) || value.limit < 0 || value.limit > 10_000_000) throw new Error(`${label}.limit 非法`);
  if (value.observed !== null && (!Number.isSafeInteger(value.observed) || value.observed < 0 || value.observed > 10_000_000)) {
    throw new Error(`${label}.observed 非法`);
  }
  return { unit: value.unit, limit: value.limit, observed: value.observed };
}

function validateOmission(value: ContextOmission | null, label: string): ContextOmission | null {
  if (value === null) return null;
  assertObject(value, label);
  assertString(value.kind, `${label}.kind`, 64);
  assertString(value.reason, `${label}.reason`, 160);
  if (value.count !== null && (!Number.isSafeInteger(value.count) || value.count < 0 || value.count > 1_000_000)) {
    throw new Error(`${label}.count 非法`);
  }
  if (typeof value.truncated !== "boolean") throw new Error(`${label}.truncated 必须是布尔值`);
  return { kind: value.kind, count: value.count, reason: value.reason, truncated: value.truncated };
}

function validateBoundary(value: ContextBoundary, label: string): ContextBoundary {
  assertObject(value, label);
  if (!(value.kind === "tail" || value.kind === "turn" || value.kind === "session" || value.kind === "unknown")) {
    throw new Error(`${label}.kind 非法`);
  }
  if (value.retained_tail_count !== null && (!Number.isSafeInteger(value.retained_tail_count) || value.retained_tail_count < 0 || value.retained_tail_count > 1_000_000)) {
    throw new Error(`${label}.retained_tail_count 非法`);
  }
  if (value.retained_tail_digest !== null) assertDigest(value.retained_tail_digest, `${label}.retained_tail_digest`);
  return {
    kind: value.kind,
    retained_tail_count: value.retained_tail_count,
    retained_tail_digest: value.retained_tail_digest,
  };
}

function validateManifest(value: ContextTransformManifest, label: string): ContextTransformManifest {
  assertObject(value, label);
  if (!(typeof value.stage === "string" && ["initial_input", "graph_scope", "budget_truncation", "summary_handoff", "provider_compaction"].includes(value.stage))) {
    throw new Error(`${label}.stage 非法`);
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1 || value.version > 1000) throw new Error(`${label}.version 非法`);
  assertRevision(value.revision, `${label}.revision`);
  assertDigest(value.input_digest, `${label}.input_digest`);
  assertDigest(value.output_digest, `${label}.output_digest`);
  if (!(value.source === "scheduler" || value.source === "adapter" || value.source === "provider" || value.source === "unknown" || value.source === "unsupported")) {
    throw new Error(`${label}.source 非法`);
  }
  return {
    stage: value.stage,
    version: value.version,
    revision: value.revision,
    input_digest: value.input_digest,
    output_digest: value.output_digest,
    budget: validateBudget(value.budget, `${label}.budget`),
    omission: validateOmission(value.omission, `${label}.omission`),
    source: value.source,
  };
}

function chainDigest(transforms: readonly ContextTransformManifest[]): string {
  return contextDigest(transforms);
}

function stateIdentitySeed(input: {
  adapter_id: string;
  adapter_version: string;
  runtime_identity: string;
  policy: string;
  input_digest: string;
  snapshot_digest?: string | null;
}): Record<string, unknown> {
  return {
    adapter_id: input.adapter_id,
    adapter_version: input.adapter_version,
    input_digest: normalizeDigest(input.input_digest),
    policy: input.policy,
    runtime_identity: input.runtime_identity,
    snapshot_digest: input.snapshot_digest ? normalizeDigest(input.snapshot_digest) : null,
  };
}

export function createContextState(input: {
  attempt_id?: string | null;
  adapter_id: string;
  adapter_version: string;
  runtime_identity: string;
  policy: string;
  input_digest: string;
  snapshot_digest?: string | null;
}): ContextState {
  assertString(input.adapter_id, "adapter_id", 64);
  assertString(input.adapter_version, "adapter_version", 64);
  assertString(input.runtime_identity, "runtime_identity", 160);
  assertString(input.policy, "policy", 64);
  assertDigest(normalizeDigest(input.input_digest), "input_digest");
  if (input.snapshot_digest !== undefined && input.snapshot_digest !== null) assertDigest(normalizeDigest(input.snapshot_digest), "snapshot_digest");
  if (input.attempt_id !== undefined && input.attempt_id !== null) assertString(input.attempt_id, "attempt_id", 128);
  const initial: ContextTransformManifest = {
    stage: "initial_input",
    version: 1,
    revision: 0,
    input_digest: normalizeDigest(input.input_digest),
    output_digest: normalizeDigest(input.input_digest),
    budget: null,
    omission: null,
    source: "scheduler",
  };
  const unsupported = input.policy === "unsupported";
  const state: ContextState = {
    version: CONTEXT_CONTRACT_VERSION,
    context_id: `ctx_${contextDigest(stateIdentitySeed(input)).slice("sha256:".length, "sha256:".length + 32)}`,
    context_revision: 0,
    attempt_id: input.attempt_id ?? null,
    adapter_id: input.adapter_id,
    adapter_version: input.adapter_version,
    runtime_identity: input.runtime_identity,
    policy: input.policy,
    transform_chain_digest: chainDigest([initial]),
    transforms: [initial],
    compactions: [],
    event_ids: [],
    compaction: {
      observation: unsupported ? "unsupported" : "unknown",
      source: unsupported ? "unsupported" : "unknown",
      policy: input.policy,
      reason: unsupported ? "适配器不支持上下文压缩" : "当前运行未观测到明确的压缩边界",
      last_event_id: null,
    },
  };
  assertBounded(state, "context state");
  return state;
}

export function contextIdentity(state: ContextState): ContextIdentity {
  return {
    context_id: state.context_id,
    context_revision: state.context_revision,
    adapter_id: state.adapter_id,
    adapter_version: state.adapter_version,
    runtime_identity: state.runtime_identity,
    transform_chain_digest: state.transform_chain_digest,
  };
}

export function appendContextTransform(
  state: ContextState,
  input: Omit<ContextTransformManifest, "revision">,
): ContextState {
  validateContextState(state);
  if (state.transforms.length >= CONTEXT_MAX_TRANSFORMS) throw new Error("CONTEXT_TRANSFORM_LIMIT");
  const current = state.transforms[state.transforms.length - 1];
  const manifest = validateManifest({ ...input, revision: state.context_revision + 1 }, "transform");
  if (manifest.input_digest !== current.output_digest) throw new Error("CONTEXT_TRANSFORM_INPUT_MISMATCH");
  const transforms = [...state.transforms, manifest];
  const next = {
    ...state,
    context_revision: state.context_revision + 1,
    transform_chain_digest: chainDigest(transforms),
    transforms,
  };
  assertBounded(next, "context state");
  return next;
}

export function markContextCompactionUnobservable(
  state: ContextState,
  observation: "unknown" | "unsupported",
  reason: string,
): ContextState {
  validateContextState(state);
  assertString(reason, "compaction reason", 160);
  return {
    ...state,
    compaction: {
      observation,
      source: observation,
      policy: state.policy,
      reason,
      last_event_id: state.compaction.last_event_id,
    },
  };
}

export function applyContextCompactedEvent(
  state: ContextState,
  event: ContextCompactionEvent,
): ContextState {
  validateContextState(state);
  validateCompactionEvent(event);
  if (state.event_ids.includes(event.event_id)) {
    const previous = state.compactions.find((item) => item.event_id === event.event_id);
    if (!previous || stableContextJson(previous) !== stableContextJson(event)) throw new Error("CONTEXT_EVENT_ID_REUSE");
    return state;
  }
  if (event.context_id !== state.context_id) throw new Error("CONTEXT_ID_MISMATCH");
  if (event.adapter_id !== state.adapter_id || event.adapter_version !== state.adapter_version) throw new Error("CONTEXT_ADAPTER_MISMATCH");
  if (event.runtime_identity !== state.runtime_identity) throw new Error("CONTEXT_RUNTIME_MISMATCH");
  if (event.transform_chain_digest !== state.transform_chain_digest) throw new Error("CONTEXT_TRANSFORM_CHAIN_MISMATCH");
  if (event.context_revision <= state.context_revision) throw new Error("CONTEXT_REVISION_STALE");
  if (event.context_revision !== state.context_revision + 1) throw new Error("CONTEXT_REVISION_GAP");
  if (event.input_digest !== state.transforms[state.transforms.length - 1].output_digest) throw new Error("CONTEXT_COMPACTION_INPUT_MISMATCH");
  if (state.compactions.length >= CONTEXT_MAX_COMPACTIONS || state.event_ids.length >= CONTEXT_MAX_EVENT_IDS) throw new Error("CONTEXT_EVENT_LIMIT");
  const transform: ContextTransformManifest = {
    stage: "provider_compaction",
    version: 1,
    revision: event.context_revision,
    input_digest: event.input_digest,
    output_digest: event.output_digest,
    budget: event.budget,
    omission: event.omission,
    source: event.source,
  };
  const transforms = [...state.transforms, transform];
  const next: ContextState = {
    ...state,
    context_revision: event.context_revision,
    transform_chain_digest: chainDigest(transforms),
    transforms,
    compactions: [...state.compactions, event],
    event_ids: [...state.event_ids, event.event_id],
    compaction: {
      observation: "observed",
      source: event.source,
      policy: event.policy,
      reason: null,
      last_event_id: event.event_id,
    },
  };
  assertBounded(next, "context state");
  return next;
}

function validateCompactionEvent(event: ContextCompactionEvent): void {
  assertObject(event, "context.compacted");
  if (event.type !== "context.compacted") throw new Error("CONTEXT_EVENT_TYPE_UNSUPPORTED");
  assertString(event.event_id, "event_id", 128);
  assertString(event.context_id, "context_id", 128);
  assertRevision(event.context_revision, "context_revision");
  assertString(event.adapter_id, "adapter_id", 64);
  assertString(event.adapter_version, "adapter_version", 64);
  assertString(event.runtime_identity, "runtime_identity", 160);
  assertDigest(event.transform_chain_digest, "transform_chain_digest");
  assertString(event.policy, "policy", 64);
  validateBoundary(event.boundary, "boundary");
  assertDigest(event.input_digest, "input_digest");
  assertDigest(event.output_digest, "output_digest");
  if (!(event.source === "adapter" || event.source === "provider")) throw new Error("CONTEXT_EVENT_SOURCE_UNSUPPORTED");
  validateBudget(event.budget, "budget");
  validateOmission(event.omission, "omission");
  assertBounded(event, "context.compacted");
}

export function validateContextState(state: ContextState): void {
  assertObject(state, "context state");
  if (state.version !== CONTEXT_CONTRACT_VERSION) throw new Error("CONTEXT_VERSION_UNSUPPORTED");
  assertString(state.context_id, "context_id", 128);
  assertRevision(state.context_revision, "context_revision");
  if (state.attempt_id !== null) assertString(state.attempt_id, "attempt_id", 128);
  assertString(state.adapter_id, "adapter_id", 64);
  assertString(state.adapter_version, "adapter_version", 64);
  assertString(state.runtime_identity, "runtime_identity", 160);
  assertString(state.policy, "policy", 64);
  assertDigest(state.transform_chain_digest, "transform_chain_digest");
  if (!Array.isArray(state.transforms) || state.transforms.length === 0 || state.transforms.length > CONTEXT_MAX_TRANSFORMS) throw new Error("CONTEXT_TRANSFORMS_INVALID");
  state.transforms.forEach((item, index) => {
    const normalized = validateManifest(item, `transforms[${index}]`);
    if (normalized.revision !== index) throw new Error("CONTEXT_TRANSFORM_REVISION_INVALID");
    if (index > 0 && normalized.input_digest !== state.transforms[index - 1].output_digest) throw new Error("CONTEXT_TRANSFORM_CHAIN_INVALID");
  });
  if (state.context_revision !== state.transforms.length - 1) throw new Error("CONTEXT_REVISION_INVALID");
  if (chainDigest(state.transforms) !== state.transform_chain_digest) throw new Error("CONTEXT_CHAIN_DIGEST_INVALID");
  if (!Array.isArray(state.compactions) || state.compactions.length > CONTEXT_MAX_COMPACTIONS) throw new Error("CONTEXT_COMPACTIONS_INVALID");
  state.compactions.forEach(validateCompactionEvent);
  if (!Array.isArray(state.event_ids) || state.event_ids.length > CONTEXT_MAX_EVENT_IDS) throw new Error("CONTEXT_EVENT_IDS_INVALID");
  if (new Set(state.event_ids).size !== state.event_ids.length) throw new Error("CONTEXT_EVENT_IDS_DUPLICATE");
  if (!state.compactions.every((event) => state.event_ids.includes(event.event_id))) throw new Error("CONTEXT_EVENT_ID_MISSING");
  assertBounded(state, "context state");
}

export function validateContextResume(
  expected: ContextIdentity,
  actual: ContextIdentity,
): ContextResumeMatch | ContextResumeMismatch {
  const fields: Array<ContextResumeMismatch["code"]> = [
    "context_id",
    "context_revision",
    "adapter_id",
    "adapter_version",
    "runtime_identity",
    "transform_chain_digest",
  ];
  if (expected.session_id !== undefined) fields.push("session_id");
  if (expected.session_file !== undefined) fields.push("session_file");
  for (const code of fields) {
    if (expected[code] !== actual[code]) {
      return { ok: false, code, message: `上下文恢复身份不一致：${code}` };
    }
  }
  return { ok: true };
}

export function assertContextResume(expected: ContextIdentity, actual: ContextIdentity): void {
  const result = validateContextResume(expected, actual);
  if (!result.ok) throw new Error(`CONTEXT_RESUME_IDENTITY_MISMATCH:${result.code}`);
}

export function contextCompactionEventFromRuntime(value: unknown): ContextCompactionEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "context.compacted") return null;
  return candidate as unknown as ContextCompactionEvent;
}
