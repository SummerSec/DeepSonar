import { z } from "zod";

const nonEmptyText = (max: number) => z.string().min(1).max(max).regex(/\S/);

// ---------- 枚举（一律字符串，不用 DB enum，见 ARCHITECTURE §17.1） ----------

export const JobStatus = z.enum([
  "pending",
  "claimed",
  "provisioning",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "orphan",
  "waiting_human",
]);
export type JobStatus = z.infer<typeof JobStatus>;

/** Job 类型是数据库角色名或调度器系统类型，不在共享类型中维护第二份角色枚举。 */
export const JobType = z.string().min(1);
export type JobType = z.infer<typeof JobType>;

export const EventType = z.enum(["progress", "finding", "done", "human", "fact", "hub_decision"]);
export type EventType = z.infer<typeof EventType>;

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const VerifyStatus = z.enum([
  "pending",
  "verifying",
  "confirmed",
  "false_positive",
  "needs_human",
]);
export type VerifyStatus = z.infer<typeof VerifyStatus>;

/** Verify Agent 提交的 verdict 提案；false_positive 仅兼容期，服务端映射为 rework。 */
export const VerifyVerdict = z.enum(["confirmed", "rework", "needs_human", "false_positive"]);
export type VerifyVerdict = z.infer<typeof VerifyVerdict>;

/** 绑定到 Finding 的独立复核 / 实测证据（emit_fact 可选字段）。 */
export const VerificationEvidence = z
  .object({
  finding_id: z.string().uuid(),
  evidence_kind: z.enum(["review", "test"]),
  outcome: z.enum(["supports", "refutes", "inconclusive"]),
  subject_revision: nonEmptyText(500),
  environment: z.string().max(1000).regex(/\S/).optional(),
  steps: z.array(z.string().max(2000).regex(/\S/)).max(50).optional(),
  expected: z.string().max(5000).regex(/\S/).optional(),
  actual: z.string().max(5000).regex(/\S/).optional(),
  artifact_refs: z
    .array(
      z
        .object({
          uri: z.string().min(1).max(2000),
          sha256: z.string().max(128).optional(),
        })
        .strict(),
    )
    .max(20)
    .optional(),
  limitations: z.array(z.string().max(1000).regex(/\S/)).max(20).optional(),
  })
  .strict();
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;

export const NodeType = z.enum(["root", "job", "finding", "note", "human", "intent", "fact", "report"]);
export type NodeType = z.infer<typeof NodeType>;

/**
 * Authoritative task/canvas lifecycle rollup returned by every canvas
 * projection.  The Scheduler owns these values; clients must overwrite them
 * on every delta, including explicit zero/null values.
 */
export const CanvasLifecycleRollup = z.object({
  active_count: z.number().int().nonnegative(),
  job_count: z.number().int().nonnegative(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  root_status: z.string().nullable(),
  report_status: z.string().nullable(),
});
export type CanvasLifecycleRollup = z.infer<typeof CanvasLifecycleRollup>;

export const EdgeType = z.enum([
  "child",
  "produces",
  "verifies",
  "next",
  "from",
  "to",
  "reviewed_by",
  "tested_by",
]);
export type EdgeType = z.infer<typeof EdgeType>;

// ---------- Finding payload（SARIF 2.1.0 子集，见 ARCHITECTURE §6.1） ----------

export const FindingPayload = z
  .object({
    title: nonEmptyText(500),
    severity: Severity,
    location: z.string().max(1000).regex(/\S/).optional(), // "auth/login.php:42" ← SARIF artifactLocation + region
    summary: z.string().max(10000).regex(/\S/).optional(),
    rule_id: z.string().max(200).regex(/\S/).optional(), // SARIF ruleId
    /** 兼容字段：是否验证由调度器决定，不再影响派生。 */
    suggest_verify: z.boolean().default(false),
    raw: z.record(z.string(), z.unknown()).optional(), // SARIF result 原文
  })
  .strict();
export type FindingPayload = z.infer<typeof FindingPayload>;

/** Agent-facing Finding contract.  SARIF/raw is Scheduler-owned internal data
 * and is intentionally not writable through the control MCP. */
export const EmitFindingPayload = z
  .object({
    title: nonEmptyText(500),
    severity: Severity,
    location: z.string().max(1000).regex(/\S/).optional(),
    summary: z.string().max(10000).regex(/\S/).optional(),
    rule_id: z.string().max(200).regex(/\S/).optional(),
    suggest_verify: z.boolean().optional(),
  })
  .strict();
export type EmitFindingPayload = z.infer<typeof EmitFindingPayload>;

/** 角色 agent 的 fact 提案；verification 仅在 Hub 回弹补证 Job 上被接受。 */
export const FactPayload = z
  .object({
    title: nonEmptyText(200),
    description: nonEmptyText(10000),
    /** Scheduler-owned association; Agent input is ignored and overwritten. */
    intent_node_id: z.string().uuid().nullable().optional(),
    verification: VerificationEvidence.optional(),
  })
  .strict();
export type FactPayload = z.infer<typeof FactPayload>;

/** Control-tool input contracts.  These schemas are the single source used by
 * the Scheduler boundary and the generated in-sandbox MCP JSON Schema. */
export const EmitFactPayload = z
  .object({
    title: nonEmptyText(200),
    description: nonEmptyText(10000),
    verification: VerificationEvidence.optional(),
  })
  .strict();
export type EmitFactPayload = z.infer<typeof EmitFactPayload>;

export const ProgressPayload = z
  .object({
    message: nonEmptyText(2000),
    percent: z.number().min(0).max(100).optional(),
  })
  .strict();
export type ProgressPayload = z.infer<typeof ProgressPayload>;

export const HumanPayload = z
  .object({
    reason: nonEmptyText(2000),
  })
  .strict();
export type HumanPayload = z.infer<typeof HumanPayload>;

export const DonePayload = z
  .object({
    summary: nonEmptyText(10000),
    verdict: VerifyVerdict.optional(),
    missing_evidence: z.array(z.string().min(1).max(200)).max(8).optional(),
  })
  .strict();
export type DonePayload = z.infer<typeof DonePayload>;

export const ListAvailableRolesPayload = z.object({}).strict();
export type ListAvailableRolesPayload = z.infer<typeof ListAvailableRolesPayload>;

export const VerifyFindingPayload = z.object({
  finding: z.object({
    fingerprint: z.string(),
    title: z.string(),
    location: z.string().optional(),
    summary: z.string().optional(),
  }),
});
export type VerifyFindingPayload = z.infer<typeof VerifyFindingPayload>;

// ---------- Hub 下发与任务网络策略 ----------

/**
 * 任务唯一需要声明的运行边界：Worker 是否可以访问模型网关之外的网络。
 * 目标是什么、是否下载代码、使用 git/curl/浏览器或完全离线，均由 Agent 根据 prompt 决定。
 */
export const TaskNetworkPolicy = z.object({
  allow_egress: z.boolean(),
});
export type TaskNetworkPolicy = z.infer<typeof TaskNetworkPolicy>;

// ---------- Scheduler readiness / preflight projection (#35/#36) ----------

/** Stable severity used by the management-plane preflight contract. */
export const ReadinessSeverity = z.enum(["info", "warning", "error"]);
export type ReadinessSeverity = z.infer<typeof ReadinessSeverity>;

/** How a readiness check resolved.  `attention` is non-blocking guidance. */
export const ReadinessState = z.enum(["pass", "attention", "fail"]);
export type ReadinessState = z.infer<typeof ReadinessState>;

export const ReadinessRoleSummary = z.object({
  role_id: z.string().uuid(),
  name: z.string().min(1),
  title: z.string(),
  kind: z.enum(["role", "hub", "system"]),
  config_id: z.string().uuid().nullable(),
  config_scope: z.enum(["project", "global", "platform_default"]),
  agent_cli: z.string().nullable(),
  model: z.string().nullable(),
  runtime_image_key: z.string().nullable(),
});
export type ReadinessRoleSummary = z.infer<typeof ReadinessRoleSummary>;

/** Non-sensitive credential identity.  Secrets, env names and ciphertext are never part of this type. */
export const ReadinessCredentialSummary = z.object({
  credential_id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["llm_provider", "plane", "git", "oci_registry"]),
  provider: z.string(),
  provider_valid: z.boolean(),
  project_id: z.string().uuid().nullable(),
  status: z.enum(["active", "disabled", "rotation_required"]),
  allowed_model_count: z.number().int().nonnegative(),
});
export type ReadinessCredentialSummary = z.infer<typeof ReadinessCredentialSummary>;

/** Trusted image identity only; mutable refs and arbitrary OCI text are intentionally omitted. */
export const ReadinessRuntimeImageSummary = z.object({
  image_key: z.string(),
  version_id: z.string().uuid().nullable(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  source_kind: z.enum(["official", "third_party"]).nullable(),
  official: z.boolean().nullable(),
  trust_status: z.string().nullable(),
  project_enabled: z.boolean().nullable(),
  admission_scan_id: z.string().uuid().nullable(),
});
export type ReadinessRuntimeImageSummary = z.infer<typeof ReadinessRuntimeImageSummary>;

export const ReadinessEvidenceSummary = z.object({
  kind: z.enum(["credential_test", "model_discovery", "allowlist", "none"]),
  status: z.enum(["ok", "error", "missing", "stale"]),
  at: z.string().datetime().nullable(),
  age_seconds: z.number().nonnegative().nullable(),
  model_count: z.number().int().nonnegative().nullable(),
  source: z.enum(["audit_log", "credential_metadata", "not_recorded"]),
});
export type ReadinessEvidenceSummary = z.infer<typeof ReadinessEvidenceSummary>;

/** Stable repair intent consumed by the web console.  Keep href/target for
 * older clients, but never require them to infer a route from presentation
 * text.  Scheduler responses always include action/scope/project_id. */
export const ReadinessFixAction = z.enum([
  "credentials",
  "role_config",
  "rules",
  "runtime_images",
]);
export type ReadinessFixAction = z.infer<typeof ReadinessFixAction>;

export const ReadinessFix = z.object({
  action: ReadinessFixAction.optional(),
  scope: z.enum(["global", "project"]).optional(),
  project_id: z.string().uuid().nullable().optional(),
  href: z.string().min(1),
  target: z.string().min(1),
});
export type ReadinessFix = z.infer<typeof ReadinessFix>;

export const ReadinessCheck = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/),
  state: ReadinessState,
  severity: ReadinessSeverity,
  message: z.string().min(1),
  fix: ReadinessFix.nullish(),
  role: ReadinessRoleSummary.nullish(),
  credential: ReadinessCredentialSummary.nullish(),
  runtime_image: ReadinessRuntimeImageSummary.nullish(),
  evidence: ReadinessEvidenceSummary.nullish(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheck>;

export const ReadinessNetworkPolicy = z.object({
  allow_egress: z.boolean(),
  source: z.enum(["global", "project", "task_override"]),
  material_source: z.enum(["workspace_or_offline", "external_or_workspace", "declared", "unspecified"]),
});
export type ReadinessNetworkPolicy = z.infer<typeof ReadinessNetworkPolicy>;

export const ReadinessScope = z.object({
  kind: z.enum(["global", "project"]),
  project_id: z.string().uuid().nullable(),
});
export type ReadinessScope = z.infer<typeof ReadinessScope>;

export const ReadinessResponse = z.object({
  schema: z.literal("deepsonar.readiness/v1"),
  ready: z.boolean(),
  execution_mode: z.enum(["fake", "real"]),
  scope: ReadinessScope,
  network_policy: ReadinessNetworkPolicy,
  checks: z.array(ReadinessCheck),
  summary: z.object({
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    infos: z.number().int().nonnegative(),
  }),
  generated_at: z.string().datetime(),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;

/** Canonical UUID used for graph node references crossing the Agent boundary. */
export const CANONICAL_UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export const GraphNodeReference = z
  .string()
  .uuid()
  .regex(new RegExp(CANONICAL_UUID_PATTERN, "i"));
export type GraphNodeReference = z.infer<typeof GraphNodeReference>;

/**
 * Hard limits for references crossing the Hub/Scheduler boundary. A limit on
 * each `from` list prevents one intent from creating an unexpectedly large
 * query, while the total unique limit prevents many small intents from
 * bypassing that protection.
 */
export const HUB_REFERENCE_LIMITS = {
  perFrom: 64,
  totalUnique: 256,
} as const;

export interface HubReferenceBudgetViolation {
  path: Array<string | number>;
  count: number;
  limit: number;
  kind: "per_from" | "total_unique";
}

/** Find the first reference-budget violation without assuming valid payload shape. */
export function hubReferenceBudgetViolation(value: unknown): HubReferenceBudgetViolation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const groups: Array<{ path: Array<string | number>; refs: unknown[] }> = [];
  const complete = input.complete;
  if (complete && typeof complete === "object" && !Array.isArray(complete)) {
    const from = (complete as Record<string, unknown>).from;
    if (Array.isArray(from)) groups.push({ path: ["complete", "from"], refs: from });
  }
  const intents = input.intents;
  if (Array.isArray(intents)) {
    for (const [index, intent] of intents.entries()) {
      if (!intent || typeof intent !== "object" || Array.isArray(intent)) continue;
      const from = (intent as Record<string, unknown>).from;
      if (Array.isArray(from)) groups.push({ path: ["intents", index, "from"], refs: from });
    }
  }
  for (const group of groups) {
    if (group.refs.length > HUB_REFERENCE_LIMITS.perFrom) {
      return {
        path: group.path,
        count: group.refs.length,
        limit: HUB_REFERENCE_LIMITS.perFrom,
        kind: "per_from",
      };
    }
  }
  const unique = new Set<string>();
  for (const group of groups) {
    for (const ref of group.refs) {
      if (typeof ref === "string") unique.add(ref);
    }
  }
  if (unique.size > HUB_REFERENCE_LIMITS.totalUnique) {
    return {
      path: ["intents"],
      count: unique.size,
      limit: HUB_REFERENCE_LIMITS.totalUnique,
      kind: "total_unique",
    };
  }
  return null;
}

const HubReferenceList = z.array(GraphNodeReference).max(HUB_REFERENCE_LIMITS.perFrom);

/** Hub 对一个 Worker 的结构化下发。prompt 是真正注入 CLI 的本轮用户消息。 */
export const HubIntentPayload = z
  .object({
    from: HubReferenceList,
    role: nonEmptyText(64),
    description: nonEmptyText(2_000),
    prompt: nonEmptyText(20_000),
  })
  .strict();
export type HubIntentPayload = z.infer<typeof HubIntentPayload>;

export const HubCompletePayload = z
  .object({
    from: HubReferenceList,
    description: nonEmptyText(10_000),
  })
  .strict();
export type HubCompletePayload = z.infer<typeof HubCompletePayload>;

/** Complete and intents are mutually exclusive at the decision boundary. */
export const HubDecisionPayload = z.union([
  z.object({ complete: HubCompletePayload }).strict(),
  z.object({ intents: z.array(HubIntentPayload).min(1).max(100) }).strict(),
]).superRefine((value, ctx) => {
  const violation = hubReferenceBudgetViolation(value);
  if (!violation || violation.kind !== "total_unique") return;
  ctx.addIssue({
    code: "custom",
    path: violation.path,
    message: `Hub reference count exceeds the total unique limit of ${violation.limit}`,
    params: { kind: violation.kind, limit: violation.limit, count: violation.count },
  });
});
export type HubDecisionPayload = z.infer<typeof HubDecisionPayload>;

export const ControlToolPayloadSchemas = {
  list_available_roles: ListAvailableRolesPayload,
  emit_progress: ProgressPayload,
  emit_fact: EmitFactPayload,
  emit_finding: EmitFindingPayload,
  submit_hub_decision: HubDecisionPayload,
  mark_job_done: DonePayload,
  request_human: HumanPayload,
} as const;
export type ControlToolPayload = {
  [K in keyof typeof ControlToolPayloadSchemas]: z.infer<(typeof ControlToolPayloadSchemas)[K]>;
};

/** JSON Schema emitted for MCP tools/list from the same Zod contracts. */
export const ControlToolInputSchemasJson = Object.fromEntries(
  Object.entries(ControlToolPayloadSchemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { target: "draft-7" }),
  ]),
) as unknown as Record<keyof typeof ControlToolPayloadSchemas, Record<string, unknown>>;

// ---------- 事件 envelope（§17.3 版本化） ----------

/** Internal Hub envelope shape. Graph references stay opaque here so the
 * Scheduler can turn malformed values into stable invalid_node_ref errors
 * before any PostgreSQL UUID cast. */
const HubDecisionEnvelopeInput = z
  .object({
    complete: z.unknown().optional(),
    intents: z.unknown().optional(),
  })
  .strict();

/** Agent-facing envelope. Scheduler-owned fact intent_node_id and Finding raw
 * SARIF data are deliberately unavailable at this boundary. */
export const ControlEventEnvelope = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("progress"), payload: ProgressPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("finding"), payload: EmitFindingPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("done"), payload: DonePayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("human"), payload: HumanPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("fact"), payload: EmitFactPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("hub_decision"), payload: HubDecisionPayload }).strict(),
]);
export type ControlEventEnvelope = z.infer<typeof ControlEventEnvelope>;

/** Internal payloads may carry scheduler-owned fields, but every side effect
 * revalidates the corresponding strict schema before writing. */
export const EventEnvelope = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("progress"), payload: ProgressPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("finding"), payload: FindingPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("done"), payload: DonePayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("human"), payload: HumanPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("fact"), payload: FactPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("hub_decision"), payload: HubDecisionEnvelopeInput }).strict(),
]);
export type EventEnvelope = z.infer<typeof EventEnvelope>;
/** Broad producer input; `EventEnvelope.parse` is the runtime gate before
 * ingestion and side effects. */
export type EventEnvelopeInput = {
  v: 1;
  event_id: string;
  type: EventType;
  payload: unknown;
};

// ---------- DeepSonar 平台工具（RoleConfig 可按 Job 开关） ----------

export const PlatformToolName = z.enum([
  "list_available_roles",
  "emit_progress",
  "emit_fact",
  "emit_finding",
  "submit_hub_decision",
  "mark_job_done",
  "request_human",
]);
export type PlatformToolName = z.infer<typeof PlatformToolName>;
export type PlatformToolConfig = Partial<Record<PlatformToolName, boolean>>;

// ---------- RoleConfig 模块选择器（Issue #33，向后兼容） ----------

/** 模块源 UUID 的固定格式。源 id 在数据库中是 uuid，固定长度让 selector 可无歧义解析。 */
export const MODULE_SELECTOR_SOURCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ModuleSelectorKind = "module" | "plugin" | "source";

export interface ParsedModuleSelector {
  /** 用户提交的原始字符串；快照和 transfer 必须保留它。 */
  raw: string;
  source_id: string;
  kind: ModuleSelectorKind;
  module_id?: string;
  plugin?: string;
  /** 用于比较/去重的规范形式，不替换 raw。 */
  canonical: string;
}

/**
 * 规范化仓库相对路径。模块源扫描结果来自 POSIX 路径；统一斜杠并去掉无害的
 * 重复分隔符/`.`，但在归一化前拒绝 `..`、绝对路径和控制字符，避免逃出 catalog 边界。
 */
export function normalizeModuleSelectorPath(value: string, field = "module path"): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  if (!value || value !== value.trim()) throw new Error(`${field} 不能为空或包含首尾空白`);
  if (value.includes("\0") || value.includes(":")) throw new Error(`${field} 含非法路径字符`);
  const slashed = value.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed)) throw new Error(`${field} 不能是绝对路径`);
  const segments = slashed.split("/");
  if (segments.some((segment) => segment === "..")) throw new Error(`${field} 不得包含 ..`);
  let decoded = slashed;
  try {
    decoded = decodeURIComponent(slashed).replaceAll("\\", "/");
  } catch {
    throw new Error(`${field} 含非法 URL 编码`);
  }
  if (
    decoded.startsWith("/") ||
    decoded.includes(":") ||
    /^[A-Za-z]:\//.test(decoded) ||
    decoded.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`${field} 归一化后越界`);
  }
  if (segments.some((segment) => /[\u0000-\u001f\u007f]/.test(segment)) || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new Error(`${field} 含控制字符`);
  }
  const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

/**
 * 解析 RoleConfig.modules_json 中的 selector：
 * - <source_uuid>:<module_path>（历史格式）
 * - <source_uuid>:plugin:<plugin_path>
 * - <source_uuid>:source:*
 */
export function parseModuleSelector(value: string): ParsedModuleSelector {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new Error("模块 selector 必须是 1-1024 个字符的字符串");
  }
  if (value !== value.trim()) throw new Error("模块 selector 不能包含首尾空白");
  if (value.length < 37 || value[36] !== ":") throw new Error(`模块 selector 缺少合法 source UUID: ${value}`);
  const sourceId = value.slice(0, 36);
  if (!MODULE_SELECTOR_SOURCE_ID_RE.test(sourceId)) {
    throw new Error(`模块 selector 的 source UUID 非法: ${sourceId}`);
  }
  const rest = value.slice(37);
  const normalizedSourceId = sourceId.toLowerCase();
  if (rest === "source:*") {
    return { raw: value, source_id: normalizedSourceId, kind: "source", canonical: `${normalizedSourceId}:source:*` };
  }
  if (rest.startsWith("source:")) throw new Error(`模块源 selector 必须是 ${normalizedSourceId}:source:*`);
  if (rest.startsWith("plugin:")) {
    const plugin = normalizeModuleSelectorPath(rest.slice("plugin:".length), "plugin path");
    return {
      raw: value,
      source_id: normalizedSourceId,
      kind: "plugin",
      plugin,
      canonical: `${normalizedSourceId}:plugin:${plugin}`,
    };
  }
  if (rest.includes(":")) throw new Error(`模块 selector 含未知保留前缀: ${value}`);
  const moduleId = normalizeModuleSelectorPath(rest, "module path");
  return {
    raw: value,
    source_id: normalizedSourceId,
    kind: "module",
    module_id: moduleId,
    canonical: `${normalizedSourceId}:${moduleId}`,
  };
}

/** 校验并原样返回合法 selector，供 RoleConfig / transfer 复用。 */
export function validateModuleSelectors(values: unknown, field = "modules"): string[] {
  if (!Array.isArray(values)) throw new Error(`${field} 必须是字符串数组`);
  const selectors: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${field} 只能包含字符串 selector`);
    parseModuleSelector(value);
    selectors.push(value);
  }
  return selectors;
}

/** 一个角色有资格启用的工具；未列出的工具即使配置为 true 也必须拒绝。 */
export function allowedPlatformTools(
  roleName: string,
  roleKind: "role" | "hub" | "system",
): PlatformToolName[] {
  // verify/report 必须形成确定性终态：
  // - verify 通过 verdict=needs_human 收口 Finding；request_human 只会让 Job 停在 waiting_human。
  // - report 只消费冻结输入；输入损坏应让 Job 失败并重试，不能停在人工等待。
  const canRequestHuman = roleName !== "verify" && roleName !== "report";
  return [
    ...(roleKind === "hub" ? (["list_available_roles"] as PlatformToolName[]) : []),
    "emit_progress",
    ...(roleKind === "role" && roleName !== "audit" ? (["emit_fact"] as PlatformToolName[]) : []),
    ...(roleName === "audit" ? (["emit_finding"] as PlatformToolName[]) : []),
    ...(roleKind === "hub" ? (["submit_hub_decision"] as PlatformToolName[]) : []),
    "mark_job_done",
    ...(canRequestHuman ? (["request_human"] as PlatformToolName[]) : []),
  ];
}

/** 关闭后 Job 无法形成合法终态的工具，配置层不可禁用。 */
export function requiredPlatformTools(roleKind: "role" | "hub" | "system"): PlatformToolName[] {
  return roleKind === "hub"
    ? ["list_available_roles", "submit_hub_decision", "mark_job_done"]
    : ["mark_job_done"];
}

/** 空配置代表启用该角色全部合法工具；显式 false 才关闭可选工具。 */
export function resolvePlatformTools(
  roleName: string,
  roleKind: "role" | "hub" | "system",
  config: PlatformToolConfig,
): PlatformToolName[] {
  const required = new Set(requiredPlatformTools(roleKind));
  return allowedPlatformTools(roleName, roleKind).filter((name) => required.has(name) || config[name] !== false);
}

// fingerprint 计算：title + location + rule_id 归一化后的 sha256 前 16 位
export async function computeFingerprint(
  input: { title: string; location?: string; rule_id?: string },
  digest: (s: string) => Promise<string> | string,
): Promise<string> {
  const norm = [input.title.trim().toLowerCase(), (input.location ?? "").trim(), (input.rule_id ?? "").trim()].join(
    "|",
  );
  return digest(norm);
}
