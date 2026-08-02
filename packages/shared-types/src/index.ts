import { z } from "zod";

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
export const VerificationEvidence = z.object({
  finding_id: z.string().uuid(),
  evidence_kind: z.enum(["review", "test"]),
  outcome: z.enum(["supports", "refutes", "inconclusive"]),
  subject_revision: z.string().min(1).max(500),
  environment: z.string().max(1000).optional(),
  steps: z.array(z.string().max(2000)).max(50).optional(),
  expected: z.string().max(5000).optional(),
  actual: z.string().max(5000).optional(),
  artifact_refs: z
    .array(
      z.object({
        uri: z.string().min(1).max(2000),
        sha256: z.string().max(128).optional(),
      }),
    )
    .max(20)
    .optional(),
  limitations: z.array(z.string().max(1000)).max(20).optional(),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;

export const NodeType = z.enum(["root", "job", "finding", "note", "human", "intent", "fact", "report"]);
export type NodeType = z.infer<typeof NodeType>;

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

export const FindingPayload = z.object({
  title: z.string().min(1).max(500),
  severity: Severity,
  location: z.string().max(1000).optional(), // "auth/login.php:42" ← SARIF artifactLocation + region
  summary: z.string().max(10000).optional(),
  rule_id: z.string().max(200).optional(), // SARIF ruleId
  /** 兼容字段：是否验证由调度器决定，不再影响派生。 */
  suggest_verify: z.boolean().default(false),
  raw: z.record(z.string(), z.unknown()).optional(), // SARIF result 原文
});
export type FindingPayload = z.infer<typeof FindingPayload>;

/** 角色 agent 的 fact 提案；verification 仅在 Hub 回弹补证 Job 上被接受。 */
export const FactPayload = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(10000),
  intent_node_id: z.string().uuid().optional(),
  verification: VerificationEvidence.optional(),
});
export type FactPayload = z.infer<typeof FactPayload>;

// ---------- 事件 envelope（§17.3 版本化） ----------

export const EventEnvelope = z.object({
  v: z.literal(1),
  event_id: z.string().uuid(),
  type: EventType,
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

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

/** Hub 对一个 Worker 的结构化下发。prompt 是真正注入 CLI 的本轮用户消息。 */
export const HubIntentPayload = z.object({
  from: z.array(z.string()).default([]),
  role: z.string().min(1).max(64),
  description: z.string().min(1).max(2_000),
  prompt: z.string().min(1).max(20_000),
});
export type HubIntentPayload = z.infer<typeof HubIntentPayload>;

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

/** 一个角色有资格启用的工具；未列出的工具即使配置为 true 也必须拒绝。 */
export function allowedPlatformTools(
  roleName: string,
  roleKind: "role" | "hub" | "system",
): PlatformToolName[] {
  return [
    ...(roleKind === "hub" ? (["list_available_roles"] as PlatformToolName[]) : []),
    "emit_progress",
    ...(roleKind === "role" && roleName !== "audit" ? (["emit_fact"] as PlatformToolName[]) : []),
    ...(roleName === "audit" ? (["emit_finding"] as PlatformToolName[]) : []),
    ...(roleKind === "hub" ? (["submit_hub_decision"] as PlatformToolName[]) : []),
    "mark_job_done",
    "request_human",
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
