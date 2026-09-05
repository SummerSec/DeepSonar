import { z } from "zod";

const nonEmptyText = (max: number) => z.string().min(1).max(max).regex(/\S/);

/** Model/provider-owned reasoning profile token. The platform stores and forwards it without a fixed vocabulary. */
export const REASONING_VALUE_MAX_LENGTH = 64;
export const REASONING_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ReasoningValue = z.string().trim().min(1).max(REASONING_VALUE_MAX_LENGTH).regex(REASONING_VALUE_PATTERN);
export type ReasoningValue = z.infer<typeof ReasoningValue>;
export function isReasoningValue(value: unknown): value is ReasoningValue {
  return typeof value === "string" && REASONING_VALUE_PATTERN.test(value);
}

/** Canonical DSH/pi-ai reasoning levels. Provider-specific wire values live in model.reasoningEfforts. */
export const DSH_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type DshReasoningEffort = (typeof DSH_REASONING_EFFORTS)[number];
export function isDshReasoningEffort(value: unknown): value is DshReasoningEffort {
  return typeof value === "string" && DSH_REASONING_EFFORTS.some((effort) => effort === value);
}

/** Claude Code settings.json effortLevel values. Thinking enablement is a separate setting. */
export const CLAUDE_CODE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ClaudeCodeReasoningEffort = (typeof CLAUDE_CODE_REASONING_EFFORTS)[number];
export function isClaudeCodeReasoningEffort(value: unknown): value is ClaudeCodeReasoningEffort {
  return typeof value === "string" && CLAUDE_CODE_REASONING_EFFORTS.some((effort) => effort === value);
}

/** Codex model_reasoning_effort values kept for leftover historical archives/credentials. */
export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string" && CODEX_REASONING_EFFORTS.some((effort) => effort === value);
}

/** Current write/run Agent CLIs. The adapter registry stays open for later additions. */
export const CURRENT_AGENT_CLIS = ["claude-code", "pi", "dsh"] as const;
export type CurrentAgentCli = (typeof CURRENT_AGENT_CLIS)[number];
export const CURRENT_AGENT_CLI_DEFAULT = "claude-code" as const;
/** Retired from new RoleConfig/Job writes; leftover rows and archives stay readable. */
export const LEFTOVER_AGENT_CLIS = ["codex", "open-code"] as const;
export type LeftoverAgentCli = (typeof LEFTOVER_AGENT_CLIS)[number];
export const CurrentAgentCliSchema = z.enum(CURRENT_AGENT_CLIS);
export function isCurrentAgentCli(value: unknown): value is CurrentAgentCli {
  return typeof value === "string" && (CURRENT_AGENT_CLIS as readonly string[]).includes(value);
}
export function isLeftoverAgentCli(value: unknown): value is LeftoverAgentCli {
  return typeof value === "string" && (LEFTOVER_AGENT_CLIS as readonly string[]).includes(value);
}
export function leftoverAgentCliMigrationHint(cli: string): string {
  return `agent_cli=${cli} 已不再支持新配置。请迁移到 claude-code（默认）、pi 或 dsh 之一后再保存；系统不会自动改写存量配置。`;
}
export function rejectNonCurrentAgentCli(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return `未知 agent_cli，当前仅支持 ${CURRENT_AGENT_CLIS.join(" / ")}`;
  if (isLeftoverAgentCli(value)) return leftoverAgentCliMigrationHint(value);
  if (!isCurrentAgentCli(value)) return `未知 agent_cli，当前仅支持 ${CURRENT_AGENT_CLIS.join(" / ")}`;
  return null;
}
export const AgentCliWriteSchema = z.string().superRefine((value, ctx) => {
  const error = rejectNonCurrentAgentCli(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
});

/** Pi --thinking values; Pi and DSH share the same canonical vocabulary. */
export const PI_REASONING_EFFORTS = DSH_REASONING_EFFORTS;
export type PiReasoningEffort = DshReasoningEffort;
export const isPiReasoningEffort = isDshReasoningEffort;

/** Bounds and path syntax for large Agent control payloads stored in /workspace. */
export const SEMANTIC_EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
export const WORKSPACE_PAYLOAD_FILE_MAX_BYTES = SEMANTIC_EVENT_PAYLOAD_MAX_BYTES;
export const WORKSPACE_PAYLOAD_FILE_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
export function isSafeWorkspacePayloadFile(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 && WORKSPACE_PAYLOAD_FILE_PATTERN.test(value);
}

/** Final summaries are duplicated into durable event/node storage, so bound
 * the Agent-controlled text by its actual UTF-8 storage size, not JS chars. */
export const DONE_SUMMARY_MAX_BYTES = 8 * 1024;
const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** Scheduler-governed role colors.  Keep this palette in the shared package
 * so the API, canvas renderer, and transfer surfaces agree on the same
 * syntax and reserved semantic colors. */
export const ROLE_UI_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const ROLE_UI_COLOR_RESERVED = [
  "#2dd4bf", // task
  "#38bdf8", // intent
  "#a78bfa", // hub
  "#fb7185", // finding
  "#f59e0b", // legacy subagent fallback
  "#34d399", // verify
  "#22d3ee", // fact
  "#818cf8", // report
  "#f97316", // human
  "#94a3b8", // note
] as const;
export const ROLE_UI_COLOR_ASSIGNABLE = [
  "#e879f9",
  "#facc15",
  "#a3e635",
  "#4ade80",
  "#fb923c",
  "#f472b6",
  "#c084fc",
  "#93c5fd",
  "#bef264",
  "#67e8f9",
  "#fda4af",
  "#d8b4fe",
  "#fdba74",
  "#86efac",
  "#fde047",
  "#5eead4",
  "#c4b5fd",
  "#f9a8d4",
  "#7dd3fc",
  "#d9f99d",
  "#f0abfc",
  "#fed7aa",
  "#bbf7d0",
  "#fef08a",
] as const;

/** 通用客户端上下文预算；不会提升上游模型能力。 */
export const CONTEXT_WINDOW_TOKENS_MIN = 1024;
export const CONTEXT_WINDOW_TOKENS_MAX = 10_000_000;
export const ContextWindowTokens = z.number().int().safe().min(CONTEXT_WINDOW_TOKENS_MIN).max(CONTEXT_WINDOW_TOKENS_MAX).nullable();
export type ContextWindowTokens = z.infer<typeof ContextWindowTokens>;
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

const findingProfileName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/);

export const FindingProtocolMode = z.enum(["fixed", "agent_choice", "hybrid"]);
export type FindingProtocolMode = z.infer<typeof FindingProtocolMode>;

export const FindingScoringPolicy = z
  .object({
    default_standard: z.literal("CVSS").default("CVSS"),
    default_version: z.string().min(1).max(20).default("3.1"),
    accepted_versions: z.array(z.string().min(1).max(20)).min(1).max(10).default(["3.1", "4.0"]),
    require_scoring_for_profiles: z.array(findingProfileName).max(50).default(["security.vulnerability"]),
  })
  .strict();
export type FindingScoringPolicy = z.infer<typeof FindingScoringPolicy>;

/** Partial policy stored at a configuration layer. Lists replace inherited
 * lists so a task can narrow policy without a lower layer widening it. */
export const FindingProtocolConfig = z
  .object({
    mode: FindingProtocolMode.optional(),
    default_profile: findingProfileName.optional(),
    allowed_profiles: z.array(findingProfileName).min(1).max(50).optional(),
    scoring: FindingScoringPolicy.partial().strict().optional(),
    display_name: nonEmptyText(100).optional(),
  })
  .strict();
export type FindingProtocolConfig = z.infer<typeof FindingProtocolConfig>;

export const EffectiveFindingProtocol = z
  .object({
    mode: FindingProtocolMode,
    default_profile: findingProfileName,
    allowed_profiles: z.array(findingProfileName).min(1).max(50),
    scoring: FindingScoringPolicy,
    display_name: nonEmptyText(100),
    source: z.enum(["global", "project", "task"]),
  })
  .strict();
export type EffectiveFindingProtocol = z.infer<typeof EffectiveFindingProtocol>;

export const FindingScoringProposal = z
  .object({
    standard: z.literal("CVSS"),
    version: z.string().min(1).max(20),
    vector: z.string().min(1).max(1000),
    metrics: z.record(z.string(), z.unknown()).optional(),
    /** Accepted only for comparison/audit; Scheduler always recomputes. */
    base_score: z.number().min(0).max(10).optional(),
  })
  .strict();
export type FindingScoringProposal = z.infer<typeof FindingScoringProposal>;

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

/** 画布 Fact 的人工验证态；与 Finding 技术验证状态相互独立。 */
export const FactVerificationStatus = z.enum([
  "unverified",
  "verifying",
  "verified",
  "rejected",
  "needs_human",
]);
export type FactVerificationStatus = z.infer<typeof FactVerificationStatus>;

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

/** Canvas-level drain pause. Pending Jobs are durable queue entries, not work
 * that still needs to drain, so they are projected separately. */
export const TaskExecutionState = z.enum(["pausing", "paused", "running"]);
export type TaskExecutionState = z.infer<typeof TaskExecutionState>;

export const TaskExecutionControl = z.object({
  paused: z.boolean(),
  paused_at: z.string().nullable(),
  paused_by: z.string().nullable(),
  reason: z.string().nullable(),
});
export type TaskExecutionControl = z.infer<typeof TaskExecutionControl>;

export const TaskExecutionControlResult = z.object({
  canvas_id: z.string().uuid(),
  execution_state: TaskExecutionState,
  active_count: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  changed: z.boolean(),
});
export type TaskExecutionControlResult = z.infer<typeof TaskExecutionControlResult>;

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

const meaningfulText = (min: number, max: number) =>
  z.string().min(min).max(max).regex(/\S/).refine((value) => value.trim().length >= min, `must contain at least ${min} nonblank characters`);
const meaningfulFindingTitle = meaningfulText(8, 500);
const meaningfulFindingSummary = meaningfulText(32, 10000);
const meaningfulFactTitle = meaningfulText(2, 200);
const meaningfulFactDescription = meaningfulText(16, 10000);

export const FindingPayload = z
  .object({
    title: meaningfulFindingTitle,
    profile: findingProfileName.optional(),
    category: findingProfileName.optional(),
    tags: z.array(nonEmptyText(100)).max(50).optional(),
    evidence_refs: z.array(nonEmptyText(2000)).max(50).optional(),
    severity: Severity.optional(),
    scoring: FindingScoringProposal.optional(),
    location: z.string().max(1000).regex(/\S/).optional(), // "auth/login.php:42" ← SARIF artifactLocation + region
    summary: meaningfulFindingSummary.optional(),
    rule_id: z.string().max(200).regex(/\S/).optional(), // SARIF ruleId
    /** 兼容字段：是否验证由调度器决定，不再影响派生。 */
    suggest_verify: z.boolean().default(false),
    raw: z.record(z.string(), z.unknown()).optional(), // SARIF result 原文
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.summary === undefined) {
      ctx.addIssue({ code: "custom", path: ["summary"], message: "Finding summary is required and must contain at least 32 nonblank characters" });
    }
  });
export type FindingPayload = z.infer<typeof FindingPayload>;

/** Agent-facing Finding contract.  SARIF/raw is Scheduler-owned internal data
 * and is intentionally not writable through the control MCP. */
export const EmitFindingDirectPayload = z
  .object({
    title: meaningfulFindingTitle,
    profile: findingProfileName.optional(),
    category: findingProfileName.optional(),
    tags: z.array(nonEmptyText(100)).max(50).optional(),
    evidence_refs: z.array(nonEmptyText(2000)).max(50).optional(),
    severity: Severity.optional(),
    scoring: FindingScoringProposal.optional(),
    location: z.string().max(1000).regex(/\S/).optional(),
    summary: meaningfulFindingSummary,
    rule_id: z.string().max(200).regex(/\S/).optional(),
    suggest_verify: z.boolean().optional(),
  })
  .strict();
export type EmitFindingDirectPayload = z.infer<typeof EmitFindingDirectPayload>;

export const EmitFindingPayload = z
  .object({
    title: meaningfulFindingTitle.optional(),
    profile: findingProfileName.optional(),
    category: findingProfileName.optional(),
    tags: z.array(nonEmptyText(100)).max(50).optional(),
    evidence_refs: z.array(nonEmptyText(2000)).max(50).optional(),
    severity: Severity.optional(),
    scoring: FindingScoringProposal.optional(),
    location: z.string().max(1000).regex(/\S/).optional(),
    summary: meaningfulFindingSummary.optional(),
    rule_id: z.string().max(200).regex(/\S/).optional(),
    suggest_verify: z.boolean().optional(),
    payload_file: z.string().min(1).max(200).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasFile = value.payload_file !== undefined;
    const hasDirect = Object.keys(value).some((key) => key !== "payload_file");
    if (hasFile === hasDirect) {
      ctx.addIssue({ code: "custom", path: hasFile ? ["payload_file"] : [], message: "emit_finding must provide exactly one of direct fields or payload_file" });
      return;
    }
    if (!hasFile && value.title === undefined) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "Finding title is required" });
    }
    if (!hasFile && value.summary === undefined) {
      ctx.addIssue({ code: "custom", path: ["summary"], message: "Finding summary is required" });
    }
  });
export type EmitFindingPayload = z.infer<typeof EmitFindingPayload>;

/** 角色 agent 的 fact 提案；verification 仅在 Hub 回弹补证 Job 上被接受。 */
export const FactPayload = z
  .object({
    title: meaningfulFactTitle,
    description: meaningfulFactDescription,
    /** Scheduler-owned association; Agent input is ignored and overwritten. */
    intent_node_id: z.string().uuid().nullable().optional(),
    verification: VerificationEvidence.optional(),
  })
  .strict();
export type FactPayload = z.infer<typeof FactPayload>;

/** Control-tool input contracts.  These schemas are the single source used by
 * the Scheduler boundary and the generated in-sandbox MCP JSON Schema. */
export const EmitFactDirectPayload = z
  .object({
    title: meaningfulFactTitle,
    description: meaningfulFactDescription,
    verification: VerificationEvidence.optional(),
  })
  .strict();
export type EmitFactDirectPayload = z.infer<typeof EmitFactDirectPayload>;

export const EmitFactPayload = z
  .object({
    title: meaningfulFactTitle.optional(),
    description: meaningfulFactDescription.optional(),
    verification: VerificationEvidence.optional(),
    payload_file: z.string().min(1).max(200).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasFile = value.payload_file !== undefined;
    const hasDirect = Object.keys(value).some((key) => key !== "payload_file");
    if (hasFile === hasDirect) {
      ctx.addIssue({ code: "custom", path: hasFile ? ["payload_file"] : [], message: "emit_fact must provide exactly one of direct fields or payload_file" });
      return;
    }
    if (!hasFile && value.title === undefined) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "Fact title is required" });
    }
    if (!hasFile && value.description === undefined) {
      ctx.addIssue({ code: "custom", path: ["description"], message: "Fact description is required" });
    }
  });
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
    reason: meaningfulText(8, 2000),
    subject: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("finding"),
          finding_id: z.string().uuid(),
          subject_revision: nonEmptyText(500),
        })
        .strict(),
      z
        .object({
          type: z.literal("platform_blocker"),
          kind: z.enum(["authorization", "credential", "high_risk_action", "business_decision"]),
        })
        .strict(),
    ]),
  })
  .strict();
export type HumanPayload = z.infer<typeof HumanPayload>;

export const DonePayload = z
  .object({
    summary: meaningfulText(8, DONE_SUMMARY_MAX_BYTES).refine(
      (value) => utf8ByteLength(value) <= DONE_SUMMARY_MAX_BYTES,
      `summary must not exceed ${DONE_SUMMARY_MAX_BYTES} UTF-8 bytes`,
    ),
    verdict: VerifyVerdict.optional(),
    // Keep evidence labels canonical at the shared boundary: surrounding
    // whitespace is removed, while blank/whitespace-only entries are rejected.
    missing_evidence: z.array(z.string().trim().min(1).max(200).regex(/\S/)).max(8).optional(),
  })
  .strict();
export type DonePayload = z.infer<typeof DonePayload>;

export const ListAvailableRolesPayload = z.object({}).strict();
export type ListAvailableRolesPayload = z.infer<typeof ListAvailableRolesPayload>;

export const ListAvailableRuntimeImagesPayload = z.object({}).strict();
export type ListAvailableRuntimeImagesPayload = z.infer<typeof ListAvailableRuntimeImagesPayload>;

export const ListSharedAssetsPayload = z.object({
  scope: z.enum(["platform", "project", "finding"]).optional(),
  prefix: z.string().trim().min(1).max(120).optional(),
  // Host listSharedAssets caps at 100.
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
}).strict();
export type ListSharedAssetsPayload = z.infer<typeof ListSharedAssetsPayload>;

export const PublishSharedAssetPayload = z.object({
  scope: z.enum(["project", "finding"]),
  source_path: z.string().min(1).max(320).regex(
    /^\/workspace\/(?!\.(?:deepsonar(?:-home)?|claude|codex|opencode|pi)(?:\/|$)).+/,
  ),
  key: z.string().trim().min(1).max(240),
  content_type: z.string().trim().min(1).max(160).default("application/octet-stream"),
  labels: z.record(z.string().min(1).max(60), z.string().max(200)).optional(),
}).strict();
export type PublishSharedAssetPayload = z.infer<typeof PublishSharedAssetPayload>;

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
  kind: z.enum(["llm_provider", "git", "oci_registry"]),
  provider: z.string(),
  provider_valid: z.boolean(),
  project_id: z.string().uuid().nullable(),
  status: z.enum(["active", "disabled", "rotation_required"]),
});
export type ReadinessCredentialSummary = z.infer<typeof ReadinessCredentialSummary>;

/** Server-owned Provider account catalog. Secrets and environment variable names
 * are intentionally absent; the scheduler decides the auth mapping. */
export const ProviderAccountCatalogItem = z.object({
  provider: z.string().min(1).max(50),
  label: z.string().min(1).max(120),
  kind: z.enum(["llm_provider", "git", "oci_registry"]),
  auth_methods: z.array(z.enum(["api_key", "oauth", "cli_login"])).min(1),
  compatible_agent_cli: z.array(z.string().min(1).max(50)),
  supports_base_url: z.boolean(),
}).strict();
export type ProviderAccountCatalogItem = z.infer<typeof ProviderAccountCatalogItem>;

/** One transaction applies an account binding/migration to many RoleConfigs. */
export const CredentialBatchBindingRequest = z.object({
  credential_id: z.string().uuid(),
  role_config_ids: z.array(z.string().uuid()).min(1).max(100),
  mode: z.enum(["bind", "migrate"]).default("bind"),
  source_credential_id: z.string().uuid().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  effect: z.enum(["new_jobs_only", "refresh_pending"]).default("new_jobs_only"),
  idempotency_key: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
}).superRefine((value, ctx) => {
  if (new Set(value.role_config_ids).size !== value.role_config_ids.length) {
    ctx.addIssue({ code: "custom", path: ["role_config_ids"], message: "role_config_ids must be unique" });
  }
  if (value.mode === "migrate" && !value.source_credential_id) {
    ctx.addIssue({ code: "custom", path: ["source_credential_id"], message: "source_credential_id is required for migration" });
  }
  if (value.source_credential_id && value.source_credential_id === value.credential_id) {
    ctx.addIssue({ code: "custom", path: ["source_credential_id"], message: "source and target credentials must differ" });
  }
}).strict();
export type CredentialBatchBindingRequest = z.infer<typeof CredentialBatchBindingRequest>;

export const CredentialBatchBindingImpact = z.object({
  mode: z.enum(["bind", "migrate"]),
  effect: z.enum(["new_jobs_only", "refresh_pending"]),
  credential_id: z.string().uuid(),
  source_credential_id: z.string().uuid().nullable(),
  role_config_count: z.number().int().nonnegative(),
  pending_job_count: z.number().int().nonnegative(),
  refreshed_pending_job_count: z.number().int().nonnegative(),
  active_frozen_job_count: z.number().int().nonnegative(),
  terminal_historical_job_count: z.number().int().nonnegative(),
  leftover_project_models_unchanged: z.boolean().default(false),
  role_configs: z.array(z.object({
    role_config_id: z.string().uuid(),
    role_name: z.string(),
    scope: z.enum(["global", "project"]),
    project_id: z.string().uuid().nullable(),
    model: z.string().nullable(),
    model_changed: z.boolean().default(false),
    inherit_global_ignores_project_model: z.boolean().default(false),
  })).max(100),
}).strict();
export type CredentialBatchBindingImpact = z.infer<typeof CredentialBatchBindingImpact>;

/** Stable, server-owned repair guidance returned before a binding transaction mutates state. */
export const CredentialBatchBindingErrorCode = z.enum([
  "BATCH_REQUEST_INVALID",
  "BATCH_TRANSACTION_FAILED",
  "CREDENTIAL_NOT_FOUND",
  "CREDENTIAL_KIND_INVALID",
  "CREDENTIAL_NOT_ACTIVE",
  "CREDENTIAL_PROVIDER_INVALID",
  "CREDENTIAL_CLI_INCOMPATIBLE",
  "CREDENTIAL_HEALTH_REQUIRED",
  "CREDENTIAL_MODEL_CATALOG_REQUIRED",
  "CREDENTIAL_MODEL_CATALOG_UNSUPPORTED",
  "CREDENTIAL_MODEL_REQUIRED",
  "CREDENTIAL_MODEL_NOT_CURRENT",
  "ROLE_CONFIG_NOT_FOUND",
  "ROLE_CONFIG_SOURCE_MISMATCH",
  "PROJECT_SCOPE_FORBIDDEN",
  "IDEMPOTENCY_KEY_REUSED",
]);
export type CredentialBatchBindingErrorCode = z.infer<typeof CredentialBatchBindingErrorCode>;

export const CredentialBatchBindingRepairAction = z.enum([
  "activate_credential",
  "repair_provider",
  "test_connection",
  "discover_models",
  "choose_model",
  "choose_project_credential",
  "choose_project_role_config",
]);
export type CredentialBatchBindingRepairAction = z.infer<typeof CredentialBatchBindingRepairAction>;

export const CredentialBatchBindingError = z.object({
  error_code: CredentialBatchBindingErrorCode,
  error: z.string().min(1).max(300),
  field: z.string().min(1).max(80).optional(),
  repair: z.object({
    action: CredentialBatchBindingRepairAction,
    credential_id: z.string().uuid(),
    role_config_id: z.string().uuid().optional(),
  }).optional(),
}).strict();
export type CredentialBatchBindingError = z.infer<typeof CredentialBatchBindingError>;

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
  runtime_image_id: z.string().uuid().nullable().optional(),
  selected_version_id: z.string().uuid().nullable().optional(),
  selected_version: z.string().nullable().optional(),
  latest_version_id: z.string().uuid().nullable().optional(),
  latest_version: z.string().nullable().optional(),
  pin_stale: z.boolean().optional(),
  /** Immutable digest reference the host must already have locally. */
  image_ref: z.string().nullable().optional(),
  /** Executable catalog version label (not necessarily the project pin). */
  version: z.string().nullable().optional(),
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

/**
 * Hub 对一个 Worker 的结构化下发。prompt 是真正注入 CLI 的本轮用户消息。
 *
 * description/prompt 设有最小长度：拦截模型流式 tool_use 被截断后仍通过
 * schema_validated 的半截意图（实战中曾出现 description="拉"、prompt="你"）。
 */
export const HubIntentPayload = z
  .object({
    from: HubReferenceList,
    role: nonEmptyText(64),
    description: z.string().min(8).max(2_000).regex(/\S/),
    prompt: z.string().min(32).max(20_000).regex(/\S/),
    // Hub 本轮可选的运行镜像提案：只能来自 list_available_runtime_images 返回的
    // 市场 image_key（与 runtime_images.image_key 的 CHECK 同形），不是 OCI 引用。
    // 省略时 Scheduler 按项目镜像策略与 RoleConfig 缺省解析。
    runtime_image_key: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/).optional(),
  })
  .strict();
export type HubIntentPayload = z.infer<typeof HubIntentPayload>;

export const HubCompletePayload = z
  .object({
    from: HubReferenceList,
    description: z.string().min(8).max(10_000).regex(/\S/),
  })
  .strict();
export type HubCompletePayload = z.infer<typeof HubCompletePayload>;

/**
 * Relative workspace path for large hub decisions that do not fit tool_use args.
 * Must stay under /workspace; no absolute paths, drive letters, or `..` segments.
 */
export const HubDecisionPayloadFile = z
  .string()
  .min(1)
  .max(200)
  .regex(WORKSPACE_PAYLOAD_FILE_PATTERN, "payload_file must be a safe relative path under /workspace");
export type HubDecisionPayloadFile = z.infer<typeof HubDecisionPayloadFile>;

/**
 * Hub decision payload.
 *
 * Must stay a **single object** schema (not z.union): Claude Code / Anthropic MCP
 * skips tools whose inputSchema uses top-level anyOf/oneOf
 * ("its input schema uses top-level anyOf, which the Anthropic API does not accept").
 * Mutual exclusivity of complete vs intents vs payload_file is enforced in superRefine
 * and again by the Job control API host. `payload_file` is a temporary bypass for tool_use
 * truncation of large multi-intent JSON: write the full decision under /workspace
 * then pass only the relative path.
 */
export const HubDecisionPayload = z
  .object({
    complete: HubCompletePayload.optional(),
    intents: z.array(HubIntentPayload).min(1).max(100).optional(),
    payload_file: HubDecisionPayloadFile.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasComplete = value.complete !== undefined;
    const hasIntents = value.intents !== undefined;
    const hasFile = value.payload_file !== undefined;
    if ((hasComplete ? 1 : 0) + (hasIntents ? 1 : 0) + (hasFile ? 1 : 0) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: hasComplete && hasIntents ? ["complete"] : hasFile ? ["payload_file"] : [],
        message: "submit_hub_decision must provide exactly one of complete, intents, or payload_file",
      });
      return;
    }
    if (hasFile) return;
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

export const AckHumanMessagePayload = z.object({
  message_id: z.string().uuid(),
  summary: z.string().max(500).regex(/\S/u).optional(),
}).strict();
export type AckHumanMessagePayload = z.infer<typeof AckHumanMessagePayload>;

export const ControlToolPayloadSchemas = {
  list_available_roles: ListAvailableRolesPayload,
  list_available_runtime_images: ListAvailableRuntimeImagesPayload,
  list_shared_assets: ListSharedAssetsPayload,
  publish_shared_asset: PublishSharedAssetPayload,
  emit_progress: ProgressPayload,
  emit_fact: EmitFactPayload,
  emit_finding: EmitFindingPayload,
  submit_hub_decision: HubDecisionPayload,
  mark_job_done: DonePayload,
  request_human: HumanPayload,
  ack_human_message: AckHumanMessagePayload,
} as const;
export type ControlToolPayload = {
  [K in keyof typeof ControlToolPayloadSchemas]: z.infer<(typeof ControlToolPayloadSchemas)[K]>;
};

/**
 * Normalize Zod → JSON Schema for MCP tools/list.
 * Anthropic / Claude Code reject tools when inputSchema:
 * - lacks top-level type: "object", or
 * - uses top-level anyOf / oneOf (even with type: object).
 */
export function toMcpToolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  if (json.type !== "object") {
    throw new Error(
      `MCP inputSchema must serialize to type:object (got type=${String(json.type)}; keys=${Object.keys(json).join(",")})`,
    );
  }
  if (Array.isArray(json.anyOf) || Array.isArray(json.oneOf)) {
    throw new Error(
      "MCP inputSchema must not use top-level anyOf/oneOf (Anthropic API rejects them; restructure the Zod contract to a single object)",
    );
  }
  return json;
}

/** JSON Schema emitted for MCP tools/list from the same Zod contracts. */
export const ControlToolInputSchemasJson = Object.fromEntries(
  Object.entries(ControlToolPayloadSchemas).map(([name, schema]) => [
    name,
    toMcpToolInputSchema(schema),
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
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("finding"), payload: EmitFindingDirectPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("done"), payload: DonePayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("human"), payload: HumanPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("fact"), payload: EmitFactDirectPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("human_message_ack"), payload: AckHumanMessagePayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("hub_decision"), payload: HubDecisionPayload }).strict(),
  z.object({ v: z.literal(1), event_id: z.string().uuid(), type: z.literal("shared_asset_publish"), payload: PublishSharedAssetPayload }).strict(),
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
  "list_available_runtime_images",
  "emit_progress",
  "emit_fact",
  "emit_finding",
  "submit_hub_decision",
  "mark_job_done",
  "request_human",
  "list_shared_assets",
  "publish_shared_asset",
  "ack_human_message",
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

/**
 * 平台工具全集（顺序固定，供 UI / 快照 / 校验共用）。
 * 每个 Agent 默认都可勾选其中任意项；是否真正注入以 RoleConfig 开关 + Job 快照为准。
 */
export const ALL_PLATFORM_TOOLS: PlatformToolName[] = [
  "list_available_roles",
  "list_available_runtime_images",
  "list_shared_assets",
  "publish_shared_asset",
  "emit_progress",
  "emit_fact",
  "emit_finding",
  "submit_hub_decision",
  "mark_job_done",
  "request_human",
  "ack_human_message",
];

/**
 * 一个角色有资格启用的工具。
 * 现策略：平台工具 list 对所有 Agent 开放；未列出的名字仍拒绝。
 * roleName/roleKind 保留入参以兼容调用方，不再按角色裁剪可选集合。
 */
export function allowedPlatformTools(
  _roleName: string,
  _roleKind: "role" | "hub" | "system",
): PlatformToolName[] {
  return ALL_PLATFORM_TOOLS.slice();
}

/** These Job-wide control capabilities cannot be disabled by RoleConfig. */
export function requiredPlatformTools(_roleKind: "role" | "hub" | "system"): PlatformToolName[] {
  return ["mark_job_done", "ack_human_message"];
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
export {
  PI_EXTENSION_IMAGE_ROOT,
  PI_EXTENSION_MAX_PER_ROLE,
  PI_EXTENSION_REGISTRY,
  PI_EXTENSION_SANDBOX_PREFIX,
  PI_EXTENSION_WORKSPACE_DIR,
  PiExtensionId,
  isRegisteredPiExtensionId,
  parsePiExtensionIds,
  piExtensionImageEntryPath,
  piExtensionSandboxPath,
  piExtensionWorkspacePath,
  registeredPiExtension,
  validatePiExtensionIds,
  type PiExtensionRegistration,
  type RegisteredPiExtensionId,
} from "./pi-extensions.js";

export async function computeFingerprint(
  input: { title: string; location?: string; rule_id?: string },
  digest: (s: string) => Promise<string> | string,
): Promise<string> {
  const norm = [input.title.trim().toLowerCase(), (input.location ?? "").trim(), (input.rule_id ?? "").trim()].join(
    "|",
  );
  return digest(norm);
}
