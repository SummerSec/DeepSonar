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

export const JobType = z.enum([
  "noop", // Phase 0 骨架验证用
  "audit_module",
  "verify_finding",
  "hub_reason", // hub：读图 → 决策（complete / 派发 intents）
  "audit", // Hub 可派发的审计角色：产出 Finding
  "explore", // 角色 agent：围绕意图探索 → 产出事实（Phase ② 角色注册后 type 可为用户自定义角色名）
]);
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

export const NodeType = z.enum(["root", "job", "finding", "note", "human", "intent", "fact"]);
export type NodeType = z.infer<typeof NodeType>;

export const EdgeType = z.enum(["child", "produces", "verifies", "next", "from", "to"]);
export type EdgeType = z.infer<typeof EdgeType>;

// ---------- Finding payload（SARIF 2.1.0 子集，见 ARCHITECTURE §6.1） ----------

export const FindingPayload = z.object({
  title: z.string().min(1).max(500),
  severity: Severity,
  location: z.string().max(1000).optional(), // "auth/login.php:42" ← SARIF artifactLocation + region
  summary: z.string().max(10000).optional(),
  rule_id: z.string().max(200).optional(), // SARIF ruleId
  suggest_verify: z.boolean().default(false),
  raw: z.record(z.string(), z.unknown()).optional(), // SARIF result 原文
});
export type FindingPayload = z.infer<typeof FindingPayload>;

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
