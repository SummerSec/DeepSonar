import path from "node:path";
import {
  EffectiveFindingProtocol as EffectiveFindingProtocolSchema,
  FindingProtocolConfig as FindingProtocolConfigSchema,
  CANONICAL_UUID_PATTERN,
  type EventEnvelopeInput,
  type EffectiveFindingProtocol,
} from "@deepsonar/shared-types";
import { config } from "./config.js";
import { isProviderKnown } from "./credentials.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import {
  PLATFORM_DEFAULT_AGENT_CLI,
  PLATFORM_DEFAULT_AGENT_MODEL,
  RUNTIME_TEST_TOOLCHAIN_POLICY,
  createRoleRuntimeSnapshotApplication,
  freezeAgentSnapshotNetworkPolicy,
  roleNameForJobType as roleNameForRuntimeType,
  withRuntimeTestToolchainPolicy,
  type AgentRuntimeSnapshot,
  type ReasoningEffort,
} from "./domains/role-runtime-snapshot/index.js";
import {
  canTransition as canJobTransition,
  transitionJob as applyJobTransition,
} from "./domains/job-lifecycle/index.js";
import {
  createEventIngestionApplication,
  createEventIngestionSideEffectApplication,
  type EventIngestionResult,
  type EventSideEffectServices,
} from "./domains/event-ingestion/index.js";
import {
  createHubOrchestrationApplication,
  shouldWakeEvidenceHub as hubShouldWakeEvidenceHub,
  type HubHumanCommentInput,
  type HubHumanCommentResult,
  type HubJobRecord,
  type HubTriggerOptions,
  type HubCanvasJobTerminalStatus,
  type HubAnalysisCompleteGate,
} from "./domains/hub-orchestration/index.js";
import { resolveFindingProtocol } from "./finding-protocol.js";
import * as findingVerificationLegacy from "./verify.js";
import * as reportConvergenceLegacy from "./report.js";
import { revokeJobTokens } from "./gateway.js";
import { revokeJobCapabilityTokens } from "./domains/platform-api/tokens.js";
import {
  createFindingVerificationApplication,
  type FindingVerificationLegacyPort,
} from "./domains/finding-verification/index.js";
import { createReportConvergenceApplication } from "./domains/report-convergence/index.js";
import { settleAttemptTerminal } from "./domains/job-attempt/index.js";
import { recordJobSharedAssets, resolveSharedAssetSelection } from "./domains/shared-assets/index.js";
import { freezeTaskSeedTarget, insertTaskSeedProjections } from "./task-compose.js";

export { sha16 } from "./domains/event-ingestion/index.js";

export {
  PLATFORM_DEFAULT_AGENT_CLI,
  PLATFORM_DEFAULT_AGENT_MODEL,
  RUNTIME_TEST_TOOLCHAIN_POLICY,
  withRuntimeTestToolchainPolicy,
} from "./domains/role-runtime-snapshot/index.js";
export const roleNameForJobType = roleNameForRuntimeType;
export type { AgentRuntimeSnapshot, ReasoningEffort } from "./domains/role-runtime-snapshot/index.js";

const findingVerificationApplication = createFindingVerificationApplication(
  findingVerificationLegacy as unknown as FindingVerificationLegacyPort,
);
const reportConvergenceApplication = createReportConvergenceApplication(reportConvergenceLegacy);
const roleRuntimeSnapshotApplication = createRoleRuntimeSnapshotApplication();

type Tx = typeof sql;
export type IngestResult = EventIngestionResult;

// ---------- Job lifecycle compatibility facade ----------
//
// Existing callers keep importing these names from core while the bounded
// context owns the policy and SQL application seam.  Keep this facade narrow
// until dispatcher/reaper/reconcile migrate explicitly in later slices.
export const canTransition = canJobTransition;

/**
 * Atomic status transition.  A null result still means a race or illegal
 * source state; callers must not continue provisioning or terminal side
 * effects when the guarded update did not win.
 */
export async function transitionJob(jobId: string, to: string, patch: Record<string, unknown> = {}) {
  return applyJobTransition(jobId, to, patch);
}

/**
 * The publish callback is host-authorized, but the sandbox can still deliver
 * a late event after cancellation or lease expiry. Keep the check on the
 * scheduler connection and bind it to the execution's current sandbox.
 */
export async function assertJobCanPublishSharedAsset(jobId: string, sandboxId: string | null): Promise<void> {
  const [row] = await sql`
    SELECT id
      FROM jobs
     WHERE id = ${jobId}
       AND status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at > now()
       AND sandbox_id IS NOT NULL
       AND sandbox_id = ${sandboxId}
     FOR UPDATE
  `;
  if (!row) throw new Error("shared_asset_publish_job_not_running");
}

// Event-ingestion owns append/dedup/sequence ordering. Semantic event writes
// are composed through the event-ingestion bounded context's typed ports.
const eventIngestionSideEffectApplication = createEventIngestionSideEffectApplication({
  findingVerification: findingVerificationApplication,
  rulesForProject: async (tx, projectId) => rulesForProject(tx as unknown as typeof sql, projectId),
  rolesForProject: async (tx, projectId) => rolesForProject(tx as unknown as typeof sql, projectId),
  resolveAgentSnapshotForJob: async (tx, projectId, type, findingIds = []) =>
    resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, type, findingIds),
  recordJobSharedAssets: async (tx, jobId, assets) => recordJobSharedAssets(tx as unknown as typeof sql, jobId, assets),
  fixedPriorityForJob,
  insertEdgeIfAbsent: async (tx, canvasId, fromId, toId, edgeType) =>
    insertEdgeIfAbsent(tx as Tx, canvasId, fromId, toId, edgeType),
  insertEdgesIfAbsentBatch: async (tx, edges) => insertEdgesIfAbsentBatch(tx as Tx, edges),
  findingProtocolForJob: async (tx, job) => findingProtocolForJob(tx as Tx, job),
  finalizeJob: async (tx, jobId, status, result) => finalizeJob(tx as Tx, jobId, status, result),
});

const eventIngestionApplication = createEventIngestionApplication(
  sql,
  async (tx, jobId, envelope) => {
    await eventIngestionSideEffectApplication.applySideEffects(tx as Tx, jobId, envelope.type, envelope.payload);
  },
  {
    maxPayloadBytes: config.events.payloadMaxKb * 1024,
    rateLimit: {
      windowSeconds: config.events.rateLimitWindowSec,
      progressPerWindow: config.events.rateLimitProgressPerWindow,
      standardPerWindow: config.events.rateLimitStandardPerWindow,
      terminalPerWindow: config.events.rateLimitTerminalPerWindow,
    },
    onRateLimited: (error) => {
      inc("deepsonar_event_rate_limited_total", { bucket: error.bucket });
    },
  },
);

// ---------- 项目规则（决策层）：projects.config_json.rules 覆盖 + env 兜底 ----------
//
// 第一性原理：用户只配「最低关注级别」一件事。
// 派生（写死，不暴露配置）：
//   · 达到 minVerifySeverity 的 Finding 才进入自动 Verify 生命周期
//   · 低于阈值的 Finding 保持 pending 并记录策略标记，且不阻塞收敛
//   · Hub 等 care verify 跑完再决策（含 confirmed）
//   · verify 调度永远 critical > high > …

/** 严重度从高到低；minVerifySeverity=high 表示 critical+high */
export const SEVERITY_RANK = ["critical", "high", "medium", "low", "info"] as const;
export type SeverityRank = (typeof SEVERITY_RANK)[number];

export interface ProjectRules {
  /**
   * 关注级别旋钮：控制自动 Verify 范围、队列优先级与 Hub 等待门（≥ 该级别）。
   * info 表示对所有带 severity 的 Finding 启用严格全量 Verify。
   */
  minVerifySeverity: SeverityRank;
  maxFollowupsPerJob: number;
  maxFollowupDepth: number;
  maxAutoRetries: number;
  /** Finding 业务验证轮次上限（与 maxAutoRetries 基础设施重试分离）；默认 3。 */
  maxVerificationRounds: number;
  auditTimeoutSec: number;
  verifyTimeoutSec: number;
  hubEnabled: boolean;
  maxHubRounds: number;
  maxIntentsPerDecision: number;
  allowEgress: boolean;
  /** Scheduler-wide active job cap. The persisted global rule is authoritative; env is bootstrap fallback. */
  maxGlobalJobs: number;
  /** Scheduler-wide per-project active job cap. The persisted global rule is authoritative; env is bootstrap fallback. */
  maxJobsPerProject: number;
  /** Scheduler 全局 provisioning admission 上限，项目规则不得覆盖。 */
  maxConcurrentProvisioning: number;
  /** 全局 Provider 总并发；优先于 Credential / 模型 / Agent CLI 配额。 */
  maxConcurrentByProvider: Record<string, number>;
  /** 全局按 Agent CLI 的并发配额；项目层不得覆盖。 */
  maxConcurrentByAgentCli: Record<string, number>;
}

/** 画布收敛控制态（落在 canvases.target_json.convergence，免 schema 迁移） */
export interface CanvasConvergence {
  hub_paused: boolean;
  paused_reason?: string;
  paused_at?: string;
  auto_stopped: boolean;
  pending_confirmed_ids?: string[];
}

function asSeverityRank(v: unknown, fallback: SeverityRank): SeverityRank {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return (SEVERITY_RANK as readonly string[]).includes(s) ? (s as SeverityRank) : fallback;
}

function asCliLimits(v: unknown, fallback: Record<string, number>): Record<string, number> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fallback;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (!["claude-code", "codex", "open-code", "pi", "dsh"].includes(key)) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) return fallback;
    out[key] = value;
  }
  return out;
}

/**
 * Normalize a scheduler concurrency cap. Caps are deliberately bounded so a
 * malformed value in JSONB cannot disable resource protection. A value of 0
 * is reserved for Agent CLI limits (pause that CLI); global/project caps must
 * remain positive.
 */
export function asConcurrencyLimit(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000 ? v : fallback;
}

function asProviderLimits(v: unknown, fallback: Record<string, number>): Record<string, number> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fallback;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (!isProviderKnown(key) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000)
      return fallback;
    out[key] = value;
  }
  return out;
}

/** env / 旧 autoVerifySeverities 列表 → 最低关注级别（取列表中最「松」的一档） */
function inferMinFromList(list: unknown, fallback: SeverityRank): SeverityRank {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  let maxIdx = 0;
  for (const item of list) {
    const i = SEVERITY_RANK.indexOf(String(item).trim().toLowerCase() as SeverityRank);
    if (i > maxIdx) maxIdx = i;
  }
  return SEVERITY_RANK[maxIdx] ?? fallback;
}

/** ≥ min 的全部 severity（自动验 / Hub 等待 / 停自驱 共用） */
export function careSeverities(min: string): string[] {
  const idx = SEVERITY_RANK.indexOf(asSeverityRank(min, "high"));
  return SEVERITY_RANK.slice(0, idx + 1) as string[];
}

/**
 * 判断 Finding 是否在自动 Verify / 收敛门范围内。
 * severity 是可选协议字段；未评分 Finding 不属于“低于阈值”，保留在
 * 自动验证范围内，避免因缺失严重度而被静默丢弃。
 */
export function isSeverityInVerifyScope(min: string, severity: unknown): boolean {
  const normalized = String(severity ?? "").trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (!(SEVERITY_RANK as readonly string[]).includes(normalized)) return true;
  return careSeverities(min).includes(normalized);
}

/** @deprecated 兼容旧调用名；语义 = careSeverities(rules.minVerifySeverity) */
export function resolveHubWaitSeverities(rules: ProjectRules): string[] {
  return careSeverities(rules.minVerifySeverity);
}

/**
 * Scheduling purpose is frozen into a Job payload at creation time.  It is
 * deliberately a small vocabulary: it explains why a Job exists without
 * letting an Agent invent a numeric queue score.
 */
export type SchedulingPurpose = "hub" | "convergence_evidence" | "discovery" | "verify" | "report" | "manual";

/** Fixed, documented queue classes.  FIFO is provided by created_at/id within
 * a class; these numbers never inherit a parent or Hub round. */
export const FIXED_PRIORITY = Object.freeze({
  hub: 500,
  report: 450,
  verifyCritical: 320,
  verifyHigh: 310,
  convergenceEvidence: 220,
  role: 200,
  verifyMedium: 120,
  verifyLow: 110,
  verifyInfo: 100,
});

const SCHEDULING_PURPOSES = new Set<SchedulingPurpose>([
  "hub",
  "convergence_evidence",
  "discovery",
  "verify",
  "report",
  "manual",
]);

export function asSchedulingPurpose(value: unknown, fallback: SchedulingPurpose = "manual"): SchedulingPurpose {
  const purpose = String(value ?? "")
    .trim()
    .toLowerCase() as SchedulingPurpose;
  return SCHEDULING_PURPOSES.has(purpose) ? purpose : fallback;
}

export interface SchedulingPriorityInput {
  type: string;
  severity?: unknown;
  purpose?: unknown;
  payload?: Record<string, unknown> | null;
}

/** Resolve a Job's immutable semantic purpose from its type/payload. */
export function schedulingPurposeForJob(input: SchedulingPriorityInput): SchedulingPurpose {
  const type = String(input.type ?? "").toLowerCase();
  if (type === "hub_reason" || type === "hub") return "hub";
  if (type === "verify_finding" || type === "verify") return "verify";
  if (type === "report") return "report";
  const explicit = input.purpose ?? input.payload?.scheduling_purpose;
  if (explicit !== undefined) {
    const purpose = asSchedulingPurpose(explicit, "discovery");
    // Custom roles may only choose between the two role lanes.  System
    // classes (Hub/Verify/Report) are selected from the immutable type above.
    return purpose === "convergence_evidence" ? purpose : "discovery";
  }
  return "discovery";
}

/**
 * Pure fixed-priority resolver used by every Job creation path. Severity is
 * consulted only for Verify ordering; the Verify scope gate is applied before
 * this helper when a Finding is automatically derived.
 */
export function fixedPriorityForJob(input: SchedulingPriorityInput): number {
  const purpose = schedulingPurposeForJob(input);
  if (purpose === "report") return FIXED_PRIORITY.report;
  if (purpose === "hub") return FIXED_PRIORITY.hub;
  if (purpose === "convergence_evidence") return FIXED_PRIORITY.convergenceEvidence;
  if (purpose === "verify") {
    switch (asSeverityRank(input.severity, "medium")) {
      case "critical":
        return FIXED_PRIORITY.verifyCritical;
      case "high":
        return FIXED_PRIORITY.verifyHigh;
      case "medium":
        return FIXED_PRIORITY.verifyMedium;
      case "low":
        return FIXED_PRIORITY.verifyLow;
      case "info":
        return FIXED_PRIORITY.verifyInfo;
    }
  }
  return FIXED_PRIORITY.role;
}

/** Alias kept intentionally explicit for tests and API adapters. */
export const priorityForJob = fixedPriorityForJob;
export const resolveJobPriority = fixedPriorityForJob;

/** A PATCH may only write the class-derived value, never an arbitrary score. */
export function priorityMatchesJob(input: SchedulingPriorityInput, priority: number): boolean {
  return Number.isInteger(priority) && priority === fixedPriorityForJob(input);
}

/** Compatibility facade; the Hub bounded context owns this edge-trigger policy. */
export const shouldWakeEvidenceHub = hubShouldWakeEvidenceHub;

const SCHEDULER_SYSTEM_JOB_TYPES = new Set(["hub_reason", "hub", "verify_finding", "verify", "report"]);

export function isSchedulerOwnedVerificationFollowup(payload: Record<string, unknown>, parentJobType?: unknown): boolean {
  const followup = payload.verification_followup;
  if (!followup || typeof followup !== "object" || Array.isArray(followup)) return false;
  const value = followup as Record<string, unknown>;
  const trustedOrigin = (
    String(parentJobType ?? "").trim().toLowerCase() === "hub_reason"
    || value.manual_override === true
  );
  return (
    value.scheduler_owned === true &&
    trustedOrigin &&
    typeof value.finding_id === "string" &&
    value.finding_id.trim().length > 0 &&
    Array.isArray(value.required_evidence)
  );
}

export function schedulerPurposeForPendingNormalization(
  type: string,
  payload: Record<string, unknown>,
  parentJobType?: unknown,
): SchedulingPurpose {
  const normalizedType = String(type ?? "")
    .trim()
    .toLowerCase();
  if (SCHEDULER_SYSTEM_JOB_TYPES.has(normalizedType)) {
    // System lanes are derived from the immutable type. Persisted payload
    // purpose is never trusted during boot/resume repair.
    return schedulingPurposeForJob({
      type: normalizedType,
      payload: { ...payload, scheduling_purpose: undefined },
    });
  }
  // Hub 或 operator 端点生成的 verification followup 是 Scheduler 拥有的
  // 非系统收敛 lane；公共 createJob 会剥离两个可信标记。
  return isSchedulerOwnedVerificationFollowup(payload, parentJobType) ? "convergence_evidence" : "discovery";
}

/** 公共 Job 入口不得伪造 Scheduler 拥有的收敛 lane。 */
export function stripPublicSchedulingMarkers(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...payload };
  delete sanitized.scheduling_purpose;
  delete sanitized.scheduler_owned;
  delete sanitized.manual_override;
  if (
    sanitized.verification_followup &&
    typeof sanitized.verification_followup === "object" &&
    !Array.isArray(sanitized.verification_followup)
  ) {
    const followup = { ...(sanitized.verification_followup as Record<string, unknown>) };
    delete followup.scheduler_owned;
    delete followup.manual_override;
    sanitized.verification_followup = followup;
  }
  return sanitized;
}

function priorityNormalization(row: Record<string, unknown>): {
  priority: number;
  payload: Record<string, unknown>;
  changed: boolean;
} {
  const payload =
    row.payload_json && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)
      ? { ...(row.payload_json as Record<string, unknown>) }
      : {};
  const purpose = schedulerPurposeForPendingNormalization(row.type as string, payload, row.parent_job_type);
  const priority = fixedPriorityForJob({
    type: row.type as string,
    purpose,
    severity:
      row.finding_severity ?? payload.severity ?? (payload.finding as Record<string, unknown> | undefined)?.severity,
    payload,
  });
  const changed = Number(row.priority) !== priority || payload.scheduling_purpose !== purpose;
  if (payload.scheduling_purpose !== purpose) payload.scheduling_purpose = purpose;
  return { priority, payload, changed };
}

/**
 * Normalize only runnable pending Jobs after boot reconciliation. Historical
 * terminal priorities remain untouched; reset claimed/provisioning Jobs are
 * included because reconcileOnBoot has already returned them to pending.
 */
export async function normalizePendingJobPriorities(
  db: typeof sql = sql,
): Promise<{ examined: number; updated: number }> {
  const rows = await db`
    SELECT j.id, j.type, j.priority, j.payload_json, j.finding_id, j.parent_job_id,
           parent.type AS parent_job_type,
           f.severity AS finding_severity
    FROM jobs j
    LEFT JOIN findings f ON f.id = j.finding_id
    LEFT JOIN jobs parent ON parent.id = j.parent_job_id
    WHERE j.status = 'pending'
    ORDER BY j.created_at ASC, j.id ASC`;
  let updated = 0;
  for (const row of rows as unknown as Record<string, unknown>[]) {
    const normalized = priorityNormalization(row);
    if (!normalized.changed) continue;
    const [result] = await db`
      UPDATE jobs SET
        priority = ${normalized.priority},
        payload_json = ${db.json(normalized.payload as never)}
      WHERE id = ${row.id as string} AND status = 'pending'
      RETURNING id`;
    if (result) updated += 1;
  }
  return { examined: rows.length, updated };
}

/** Re-apply the same scheduler-owned class when a historical Job is resumed. */
export async function normalizePendingJobPriority(jobId: string, db: typeof sql = sql): Promise<boolean> {
  const [row] = await db`
    SELECT j.id, j.type, j.priority, j.payload_json, j.finding_id, j.parent_job_id,
           parent.type AS parent_job_type,
           f.severity AS finding_severity
    FROM jobs j
    LEFT JOIN findings f ON f.id = j.finding_id
    LEFT JOIN jobs parent ON parent.id = j.parent_job_id
    WHERE j.id = ${jobId} AND j.status = 'pending'`;
  if (!row) return false;
  const normalized = priorityNormalization(row as Record<string, unknown>);
  if (!normalized.changed) return false;
  const [result] = await db`
    UPDATE jobs SET
      priority = ${normalized.priority},
      payload_json = ${db.json(normalized.payload as never)}
    WHERE id = ${jobId} AND status = 'pending'
    RETURNING id`;
  return Boolean(result);
}

function defaultMinVerifySeverity(): SeverityRank {
  // AUTO_VERIFY_SEVERITIES=critical,high → 推断为 high
  return inferMinFromList(config.rules.autoVerifySeverities, "high");
}

/** env 兜底默认值（全局规则未配置时的最终回落） */
function envDefaultRules(): ProjectRules {
  return {
    minVerifySeverity: defaultMinVerifySeverity(),
    maxFollowupsPerJob: config.limits.maxFollowupsPerJob,
    maxFollowupDepth: config.limits.maxFollowupDepth,
    maxAutoRetries: config.limits.maxAutoRetries,
    maxVerificationRounds: 3,
    auditTimeoutSec: config.timeouts.auditSec,
    verifyTimeoutSec: config.timeouts.verifySec,
    hubEnabled: config.hub.enabled,
    maxHubRounds: config.hub.maxRounds,
    maxIntentsPerDecision: config.hub.maxIntents,
    allowEgress: true,
    maxGlobalJobs: asConcurrencyLimit(config.limits.maxGlobalJobs, 20),
    maxJobsPerProject: asConcurrencyLimit(config.limits.maxJobsPerProject, 5),
    maxConcurrentProvisioning: asConcurrencyLimit(config.limits.maxConcurrentProvisioning, 2),
    maxConcurrentByProvider: {},
    maxConcurrentByAgentCli: {},
  };
}

function mergeRulesLayer(raw: Record<string, unknown>, base: ProjectRules): ProjectRules {
  // 优先新字段；否则从旧 autoVerifySeverities / hubWaitSeverities 推断，保持升级兼容
  let min = base.minVerifySeverity;
  if (raw.minVerifySeverity != null) min = asSeverityRank(raw.minVerifySeverity, min);
  else if (raw.autoVerifySeverities != null) min = inferMinFromList(raw.autoVerifySeverities, min);
  else if (raw.hubWaitSeverities != null) min = inferMinFromList(raw.hubWaitSeverities, min);

  const maxVerificationRounds = Number(raw.maxVerificationRounds);
  const maxGlobalJobs = asConcurrencyLimit(raw.maxGlobalJobs, base.maxGlobalJobs);
  const maxJobsPerProject = Math.min(maxGlobalJobs, asConcurrencyLimit(raw.maxJobsPerProject, base.maxJobsPerProject));
  const maxConcurrentProvisioning = asConcurrencyLimit(raw.maxConcurrentProvisioning, base.maxConcurrentProvisioning);
  return {
    minVerifySeverity: min,
    maxFollowupsPerJob: (raw.maxFollowupsPerJob as number) ?? base.maxFollowupsPerJob,
    maxFollowupDepth: (raw.maxFollowupDepth as number) ?? base.maxFollowupDepth,
    maxAutoRetries: (raw.maxAutoRetries as number) ?? base.maxAutoRetries,
    maxVerificationRounds:
      Number.isInteger(maxVerificationRounds) && maxVerificationRounds >= 1 && maxVerificationRounds <= 20
        ? maxVerificationRounds
        : base.maxVerificationRounds,
    auditTimeoutSec: (raw.auditTimeoutSec as number) ?? base.auditTimeoutSec,
    verifyTimeoutSec: (raw.verifyTimeoutSec as number) ?? base.verifyTimeoutSec,
    hubEnabled: (raw.hubEnabled as boolean) ?? base.hubEnabled,
    maxHubRounds: (raw.maxHubRounds as number) ?? base.maxHubRounds,
    maxIntentsPerDecision: (raw.maxIntentsPerDecision as number) ?? base.maxIntentsPerDecision,
    allowEgress: (raw.allowEgress as boolean) ?? base.allowEgress,
    maxGlobalJobs,
    maxJobsPerProject,
    maxConcurrentProvisioning,
    maxConcurrentByProvider: asProviderLimits(raw.maxConcurrentByProvider, base.maxConcurrentByProvider),
    maxConcurrentByAgentCli: asCliLimits(raw.maxConcurrentByAgentCli, base.maxConcurrentByAgentCli),
  };
}

/**
 * Merge a global settings patch without replacing existing quota maps. Rule
 * fields are declaration-style scalars, while provider/CLI quota maps are
 * incremental so an operator can change one key without dropping siblings.
 */
export function mergeGlobalRulesPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const key of ["maxConcurrentByAgentCli", "maxConcurrentByProvider"]) {
    const incoming = patch[key];
    if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) continue;
    const previous = current[key];
    const previousMap =
      previous && typeof previous === "object" && !Array.isArray(previous) ? (previous as Record<string, unknown>) : {};
    merged[key] = { ...previousMap, ...(incoming as Record<string, unknown>) };
  }
  return merged;
}

/** 全局规则（global_settings 单例行 → env 兜底；§8.1 所有配置落库） */
export async function globalRules(db: typeof sql): Promise<ProjectRules> {
  const [g] = await db`SELECT rules_json FROM global_settings WHERE id = 'global'`;
  const gr = ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>;
  return mergeRulesLayer(gr, envDefaultRules());
}

/** 项目规则：项目 config_json.rules → 全局 global_settings → env 三级回落 */
export async function rulesForProject(db: typeof sql, projectId: string): Promise<ProjectRules> {
  const [p, g] = await Promise.all([
    db`SELECT config_json FROM projects WHERE id = ${projectId}`,
    db`SELECT rules_json FROM global_settings WHERE id = 'global'`,
  ]);
  const r = (((p[0]?.config_json as Record<string, unknown>)?.rules ?? {}) ?? {}) as Record<string, unknown>;
  const gr = ((g[0]?.rules_json ?? {}) ?? {}) as Record<string, unknown>;
  const global = mergeRulesLayer(gr, envDefaultRules());
  // Concurrency caps are global scheduler hard limits. Keep them visible in
  // project effective rules, but never let a project rules JSON widen either
  // cap (or create a second dispatcher truth).
  return {
    ...mergeRulesLayer(r, global),
    maxGlobalJobs: global.maxGlobalJobs,
    maxJobsPerProject: global.maxJobsPerProject,
    maxConcurrentProvisioning: global.maxConcurrentProvisioning,
    maxConcurrentByProvider: global.maxConcurrentByProvider,
    maxConcurrentByAgentCli: global.maxConcurrentByAgentCli,
  };
}

export function parseCanvasConvergence(targetJson: unknown): CanvasConvergence {
  const tj = (targetJson ?? {}) as Record<string, unknown>;
  const conv = (tj.convergence ?? {}) as Record<string, unknown>;
  return {
    hub_paused: Boolean(conv.hub_paused),
    paused_reason: typeof conv.paused_reason === "string" ? conv.paused_reason : undefined,
    paused_at: typeof conv.paused_at === "string" ? conv.paused_at : undefined,
    auto_stopped: Boolean(conv.auto_stopped),
    pending_confirmed_ids: Array.isArray(conv.pending_confirmed_ids)
      ? conv.pending_confirmed_ids.map(String)
      : undefined,
  };
}

export async function readCanvasConvergence(db: typeof sql, canvasId: string): Promise<CanvasConvergence> {
  const [c] = await db`SELECT target_json FROM canvases WHERE id = ${canvasId}`;
  return parseCanvasConvergence(c?.target_json);
}

export async function patchCanvasConvergence(
  db: typeof sql,
  canvasId: string,
  patch: Partial<CanvasConvergence>,
): Promise<CanvasConvergence> {
  const [c] = await db`SELECT target_json FROM canvases WHERE id = ${canvasId}`;
  if (!c) throw new Error(`canvas not found: ${canvasId}`);
  const tj = { ...((c.target_json ?? {}) as Record<string, unknown>) };
  const prev = parseCanvasConvergence(tj);
  const next: CanvasConvergence = {
    hub_paused: patch.hub_paused ?? prev.hub_paused,
    paused_reason: "paused_reason" in patch ? patch.paused_reason : prev.paused_reason,
    paused_at: "paused_at" in patch ? patch.paused_at : prev.paused_at,
    auto_stopped: patch.auto_stopped ?? prev.auto_stopped,
    pending_confirmed_ids: "pending_confirmed_ids" in patch ? patch.pending_confirmed_ids : prev.pending_confirmed_ids,
  };
  // 清理 undefined 键，避免 jsonb 噪音
  const stored: Record<string, unknown> = {
    hub_paused: next.hub_paused,
    auto_stopped: next.auto_stopped,
  };
  if (next.paused_reason) stored.paused_reason = next.paused_reason;
  if (next.paused_at) stored.paused_at = next.paused_at;
  if (next.pending_confirmed_ids?.length) stored.pending_confirmed_ids = next.pending_confirmed_ids;
  tj.convergence = stored;
  await db`UPDATE canvases SET target_json = ${db.json(tj as never)} WHERE id = ${canvasId}`;
  return next;
}

// ---------- 角色注册表（§8.3 Phase ②）：全局 agent_roles + 项目级启用清单 ----------

export interface RoleDef {
  id: string;
  name: string; // 即 job.type
  title: string;
  description: string;
  builtin: boolean;
  ui_color: string | null;
}

/**
 * 项目可用的角色清单（hub 可下发的 agent）：
 * 每次调用都实时查询 agent_roles；schema 中的内置模板不是运行时固定清单。
 * config_json.roles.enabled 为 null/缺省 = 全部内置角色；数组 = 按 name 白名单（含自定义角色）。
 */
export async function rolesForProject(db: typeof sql, projectId: string): Promise<RoleDef[]> {
  const [all, [p]] = await Promise.all([
    db`SELECT id, name, title, description, builtin, ui_color FROM agent_roles
       WHERE kind = 'role' ORDER BY builtin DESC, name`,
    db`SELECT config_json FROM projects WHERE id = ${projectId}`,
  ]);
  const enabled = (((p?.config_json as Record<string, unknown>)?.roles as Record<string, unknown> | undefined)
    ?.enabled ?? null) as string[] | null;
  const rows = all as unknown as RoleDef[];
  if (enabled == null) return rows.filter((r) => r.builtin);
  const set = new Set(enabled);
  return rows.filter((r) => set.has(r.name));
}

// ---------- Role/runtime snapshot compatibility facade ----------
//
// The role-runtime-snapshot context owns RoleConfig resolution and immutable
// runtime-image selection.  Keep the historical core exports while callers
// migrate to the explicit context entrypoint.

// ---------- Job 创建（含 Plane issue 防双跑唯一约束） ----------

export interface CreateJobInput {
  projectId: string;
  canvasId?: string;
  planeIssueId?: string;
  parentJobId?: string;
  findingId?: string;
  type: string;
  priority?: number;
  payload?: Record<string, unknown>;
  timeoutSec?: number;
  followupDepth?: number;
  /** 外部入口幂等键；仅入口 job 使用。 */
  ingressKey?: string;
}

export const MAX_RELATED_FINDING_IDS = 8;
const canonicalUuid = new RegExp(CANONICAL_UUID_PATTERN, "i");

/** Parse the untrusted payload declaration used to widen a Job's Finding scope. */
export function parseRelatedFindingIds(payload: Record<string, unknown>): string[] {
  if (!Object.prototype.hasOwnProperty.call(payload, "related_finding_ids")) return [];
  const raw = payload.related_finding_ids;
  if (!Array.isArray(raw) || raw.length > MAX_RELATED_FINDING_IDS) {
    throw new Error(`related_finding_ids_invalid: expected at most ${MAX_RELATED_FINDING_IDS} canonical UUIDs`);
  }
  const ids = raw.map((value, index) => {
    if (typeof value !== "string" || !canonicalUuid.test(value)) {
      throw new Error(`related_finding_ids_invalid: index ${index}`);
    }
    return value.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw new Error("related_finding_ids_duplicate");
  return ids;
}

export async function createJob(input: CreateJobInput) {
  const requestedPayload = { ...(input.payload ?? {}) };
  const systemType = SCHEDULER_SYSTEM_JOB_TYPES.has(String(input.type ?? "").toLowerCase());
  const schedulingPayload = systemType
    ? { ...requestedPayload }
    : stripPublicSchedulingMarkers(requestedPayload);
  const relatedFindingIds = parseRelatedFindingIds(schedulingPayload);
  const snapshotFindingIds = [
    ...new Set([...(input.findingId ? [input.findingId.toLowerCase()] : []), ...relatedFindingIds]),
  ];
  const purpose = schedulingPurposeForJob({
    type: input.type,
    // Custom/public Job creation never accepts a caller-selected convergence
    // lane. Scheduler-owned role INSERT paths use fixedPriorityForJob
    // directly and freeze their purpose there.
    purpose: systemType ? requestedPayload.scheduling_purpose : undefined,
    payload: schedulingPayload,
  });
  const priority = fixedPriorityForJob({
    type: input.type,
    purpose,
    severity:
      schedulingPayload.severity ?? (schedulingPayload.finding as Record<string, unknown> | undefined)?.severity,
    payload: schedulingPayload,
  });
  if (input.priority !== undefined && input.priority !== priority) {
    throw new Error(`job priority is fixed for ${input.type}: expected ${priority}`);
  }
  const payload = { ...schedulingPayload, scheduling_purpose: purpose };
  try {
    // 快照读取与 Job 插入必须处于同一事务；Credential provider 迁移会等待本事务结束，
    // 避免生成“快照是旧 provider、执行期已是新 provider”的竞态 Job。
    const job = await sql.begin(async (tx) => {
      const snapshot = await freezeAgentSnapshotNetworkPolicy(
        tx as unknown as typeof sql,
        input.canvasId,
        await resolveAgentSnapshotForJob(
          tx as unknown as typeof sql,
          input.projectId,
          input.type,
          snapshotFindingIds,
        ),
      );
      const [created] = await tx`
        INSERT INTO jobs ${tx({
          project_id: input.projectId,
          canvas_id: input.canvasId ?? null,
          plane_issue_id: input.planeIssueId ?? null,
          agent_snapshot_json: snapshot as never,
          parent_job_id: input.parentJobId ?? null,
          finding_id: input.findingId ?? null,
          type: input.type,
          priority,
          payload_json: payload as never,
          timeout_sec: input.timeoutSec ?? config.timeouts.auditSec,
          followup_depth: input.followupDepth ?? 0,
          ingress_key: input.ingressKey ?? null,
        })}
        RETURNING *`;
      await recordJobSharedAssets(tx as unknown as typeof sql, created.id as string, snapshot.shared_assets ?? []);
      return created;
    });
    inc("deepsonar_jobs_created_total", { type: input.type });
    return { job, duplicated: false };
  } catch (e: unknown) {
    // jobs_active_issue_uniq：已有活动 job 占用同一 issue
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
      return { job: null, duplicated: true };
    }
    throw e;
  }
}

// ---------- 任务画布（一任务一画布，§3.2）：认领时铸造 canvas_id ----------

export interface EnsureCanvasInput {
  projectId: string;
  planeIssueId?: string;
  title: string;
  target: Record<string, unknown>;
  triggerSource?: string;
  triggerEventId?: string;
  triggerPayload?: Record<string, unknown>;
  /** Scheduler-only authority: only the human task route may select project history. */
  allowComposeSeeds?: boolean;
}

function parseStoredFindingProtocolConfig(value: unknown) {
  if (value === undefined || value === null) return undefined;
  return FindingProtocolConfigSchema.parse(value);
}

function parseFrozenFindingProtocol(value: unknown): EffectiveFindingProtocol | undefined {
  if (value === undefined || value === null) return undefined;
  return EffectiveFindingProtocolSchema.parse(value);
}

/**
 * 为任务确保一个画布：同一 plane_issue_id 复用（重试算同一任务的历史），
 * 否则新建；新建时同事物写 root 节点（body_json 带目标）。
 * 返回 canvas_id。
 */
export async function ensureCanvasForTask(input: EnsureCanvasInput): Promise<string> {
  return sql.begin(async (tx) => {
    const requestedPolicy = (input.target.network_policy ?? {}) as Record<string, unknown>;
    const effectiveRules = await rulesForProject(tx as unknown as typeof sql, input.projectId);
    const [globalSettings] = await tx`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const [project] = await tx`SELECT config_json FROM projects WHERE id = ${input.projectId}`;
    if (!project) throw new Error(`project ${input.projectId} 不存在`);
    const globalConfig = parseStoredFindingProtocolConfig(
      ((globalSettings?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const projectConfig = parseStoredFindingProtocolConfig(
      ((project.config_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const taskConfig = parseStoredFindingProtocolConfig(input.target.finding_protocol);
    const effectiveFindingProtocol = resolveFindingProtocol(globalConfig, projectConfig, taskConfig);
    const target = await freezeTaskSeedTarget(
      tx as unknown as typeof sql,
      input.projectId,
      {
        ...input.target,
        effective_finding_protocol: effectiveFindingProtocol,
        network_policy: {
          allow_egress:
            typeof requestedPolicy.allow_egress === "boolean" ? requestedPolicy.allow_egress : effectiveRules.allowEgress,
        },
      },
      input.allowComposeSeeds === true,
    );
    let canvasId: string | null = null;
    let created = false;

    if (input.planeIssueId) {
      // 部分唯一索引 canvases_issue_uniq：ON CONFLICT 需带相同谓词
      const inserted = await tx`
        INSERT INTO canvases ${tx({
          project_id: input.projectId,
          plane_issue_id: input.planeIssueId,
          title: input.title,
          target_json: target as never,
        })}
        ON CONFLICT (plane_issue_id) WHERE plane_issue_id IS NOT NULL DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) {
        canvasId = inserted[0].id as string;
        created = true;
      } else {
        const [existing] = await tx`
          SELECT id FROM canvases WHERE plane_issue_id = ${input.planeIssueId}`;
        canvasId = existing.id as string;
      }
    } else if (input.triggerSource && input.triggerEventId) {
      const inserted = await tx`
        INSERT INTO canvases ${tx({
          project_id: input.projectId,
          plane_issue_id: null,
          title: input.title,
          target_json: target as never,
          trigger_source: input.triggerSource,
          trigger_event_id: input.triggerEventId,
          trigger_payload_json: (input.triggerPayload ?? {}) as never,
        })}
        ON CONFLICT (project_id, trigger_source, trigger_event_id)
          WHERE trigger_event_id IS NOT NULL DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) {
        canvasId = inserted[0].id as string;
        created = true;
      } else {
        const [existing] = await tx`
          SELECT id FROM canvases
          WHERE project_id = ${input.projectId}
            AND trigger_source = ${input.triggerSource}
            AND trigger_event_id = ${input.triggerEventId}`;
        canvasId = existing.id as string;
      }
    } else {
      // ad-hoc 任务（手动 POST /jobs 无 issue）：每次一个新画布
      const [row] = await tx`
        INSERT INTO canvases ${tx({
          project_id: input.projectId,
          plane_issue_id: null,
          title: input.title,
          target_json: target as never,
        })}
        RETURNING id`;
      canvasId = row.id as string;
      created = true;
    }

    if (created) {
      // root 节点：任务目标挂在 body_json.target；canvas_nodes_root_uniq 保证并发安全
      const [rootNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: null,
          node_type: "root",
          title: input.title,
          body_json: { target } as never,
          x: 100,
          y: 100,
          status: "active",
        })}
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (rootNode) {
        await insertTaskSeedProjections(
          tx as unknown as typeof sql,
          canvasId,
          rootNode.id as string,
          target,
        );
      }
    }
    return canvasId;
  });
}

async function findingProtocolForJob(tx: Tx, job: Record<string, unknown>): Promise<EffectiveFindingProtocol> {
  if (job.canvas_id) {
    const [canvas] = await tx`SELECT target_json FROM canvases WHERE id = ${job.canvas_id as string}`;
    const target = (canvas?.target_json ?? {}) as Record<string, unknown>;
    const frozen = parseFrozenFindingProtocol(target.effective_finding_protocol);
    if (frozen) return frozen;
  }

  // Compatibility for canvases created before schema v20. New canvases always
  // freeze this value at creation, so later config edits cannot rewrite history.
  const [globalSettings] = await tx`SELECT rules_json FROM global_settings WHERE id = 'global'`;
  const [project] = await tx`SELECT config_json FROM projects WHERE id = ${job.project_id as string}`;
  return resolveFindingProtocol(
    parseStoredFindingProtocolConfig(((globalSettings?.rules_json ?? {}) as Record<string, unknown>).finding_protocol),
    parseStoredFindingProtocolConfig(((project?.config_json ?? {}) as Record<string, unknown>).finding_protocol),
  );
}

// ---------- 事件摄入（幂等 + job_seq + 按类型落地副作用） ----------

export async function ingestEvent(jobId: string, envelope: EventEnvelopeInput): Promise<IngestResult> {
  return eventIngestionApplication.ingestEvent(jobId, envelope);
}

/**
 * Append deferred terminal semantic events as one same-Job transaction.  Hub
 * decision side effects and the corresponding Job done therefore cannot be
 * observed as a partially committed bundle.
 */
export async function ingestEventBundle(
  jobId: string,
  envelopes: readonly EventEnvelopeInput[],
): Promise<IngestResult[]> {
  return eventIngestionApplication.ingestEventBundle(jobId, envelopes);
}

/** Compatibility facade for semantic event application; ownership lives in event-ingestion. */
export type { EventSideEffectServices as CoreSideEffectServices } from "./domains/event-ingestion/index.js";

export async function applySideEffects(
  tx: Tx,
  jobId: string,
  type: string,
  payload: unknown,
  services: EventSideEffectServices = {},
): Promise<void> {
  return eventIngestionSideEffectApplication.applySideEffects(tx, jobId, type, payload, services);
}

/**
 * Shared dispatcher/retry serialization key.  The dispatcher holds this
 * transaction advisory lock while claiming pending jobs; destructive canvas
 * retry acquires the same key before it checks and wipes runtime rows.
 */
export const DISPATCH_CLAIM_ADVISORY_KEY = "deepsonar_dispatch_claim";

/**
 * Every path that mutates convergence state takes the canvas row first.  The
 * finding/verification-round locks are always acquired underneath this lock,
 * so terminal/recovery paths cannot deadlock with Hub eligibility.
 */
export async function lockCanvasForConvergence(tx: Tx, canvasId: string | null | undefined): Promise<boolean> {
  if (!canvasId) return true;
  const [canvas] = await tx`SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
  return Boolean(canvas);
}

/** canvas_edges 无唯一约束：from/to 边幂等插入 */
async function insertEdgeIfAbsent(tx: Tx, canvasId: string, fromId: string, toId: string, edgeType: string) {
  const existing = await tx`
    SELECT 1 FROM canvas_edges
    WHERE canvas_id = ${canvasId} AND from_node_id = ${fromId} AND to_node_id = ${toId} AND edge_type = ${edgeType}
    LIMIT 1`;
  if (existing.length > 0) return;
  await tx`
    INSERT INTO canvas_edges ${tx({
      canvas_id: canvasId,
      from_node_id: fromId,
      to_node_id: toId,
      edge_type: edgeType,
    })}`;
}

/**
 * Hub orchestration application.  Core remains the composition root for this
 * slice: the bounded context owns eligibility/trigger/round-budget SQL while
 * these adapters preserve the existing Scheduler lock and side-effect seams.
 */
const hubOrchestrationApplication = createHubOrchestrationApplication(sql, {
  rulesForProject: async (tx, projectId) => rulesForProject(tx as unknown as typeof sql, projectId),
  lockCanvasForConvergence,
  readCanvasConvergence: async (tx, canvasId) => readCanvasConvergence(tx as unknown as typeof sql, canvasId),
  patchCanvasConvergence: async (tx, canvasId, patch) =>
    patchCanvasConvergence(tx as unknown as typeof sql, canvasId, patch),
  careSeverities,
  resolveAgentSnapshotForJob: async (tx, projectId, type, findingIds = []) =>
    resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, type, findingIds),
  recordJobSharedAssets: async (tx, jobId, snapshot) =>
    recordJobSharedAssets(
      tx as unknown as typeof sql,
      jobId,
      (
        snapshot as {
          shared_assets?: Parameters<typeof recordJobSharedAssets>[2];
        }
      ).shared_assets ?? [],
    ),
  fixedPriorityForJob: (input) => fixedPriorityForJob(input),
  insertEdgeIfAbsent,
  settleCanvasFindingsAtGuardrail: async (tx, canvasId, reason) => {
    return findingVerificationApplication.settleCanvasFindingsAtGuardrail(tx, canvasId, reason);
  },
  evaluateAnalysisCompleteGate: async (tx, canvasId, options) => {
    return findingVerificationApplication.evaluateAnalysisCompleteGate(
      tx,
      canvasId,
      options,
    ) as Promise<HubAnalysisCompleteGate>;
  },
  hasSucceededRoleWork: async (tx, canvasId) => {
    return findingVerificationApplication.hasSucceededRoleWork(tx, canvasId);
  },
  maybeDispatchReport: async (tx, canvasId) => {
    return reportConvergenceApplication.maybeDispatchReport(tx, canvasId);
  },
});

type CanvasEdgeInput = {
  canvasId: string;
  fromId: string;
  toId: string;
  edgeType: string;
};

type HubEdgeBatchInsert = (tx: Tx, edges: readonly CanvasEdgeInput[]) => Promise<void>;

function dedupeCanvasEdges(edges: readonly CanvasEdgeInput[]): CanvasEdgeInput[] {
  const unique = new Map<string, CanvasEdgeInput>();
  for (const edge of edges) {
    const key = `${edge.canvasId}\u0000${edge.fromId}\u0000${edge.toId}\u0000${edge.edgeType}`;
    unique.set(key, edge);
  }
  return [...unique.values()];
}

/**
 * Insert a deduplicated edge batch without reading each candidate edge. The
 * event-ingestion transaction already serializes a canvas, and the NOT EXISTS
 * guard preserves the idempotency of insertEdgeIfAbsent for earlier events.
 */
export async function insertEdgesIfAbsentBatch(tx: Tx, edges: readonly CanvasEdgeInput[]) {
  const values = dedupeCanvasEdges(edges);
  if (values.length === 0) return;

  let rows = tx`(${values[0]!.canvasId}, ${values[0]!.fromId}::uuid, ${values[0]!.toId}::uuid, ${values[0]!.edgeType})`;
  for (const edge of values.slice(1)) {
    rows = tx`${rows}, (${edge.canvasId}, ${edge.fromId}::uuid, ${edge.toId}::uuid, ${edge.edgeType})`;
  }
  await tx`
    INSERT INTO canvas_edges (canvas_id, from_node_id, to_node_id, edge_type)
    SELECT candidate.canvas_id, candidate.from_node_id, candidate.to_node_id, candidate.edge_type
    FROM (VALUES ${rows}) AS candidate(canvas_id, from_node_id, to_node_id, edge_type)
    WHERE NOT EXISTS (
      SELECT 1 FROM canvas_edges existing
      WHERE existing.canvas_id = candidate.canvas_id
        AND existing.from_node_id = candidate.from_node_id
        AND existing.to_node_id = candidate.to_node_id
        AND existing.edge_type = candidate.edge_type
    )`;
}

// ---------- 结束处理 ----------

type TerminalCanvasNodeSnapshot = { id: string; canvas_id: string | null };

function sameTerminalCanvasNodes(left: TerminalCanvasNodeSnapshot[], right: TerminalCanvasNodeSnapshot[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (node, index) =>
      String(node.id) === String(right[index]?.id) &&
      ((node.canvas_id as string | null) ?? null) === ((right[index]?.canvas_id as string | null) ?? null),
  );
}

/**
 * 结束处理（§8.2）：done/failed 只能把 running 改为终态。
 * 语义事件入口在同一摄入事务提交前拒绝非 running Job（稳定
 * `job_not_running`，对外全事务回滚）；仅相同 event_id 的 dedup replay
 * 会在该门槛前直接返回。
 * 终态永不被迟到事件覆盖。
 */
export async function finalizeJob(
  tx: Tx,
  jobId: string,
  status: "succeeded" | "failed",
  result?: { summary?: string; error?: string; verdict?: string },
) {
  // Terminal convergence is Canvas-first. Read the immutable canvas target
  // without a lock, acquire Canvas, then take the Job row through the guarded
  // update. A concurrent repair that changes canvas_id aborts this transaction
  // instead of acquiring a second Canvas after Job.
  const [candidate] = await tx<{ canvas_id: string | null }[]>`
    SELECT canvas_id FROM jobs WHERE id = ${jobId}`;
  if (!candidate) return false;
  const candidateJobCanvasId = (candidate.canvas_id as string | null) ?? null;
  const candidateNodes = await tx<TerminalCanvasNodeSnapshot[]>`
    SELECT id, canvas_id FROM canvas_nodes
    WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})
    ORDER BY id`;
  const candidateNodeCanvasIds = [...new Set(candidateNodes.map((node) => (node.canvas_id as string | null) ?? null))];
  if (candidateNodes.some((node) => !node.canvas_id)) {
    throw new Error(`job ${jobId} has a Job/Intent/Report node without a Canvas`);
  }
  if (candidateNodeCanvasIds.length > 1) {
    throw new Error(`job ${jobId} has multiple convergence canvases`);
  }
  if (candidateJobCanvasId && candidateNodeCanvasIds.some((canvasId) => canvasId !== candidateJobCanvasId)) {
    throw new Error(`job ${jobId} has a job node outside canvas ${candidateJobCanvasId}`);
  }
  const candidateCanvasId = candidateJobCanvasId ?? (candidateNodeCanvasIds[0] as string | null | undefined) ?? null;
  if (!(await lockCanvasForConvergence(tx, candidateCanvasId))) return false;

  const [lockedJob] = await tx<{ id: string; canvas_id: string | null }[]>`
    SELECT id, canvas_id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
  if (!lockedJob) return false;
  if (((lockedJob.canvas_id as string | null) ?? null) !== candidateJobCanvasId) {
    throw new Error(`job ${jobId} canvas changed while finalizing`);
  }
  const lockedNodes = await tx<TerminalCanvasNodeSnapshot[]>`
    SELECT id, canvas_id FROM canvas_nodes
    WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})
    ORDER BY id
    FOR UPDATE`;
  if (!sameTerminalCanvasNodes(candidateNodes, lockedNodes)) {
    throw new Error(`job ${jobId} Canvas nodes changed while finalizing`);
  }
  if (lockedNodes.some((node) => ((node.canvas_id as string | null) ?? null) !== candidateCanvasId)) {
    throw new Error(`job ${jobId} Canvas nodes are outside the finalization Canvas`);
  }

  const [updated] = await tx<{ id: string; canvas_id: string | null }[]>`
    UPDATE jobs SET status = ${status}, finished_at = now(), error = ${result?.error ?? null}
    WHERE id = ${jobId} AND status = 'running'
    RETURNING id, canvas_id`;
  if (!updated) {
    console.warn(`[finalize] job ${jobId} 已不在 running，跳过重复 ${status} 终态提交`);
    return false;
  }
  // Job 与 Attempt 的终态必须在同一事务提交；Attempt 没有活动行时兼容
  // 早期手工/导入 Job，但不会凭空创建第二套生命周期。
  await settleAttemptTerminal(
    tx,
    jobId,
    status === "succeeded" ? "succeeded" : "failed",
    {
      job_status: status,
      summary: result?.summary ?? null,
    },
    result?.error,
  );
  if (((updated.canvas_id as string | null) ?? null) !== candidateJobCanvasId) {
    throw new Error(`job ${jobId} canvas changed while finalizing`);
  }
  await tx`
    UPDATE canvas_nodes SET status = ${status}, body_json = body_json || ${tx.json({ summary: result?.summary ?? null })}, updated_at = now()
    WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;

  // §6.3：job 终态立即吊销短期模型 Token（容器残留也调不动模型；网关另按 job 状态逐请求兜底）
  await revokeJobTokens(jobId, `job_${status}`).catch(() => {});
  await revokeJobCapabilityTokens(jobId, `job_${status}`).catch(() => {});

  const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
  // §13.1 指标：终态计数 + 时长
  // Canvas is already held as the outer lock for this terminal path. Verify
  // close/recovery and Hub eligibility take Finding/Round locks underneath it.
  if (status === "failed") inc("deepsonar_jobs_failed_total", { reason: "failed" });
  if (job?.started_at) {
    const dur = (Date.now() - new Date(job.started_at as string).getTime()) / 1000;
    if (dur > 0) {
      inc("deepsonar_job_duration_seconds_sum", undefined, Math.round(dur));
      inc("deepsonar_job_duration_seconds_count");
    }
  }

  // Report Job：成功写产物并把 Root 置 succeeded；失败保持 reporting
  if (job?.type === "report") {
    if (status === "succeeded") {
      await reportConvergenceApplication.finalizeReportJob(tx, jobId, {
        summary: result?.summary ?? null,
      });
    } else {
      await reportConvergenceApplication.finalizeReportJob(tx, jobId, {
        failed: true,
        error: result?.error ?? "report_failed",
      });
    }
    return true;
  }

  let forceHubReview = false;
  let hubSourceNodeIds: string[] = [];
  let hubTrigger: Record<string, unknown> | undefined;
  const completedPayload = (job?.payload_json ?? {}) as Record<string, unknown>;
  const isVerificationFollowup = Boolean(
    (completedPayload.verification_followup as { finding_id?: string } | undefined)?.finding_id,
  );
  // 补证 Job 禁止 hub_followup force；由 maybeReverifyAfterFollowup 统一收口
  if (completedPayload.hub_followup === true && job?.type !== "verify_finding" && !isVerificationFollowup) {
    forceHubReview = true;
    hubTrigger = { kind: "risk_acceptance_followup" };
  }

  // verify_finding：统一收口（证据硬门 + 回弹 / needs_human / confirmed）
  if (job?.type === "verify_finding" && job.finding_id) {
    const closed = await findingVerificationApplication.closeVerifyRound(tx, jobId, {
      jobStatus: status === "succeeded" ? "succeeded" : "failed",
      proposedVerdict: result?.verdict,
      summary: result?.summary,
      error: result?.error,
    });
    if (closed.forceHub) {
      forceHubReview = true;
      hubTrigger = closed.hubTrigger;
      hubSourceNodeIds = closed.sourceNodeIds ?? [];
    }
  } else if (job && isVerificationFollowup) {
    // 补证成功或失败：等同组全部终态后再验 / 再回弹（不 force Hub）
    await findingVerificationApplication.maybeReverifyAfterFollowup(tx, job);
  }

  // hub 循环（§8.3）：
  // - 成功 / verify 回弹：按既有 trigger 唤醒
  // - 非 Hub 终态后若画布已无待跑工作：canvas_idle 自动唤醒 Hub
  // - Hub 失败由 advanceCanvasAfterTerminalJob 留在 idle，等待人工恢复
  if (status === "succeeded" || forceHubReview) {
    await maybeTriggerHub(tx, job, {
      force: forceHubReview,
      sourceNodeIds: hubSourceNodeIds,
      trigger: hubTrigger,
    });
  }
  // 无论成功失败：统一推进画布终态。
  // Root 已 analysis_complete 时优先派 Report；否则按 canvas_idle 规则推进非 Hub 终态。
  // 这也覆盖 Hub 已提交 complete、但随后 failed 的窗口，避免 Root 永久卡住。
  if (job?.canvas_id) {
    await advanceCanvasAfterTerminalJob(tx, job, status, {
      sourceNodeIds: hubSourceNodeIds,
      trigger: hubTrigger,
    });
  }
  return true;
}

/**
 * Verify Job 在非 finalize 路径（reaper / dispatcher catch）进入终态时调用。
 * 幂等恢复 Finding，需要时 force Hub。
 */
export async function recoverVerifyJobTerminal(
  jobId: string,
  jobStatus: "failed" | "timeout" | "orphan" | "cancelled",
  error?: string | null,
): Promise<void> {
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;
    const [job] = await tx`SELECT type, finding_id, canvas_id, project_id, priority, id FROM jobs WHERE id = ${jobId}`;
    if (!job || job.type !== "verify_finding" || !job.finding_id) return;
    if (!(await lockCanvasForConvergence(tx, (job.canvas_id as string | null) ?? null))) return;
    const closed = await findingVerificationApplication.closeVerifyRound(tx, jobId, {
      jobStatus,
      error: error ?? null,
      summary: null,
    });
    if (closed.forceHub) {
      await maybeTriggerHub(
        tx,
        {
          id: job.id,
          project_id: job.project_id,
          canvas_id: job.canvas_id,
          type: "verify_finding",
          priority: fixedPriorityForJob({
            type: "verify_finding",
            purpose: "verify",
            severity: "medium",
          }),
        },
        {
          force: true,
          sourceNodeIds: closed.sourceNodeIds,
          trigger: closed.hubTrigger,
        },
      );
    }
  });
}

/** Compatibility facade for the extracted Hub orchestration application. */
export type CanvasJobTerminalStatus = HubCanvasJobTerminalStatus;

export async function advanceCanvasAfterTerminalJob(
  tx: Tx,
  job: HubJobRecord,
  terminalStatus: CanvasJobTerminalStatus,
  opts: { sourceNodeIds?: string[]; trigger?: Record<string, unknown> } = {},
): Promise<"report" | "hub" | "noop"> {
  return hubOrchestrationApplication.advanceCanvasAfterTerminalJob(tx, job, terminalStatus, opts);
}

export async function maybeTriggerHub(
  tx: Tx,
  job: HubJobRecord | undefined,
  options: HubTriggerOptions = {},
): Promise<void> {
  return hubOrchestrationApplication.maybeTriggerHub(tx, job, options);
}

export async function triggerHubFromHumanComment(input: HubHumanCommentInput): Promise<HubHumanCommentResult> {
  return hubOrchestrationApplication.triggerHubFromHumanComment(input);
}

/** 取消画布上非门控 severity 的 pending verify（drain-priority） */
export async function drainNonGateVerifies(
  db: typeof sql,
  canvasId: string,
  waitSeverities: string[],
): Promise<{ cancelled: number }> {
  const gate = waitSeverities.map((s) => s.toLowerCase());
  const rows = await db`
    UPDATE jobs j SET status = 'cancelled', finished_at = now(),
      error = 'drain-priority: 非门控 severity，人工清理'
    FROM findings f
    WHERE j.canvas_id = ${canvasId}
      AND j.type = 'verify_finding'
      AND j.status = 'pending'
      AND f.id = j.finding_id
      AND NOT (lower(f.severity) = ANY(${gate}))
    RETURNING j.id, j.finding_id`;
  for (const row of rows) {
    await revokeJobCapabilityTokens(row.id as string, "drain-priority").catch(() => {});
    await db`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${row.id as string} AND node_type = ANY(${["job", "intent"]})`;
    if (row.finding_id) {
      await db`
        UPDATE findings SET verify_status = 'pending' WHERE id = ${row.finding_id as string}
          AND verify_status = 'verifying'`;
      await db`
        UPDATE canvas_nodes n SET status = 'open', updated_at = now()
        FROM findings f
        WHERE f.id = ${row.finding_id as string} AND n.id = f.node_id AND n.status = 'verifying'`;
    }
  }
  return { cancelled: rows.length };
}

// ---------- RoleConfig 安全校验（§7.2/§7.3） ----------

/** 系统保留环境变量：RoleConfig 与配置文件一律不得覆盖 */
export const RESERVED_ENV_KEYS = new Set([
  "DEEPSONAR_JOB_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "PATH",
  "HOME",
  "NODE_OPTIONS",
]);
const RESERVED_ENV_PREFIXES = ["AGENTBOX_", "DEEPSONAR_"];
const SENSITIVE_ENV_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_MAX_COUNT = 50;
const ENV_MAX_VALUE = 4096;
const ENV_MAX_TOTAL = 64 * 1024;

/** 校验非敏感 env_vars；返回错误消息或 null */
export function validateEnvVars(env: Record<string, string>): string | null {
  const entries = Object.entries(env);
  if (entries.length > ENV_MAX_COUNT) return `环境变量数量超限（>${ENV_MAX_COUNT}）`;
  let total = 0;
  for (const [k, v] of entries) {
    if (!ENV_NAME_RE.test(k)) return `非法环境变量名: ${k}`;
    if (RESERVED_ENV_KEYS.has(k) || RESERVED_ENV_PREFIXES.some((p) => k.startsWith(p))) {
      return `环境变量 ${k} 为系统保留，不允许配置`;
    }
    if (SENSITIVE_ENV_NAME.test(k)) return `环境变量 ${k} 疑似密钥，请改用 Credential`;
    if (typeof v !== "string") return `环境变量 ${k} 的值必须是字符串`;
    if (v.length > ENV_MAX_VALUE) return `环境变量 ${k} 值超长（>${ENV_MAX_VALUE}）`;
    total += k.length + v.length;
  }
  if (total > ENV_MAX_TOTAL) return `环境变量总大小超限（>${ENV_MAX_TOTAL}B）`;
  return null;
}

/** 各 CLI 允许上传的 Provider 配置文件固定相对路径 */
export const CONFIG_FILE_PATHS: Record<string, string> = {
  "claude-code": ".claude/settings.json",
  codex: ".codex/config.toml",
  "open-code": ".opencode/config.json",
  pi: ".pi/agent/models.json",
  dsh: ".dsh/settings.yaml",
};

export function validateConfigFilePath(agentCli: string, p: string): string | null {
  if (!p || p.length > 200) return "路径为空或超长";
  if (p.includes("\u0000")) return "路径含 NUL";
  if (p.includes("\\")) return "路径不允许反斜杠";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "不允许绝对路径";
  const norm = path.posix.normalize(p);
  if (norm !== p || norm.startsWith("..") || norm.includes("/../")) return "路径不允许 .. 或非规范形式";
  const allowed = CONFIG_FILE_PATHS[agentCli];
  if (!allowed) return `未知 agent_cli: ${agentCli}`;
  if (agentCli === "pi" && /^\.pi\/agent\/extensions\/[A-Za-z0-9._-]+\.(?:cjs|js|mjs|ts)$/u.test(norm)) {
    return null;
  }
  if (norm !== allowed) return `该 CLI 首期只允许固定配置文件：${allowed}`;
  return null;
}

export const CONFIG_FILE_MAX_COUNT = 5;
export const CONFIG_FILE_MAX_BYTES = 64 * 1024;
export const CONFIG_FILE_MAX_TOTAL = 256 * 1024;

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9_-]{20,}/, label: "疑似 API Key（sk-…）" },
  { re: /AKIA[0-9A-Z]{16}/, label: "疑似 AWS Access Key" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "疑似私钥" },
  {
    re: /(api[_-]?key|token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/.+]{20,}["']/i,
    label: "疑似硬编码密钥字段",
  },
];

export function scanConfigContent(content: string): string | null {
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(content)) return label;
  }
  return null;
}

/** Compatibility facade for the extracted role/runtime snapshot context. */
export async function resolveAgentSnapshotForJob(
  db: typeof sql,
  projectId: string,
  jobType: string,
  findingIds: string[] = [],
): Promise<AgentRuntimeSnapshot> {
  const snapshot = (await roleRuntimeSnapshotApplication.resolveAgentSnapshotForJob(
    db as never,
    projectId,
    jobType,
  )) as AgentRuntimeSnapshot;
  const selection = await resolveSharedAssetSelection(db, projectId, findingIds);
  return {
    ...snapshot,
    shared_assets_revision: selection.revision,
    shared_assets: selection.assets,
  };
}
