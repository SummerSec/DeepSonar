import { createHash } from "node:crypto";
import path from "node:path";
import {
  resolvePlatformTools,
  type EventEnvelope,
  type FindingPayload,
  type PlatformToolConfig,
  type PlatformToolName,
} from "@deepsonar/shared-types";
import { config } from "./config.js";
import { allowedModelIds, isProviderKnown } from "./credentials.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { resolveRuntimeImageForJob, type RuntimeImageSnapshot } from "./runtime-images.js";
import { expandModules } from "./skill-sources.js";

// ---------- 状态机（§3.3）：允许的状态迁移 ----------

const TRANSITIONS: Record<string, string[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["provisioning", "cancelled", "failed"],
  provisioning: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "timeout", "orphan", "cancelled", "waiting_human"],
  waiting_human: ["pending", "cancelled", "failed"], // resume → pending 重入队
  // 终态失败可经 resume-session / resume 复活（继续执行，保留历史）；
  // cancelled 不可复活；全部重来用 /tasks/:id/retry（清空画布历史后重跑）
  failed: ["pending"],
  timeout: ["pending"],
  orphan: ["pending"],
  // 绝对终态：succeeded / cancelled
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 原子状态迁移（§8.1）：WHERE 显式限定合法源状态。
 * 返回 null = 竞态或非法迁移，调用方不得继续 provision/执行/写完成事件。
 */
export async function transitionJob(jobId: string, to: string, patch: Record<string, unknown> = {}) {
  const allowedFrom = Object.entries(TRANSITIONS)
    .filter(([, tos]) => tos.includes(to))
    .map(([from]) => from);
  if (allowedFrom.length === 0) throw new Error(`非法目标状态: ${to}`);
  const sets = { status: to, ...patch };
  const [row] = await sql`
    UPDATE jobs SET ${sql(sets)}
    WHERE id = ${jobId} AND status = ANY(${allowedFrom})
    RETURNING id, status`;
  return row ?? null;
}

export function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ---------- 项目规则（决策层）：projects.config_json.rules 覆盖 + env 兜底 ----------
//
// 第一性原理：用户只配「最低关注级别」一件事。
// 派生（写死，不暴露配置）：
//   · ≥ 该级别 → 自动 verify
//   · Hub 等这些 verify 跑完再决策（含 confirmed）
//   · 这些验完且无活跃角色 job → 停自驱
//   · verify 调度永远 critical > high > …

/** 严重度从高到低；minVerifySeverity=high 表示 critical+high */
export const SEVERITY_RANK = ["critical", "high", "medium", "low", "info"] as const;
export type SeverityRank = (typeof SEVERITY_RANK)[number];

export interface ProjectRules {
  /**
   * 关注级别旋钮：控制 verify 调度优先级与 Hub 等待门（≥ 该级别优先）。
   * 注意：所有 Finding 都会自动进入 Verify；severity 不再决定「是否验证」。
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

const SEVERITY_PRIORITY_DELTA: Record<string, number> = {
  critical: 40,
  high: 30,
  medium: 10,
  low: 0,
  info: -5,
};

function asSeverityRank(v: unknown, fallback: SeverityRank): SeverityRank {
  const s = String(v ?? "").trim().toLowerCase();
  return (SEVERITY_RANK as readonly string[]).includes(s) ? (s as SeverityRank) : fallback;
}

function asCliLimits(v: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fallback;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(value);
    if (["claude-code", "codex", "open-code"].includes(key) && Number.isInteger(n) && n >= 0 && n <= 1000) out[key] = n;
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
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}

function asProviderLimits(v: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fallback;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(value);
    if (isProviderKnown(key) && Number.isInteger(n) && n >= 0 && n <= 1000) out[key] = n;
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

/** @deprecated 兼容旧调用名；语义 = careSeverities(rules.minVerifySeverity) */
export function resolveHubWaitSeverities(rules: ProjectRules): string[] {
  return careSeverities(rules.minVerifySeverity);
}

export function severityPriorityDelta(severity: string | null | undefined): number {
  return SEVERITY_PRIORITY_DELTA[String(severity ?? "").toLowerCase()] ?? 0;
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
    maxGlobalJobs: asConcurrencyLimit(config.limits.maxGlobalJobs, 6),
    maxJobsPerProject: asConcurrencyLimit(config.limits.maxJobsPerProject, 2),
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
  const maxJobsPerProject = Math.min(
    maxGlobalJobs,
    asConcurrencyLimit(raw.maxJobsPerProject, base.maxJobsPerProject),
  );
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
    maxConcurrentByProvider: asProviderLimits(raw.maxConcurrentByProvider, base.maxConcurrentByProvider),
    maxConcurrentByAgentCli: asCliLimits(raw.maxConcurrentByAgentCli, base.maxConcurrentByAgentCli),
  };
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
    pending_confirmed_ids:
      "pending_confirmed_ids" in patch ? patch.pending_confirmed_ids : prev.pending_confirmed_ids,
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
}

/**
 * 项目可用的角色清单（hub 可下发的 agent）：
 * 每次调用都实时查询 agent_roles；schema 中的内置模板不是运行时固定清单。
 * config_json.roles.enabled 为 null/缺省 = 全部内置角色；数组 = 按 name 白名单（含自定义角色）。
 */
export async function rolesForProject(db: typeof sql, projectId: string): Promise<RoleDef[]> {
  const [all, [p]] = await Promise.all([
    db`SELECT id, name, title, description, builtin FROM agent_roles
       WHERE kind = 'role' ORDER BY builtin DESC, name`,
    db`SELECT config_json FROM projects WHERE id = ${projectId}`,
  ]);
  const enabled = (((p?.config_json as Record<string, unknown>)?.roles as Record<string, unknown> | undefined)?.enabled ??
    null) as string[] | null;
  const rows = all as unknown as RoleDef[];
  if (enabled == null) return rows.filter((r) => r.builtin);
  const set = new Set(enabled);
  return rows.filter((r) => set.has(r.name));
}

// ---------- 角色运行快照：RoleConfig / 平台缺省 → Job 创建时冻结 ----------

/** 与 agentbox-sdk AgentReasoningEffort 对齐；null = provider 默认 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/**
 * Platform-owned agent defaults. These are code-level compatibility values,
 * deliberately independent from AGENT_PROVIDER/AGENT_MODEL and never replaced
 * by process environment at RoleConfig or Job execution time.
 */
export const PLATFORM_DEFAULT_AGENT_CLI = "claude-code";
export const PLATFORM_DEFAULT_AGENT_MODEL: string | null = null;

let legacyAgentDefaultsWarningEmitted = false;
function warnIgnoredLegacyAgentDefaults(): void {
  if (legacyAgentDefaultsWarningEmitted) return;
  const hasLegacyValues = ["AGENT_PROVIDER", "AGENT_MODEL"].some((name) => process.env[name] !== undefined);
  if (!hasLegacyValues) return;
  legacyAgentDefaultsWarningEmitted = true;
  console.warn("[role-config] legacy AGENT_PROVIDER/AGENT_MODEL are ignored; configure agent_cli/model/env_vars in RoleConfig");
}

export interface AgentRuntimeSnapshot {
  name: string;
  /** 角色类别随 Job 冻结；决定 Hub/可下发角色/系统角色的运行契约。 */
  role_kind: "role" | "hub" | "system";
  agent_cli: string;
  model: string | null;
  /** 思考/推理强度（下一 job 生效，随快照冻结） */
  reasoning: ReasoningEffort | null;
  /** RoleConfig 内声明的非敏感环境变量。 */
  env_vars: Record<string, string>;
  env_keys: string[];
  /** 绑定的 Provider Credential（§6.2）：快照只存 id/name/provider，密钥运行时解密，不进快照 */
  credential_id: string | null;
  /** 凭据展示名（创建 Job 时冻结；UI 优先展示此字段而非 UUID） */
  credential_name: string | null;
  credential_provider: string | null;
  /** 勾选的 Git 模块（["<source_id>:<module_id>"]，展示用；下发内容已展开进 skills/commands） */
  modules: string[];
  /** §5.1：模块来源版本证据（commit + 内容哈希，随快照冻结） */
  skill_revisions: { source_id: string; commit_sha: string | null; content_hash: string | null }[];
  skills: unknown[];
  commands: unknown[];
  mcps: unknown[];
  subagents: unknown[];
  /** 角色长期职责，随 Job 冻结并渲染为 /workspace/AGENTS.md 与 CLAUDE.md。 */
  role_description: string;
  /** RoleConfig 自定义的长期指令；任务内容不得写入这里。 */
  instructions_markdown: string | null;
  /** 本 Job 实际授权的平台工具；由 RoleConfig 在创建 Job 时冻结。 */
  platform_tools: PlatformToolName[];
  /** Provider 项目配置文件，随 Job 冻结后写入 /workspace。 */
  config_files: { path: string; content: string; content_sha256: string }[];
  role_config_id: string | null;
  role_config_version: number | null;
  runtime_image_key: string | null;
  /** 已在 Job 创建时冻结的不可变可信镜像；Executor 只能使用 image_ref。 */
  runtime_image: RuntimeImageSnapshot;
}

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

export async function createJob(input: CreateJobInput) {
  try {
    // 冻结角色运行快照：配置变更只影响之后创建的 Job。
    const snapshot = await resolveAgentSnapshotForJob(sql, input.projectId, input.type);
    const [job] = await sql`
      INSERT INTO jobs ${sql({
        project_id: input.projectId,
        canvas_id: input.canvasId ?? null,
        plane_issue_id: input.planeIssueId ?? null,
        agent_snapshot_json: snapshot as never,
        parent_job_id: input.parentJobId ?? null,
        finding_id: input.findingId ?? null,
        type: input.type,
        priority: input.priority ?? 0,
        payload_json: (input.payload ?? {}) as never,
        timeout_sec: input.timeoutSec ?? config.timeouts.auditSec,
        followup_depth: input.followupDepth ?? 0,
        ingress_key: input.ingressKey ?? null,
      })}
      RETURNING *`;
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
    const target = {
      ...input.target,
      network_policy: {
        allow_egress:
          typeof requestedPolicy.allow_egress === "boolean"
            ? requestedPolicy.allow_egress
            : effectiveRules.allowEgress,
      },
    };
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
      await tx`
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
        ON CONFLICT DO NOTHING`;
    }
    return canvasId;
  });
}

// ---------- 事件摄入（幂等 + job_seq + 按类型落地副作用） ----------

export interface IngestResult {
  deduped: boolean;
  seq?: number;
}

export async function ingestEvent(jobId: string, envelope: EventEnvelope): Promise<IngestResult> {
  const payloadSize = Buffer.byteLength(JSON.stringify(envelope.payload ?? {}), "utf8");
  if (payloadSize > config.events.payloadMaxKb * 1024) {
    throw new Error(`event payload 超限：${payloadSize}B > ${config.events.payloadMaxKb}KB`);
  }

  return sql.begin(async (tx) => {
    // 0. 锁 job 行：串行化同一 job 的事件摄入，job_seq 的 MAX()+1 才有并发安全（§8.5）
    await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;

    // 1. 幂等闸：event_dedup 撞不上即为重放
    const dedup = await tx`
      INSERT INTO event_dedup (event_id, job_id) VALUES (${envelope.event_id}, ${jobId})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id`;
    if (dedup.length === 0) return { deduped: true };

    // 2. 局部序
    const [{ next }] = await tx<[{ next: number }]>`
      SELECT COALESCE(MAX(job_seq), 0) + 1 AS next FROM events WHERE job_id = ${jobId}`;

    await tx`
      INSERT INTO events ${tx({
        job_id: jobId,
        event_id: envelope.event_id,
        job_seq: next,
        type: envelope.type,
        payload_json: (envelope.payload ?? {}) as never,
      })}`;

    // 3. 按类型落地（画布节点 / finding / 状态）
    await applySideEffects(tx as unknown as typeof sql, jobId, envelope.type, envelope.payload);

    return { deduped: false, seq: next };
  });
}

type Tx = typeof sql;

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

async function applySideEffects(tx: Tx, jobId: string, type: string, payload: unknown) {
  const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job) throw new Error(`job ${jobId} 不存在`);

  if (type === "progress") {
    const p = payload as { message?: string; percent?: number };
    await tx`
      UPDATE canvas_nodes SET body_json = body_json || ${tx.json({ last_progress: p })}, updated_at = now()
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]})`;
    await tx`UPDATE jobs SET heartbeat_at = now() WHERE id = ${jobId}`;
    return;
  }

  if (type === "finding") {
    const f = payload as FindingPayload;
    const fingerprint = sha16(
      [f.title.trim().toLowerCase(), (f.location ?? "").trim(), (f.rule_id ?? "").trim()].join("|"),
    );
    const [finding] = await tx`
      INSERT INTO findings ${tx({
        project_id: job.project_id,
        job_id: jobId,
        fingerprint,
        title: f.title,
        severity: f.severity,
        location: f.location ?? null,
        summary: f.summary ?? null,
        suggest_verify: f.suggest_verify ?? false,
        raw_json: (f.raw ?? {}) as never,
      })}
      ON CONFLICT (project_id, fingerprint) DO NOTHING
      RETURNING *`;
    if (!finding) return; // fingerprint 去重命中：同一 finding 不重复上图、不重复派生

    // 画布：finding 节点挂在 job 节点下，坐标服务端分配（§3.2）
    const [jobNode] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]})`;
    if (jobNode) {
      const [{ count }] = await tx<[{ count: number }]>`
        SELECT COUNT(*)::int AS count FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'finding'`;
      const [node] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: jobNode.canvas_id,
          job_id: jobId,
          node_type: "finding",
          title: f.title,
          body_json: { severity: f.severity, location: f.location, summary: f.summary } as never,
          x: jobNode.x + 300,
          y: jobNode.y + count * 140,
          status: "open",
        })}
        RETURNING id`;
      await tx`
        INSERT INTO canvas_edges ${tx({
          canvas_id: jobNode.canvas_id,
          from_node_id: jobNode.id,
          to_node_id: node.id,
          edge_type: "produces",
        })}`;
      await tx`UPDATE findings SET node_id = ${node.id} WHERE id = ${finding.id}`;
    }

    // 规则引擎：所有 Finding 自动进入 Verify（§4.3；severity 只影响优先级）
    const { evaluateFollowup } = await import("./verify.js");
    await evaluateFollowup(tx, job, finding);
    return;
  }

  if (type === "fact") {
    // 角色 agent 的发现 → fact 节点（§8.3：agent 只负责把发现写入画布）
    const p = payload as {
      intent_node_id?: string;
      title?: string;
      description?: string;
      verification?: import("@deepsonar/shared-types").VerificationEvidence;
    };
    if (!p.description) return;
    let canvasId = (job.canvas_id as string) ?? null;
    let intentNode: Record<string, unknown> | null = null;
    if (p.intent_node_id) {
      const [n] = await tx`SELECT * FROM canvas_nodes WHERE id = ${p.intent_node_id}`;
      if (n) {
        intentNode = n;
        canvasId = (n.canvas_id as string) ?? canvasId;
      }
    }
    if (!canvasId) {
      const [jobNode] = await tx`
        SELECT canvas_id FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]})`;
      canvasId = (jobNode?.canvas_id as string) ?? null;
    }
    if (!canvasId) return;

    const [{ count }] = await tx<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'fact'`;
    const [node] = await tx`
      INSERT INTO canvas_nodes ${tx({
        canvas_id: canvasId,
        job_id: jobId,
        node_type: "fact",
        title: (p.title ?? p.description.slice(0, 60)).slice(0, 200),
        body_json: { description: p.description } as never,
        x: ((intentNode?.x as number) ?? 100) + 340,
        y: ((intentNode?.y as number) ?? 100) + count * 140,
        status: "open",
      })}
      RETURNING id`;
    // 'to' 边：意图 → 产出的事实（Cairn Intent.to）
    if (intentNode) {
      await insertEdgeIfAbsent(tx, canvasId, intentNode.id as string, node.id as string, "to");
    }
    // 结构化验证证据：仅 Hub 回弹补证 Job 绑定 finding 时接受
    if (p.verification) {
      const { attachVerificationEvidence } = await import("./verify.js");
      await attachVerificationEvidence(tx, job, node.id as string, canvasId, p.verification);
    }
    return;
  }

  if (type === "hub_decision") {
    // hub 读图后的决策：complete=目标达成；intents=派发角色 job（§8.3）
    const p = payload as {
      complete?: { from?: string[]; description?: string };
      intents?: { from?: string[]; role?: string; description?: string; prompt?: string }[];
    };
    const canvasId = (job.canvas_id as string) ?? null;
    if (!canvasId) return;
    const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);

    if (p.complete?.description) {
      // Hub complete 只是提案：统一完成门（排除当前仍 running 的 Hub 做门检）
      // **不在此处派 Report**：当前 Hub 尚未 mark_job_done；由 finalizeJob 在 Hub succeeded 后派发，
      // 避免 exclude 后抢跑 Report，也避免 Hub 崩溃时报告先于 Hub 终态。
      const { evaluateAnalysisCompleteGate } = await import("./verify.js");
      const gate = await evaluateAnalysisCompleteGate(tx, canvasId, { excludeJobId: jobId });
      if (!gate.ok) {
        const detail =
          gate.problems.length > 0
            ? gate.problems
                .slice(0, 8)
                .map((x) =>
                  x.finding_id
                    ? `[${x.severity}] ${x.title || x.finding_id}: ${x.verify_status}（${x.issue}）`
                    : x.issue,
                )
                .join("; ")
            : gate.blockers.slice(0, 5).join("; ");
        throw new Error(`Hub complete 被拒绝：${detail}`);
      }

      const [root] = await tx`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
      if (root) {
        await tx`
          UPDATE canvas_nodes SET status = 'analysis_complete',
            body_json = body_json || ${tx.json({ conclusion: p.complete.description })}, updated_at = now()
          WHERE id = ${root.id}`;
        for (const fid of p.complete.from ?? []) {
          const [src] = await tx`
            SELECT id FROM canvas_nodes WHERE id = ${fid} AND canvas_id = ${canvasId}`;
          if (src) await insertEdgeIfAbsent(tx, canvasId, src.id as string, root.id as string, "to");
        }
      }
      return;
    }

    // 项目启用的角色（hub 可下发清单）；一个都没启用则不再派生
    const roles = await rolesForProject(tx as unknown as typeof sql, job.project_id as string);
    const enabledNames = new Set(roles.map((r) => r.name));
    const intents = (p.intents ?? []).slice(0, rules.maxIntentsPerDecision);
    for (const it of intents) {
      if (!it.role || !enabledNames.has(it.role)) {
        throw new Error(`Hub 派发了不可用角色: ${it.role ?? "<missing>"}`);
      }
    }

    const decisionTrigger = ((job.payload_json as Record<string, unknown> | undefined)?.trigger ?? {}) as {
      kind?: string;
      finding_id?: string;
      missing_evidence?: string[];
    };
    if (["verify_rework", "verify_failed"].includes(decisionTrigger.kind ?? "")) {
      for (const it of intents) {
        if (it.role !== "review" && it.role !== "test") {
          throw new Error(
            `Verify 补证只允许派发 review/test，收到 ${it.role ?? "<missing>"}`,
          );
        }
      }
    }

    for (const it of intents) {
      if (!it.description?.trim() || !it.prompt?.trim()) continue;
      if (roles.length === 0) {
        console.warn(`[hub] 项目 ${job.project_id} 无启用角色，跳过意图派发`);
        break;
      }
      const title = it.description.trim().slice(0, 120);
      // 去重：同画布已有同标题的未结论 intent → 跳过（hub 重复派发护栏）
      const dup = await tx`
        SELECT 1 FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'intent' AND title = ${title}
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        LIMIT 1`;
      if (dup.length > 0) continue;

      // 服务端硬边界：只接受数据库实时查询出的项目可用工作角色，不做默认或回退。
      const role = it.role!;
      const snapshot = await resolveAgentSnapshotForJob(tx as unknown as typeof sql, job.project_id as string, role);
      const trigger = decisionTrigger;
      // verify_rework/verify_failed 补证不得 hub_followup：否则每个补证成功都会 force Hub，
      // 与「全部补证终态后 maybeReverifyAfterFollowup」冲突。
      const hubFollowup = ["confirmed_finding", "risk_acceptance_followup", "human_comment"].includes(
        trigger.kind ?? "",
      );
      const { buildVerificationFollowupPayload } = await import("./verify.js");
      const verificationFollowup = buildVerificationFollowupPayload(trigger, it.from, role);
      // 补证 Job 即使 Hub 因其它原因带了 hub_followup，也禁止 force 提前回弹
      const applyHubFollowup = hubFollowup && !verificationFollowup;
      const [roleJob] = await tx`
        INSERT INTO jobs ${tx({
          project_id: job.project_id as string,
          canvas_id: canvasId,
          agent_snapshot_json: snapshot as never,
          type: role,
          priority: (job.priority as number) + 1,
          payload_json: {
            intent: {
              description: it.description,
              prompt: it.prompt.trim(),
              from: it.from ?? [],
            },
            ...(applyHubFollowup ? { hub_followup: true } : {}),
            ...(verificationFollowup ? { verification_followup: verificationFollowup } : {}),
          } as never,
          timeout_sec: rules.auditTimeoutSec,
          followup_depth: 0,
        })}
        RETURNING id`;
      // intent 节点与角色 job 1:1（节点即任务卡：pending=未认领 running=进行中 succeeded=已结论）
      const [{ next_y }] = await tx<[{ next_y: number }]>`
        SELECT COALESCE(MAX(y), 60) + 140 AS next_y FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'intent'`;
      const [intentNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: roleJob.id as string,
          node_type: "intent",
          title,
          body_json: { role, description: it.description } as never,
          x: 1220,
          y: next_y,
          status: "pending",
        })}
        RETURNING id`;
      await tx`
        UPDATE jobs SET payload_json = payload_json || ${tx.json({ intent_node_id: intentNode.id })}
        WHERE id = ${roleJob.id}`;
      // 'from' 边：被引用事实 → 新意图（Cairn Intent.from）
      for (const fid of it.from ?? []) {
        const [src] = await tx`
          SELECT id FROM canvas_nodes WHERE id = ${fid} AND canvas_id = ${canvasId}`;
        if (src) await insertEdgeIfAbsent(tx, canvasId, src.id as string, intentNode.id as string, "from");
      }
    }
    return;
  }

  if (type === "done") {
    await finalizeJob(tx, jobId, "succeeded", payload as { summary?: string });
    return;
  }

  if (type === "human") {
    const p = payload as { reason?: string };
    await tx`
      UPDATE jobs SET status = 'waiting_human' WHERE id = ${jobId} AND status = 'running'`;
    const [jobNode] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'job'`;
    if (jobNode) {
      await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: jobNode.canvas_id,
          job_id: jobId,
          node_type: "human",
          title: p.reason ?? "需要人工介入",
          body_json: { reason: p.reason } as never,
          x: jobNode.x + 150,
          y: jobNode.y - 160,
          status: "open",
        })}`;
    }
    return;
  }
}

// ---------- 结束处理 ----------

/**
 * 结束处理（§8.2）：done/failed 只能把 running 改为终态。
 * 迟到事件（job 已 cancelled/timeout/orphan）记录进 events 表但副作用返回 false，
 * 终态永不被迟到事件覆盖。
 */
export async function finalizeJob(tx: Tx, jobId: string, status: "succeeded" | "failed", result?: { summary?: string; error?: string; verdict?: string }) {
  const [updated] = await tx`
    UPDATE jobs SET status = ${status}, finished_at = now(), error = ${result?.error ?? null}
    WHERE id = ${jobId} AND status = 'running'
    RETURNING id`;
  if (!updated) {
    console.warn(`[finalize] job ${jobId} 已不在 running，忽略迟到 ${status} 事件副作用`);
    return false;
  }
  await tx`
    UPDATE canvas_nodes SET status = ${status}, body_json = body_json || ${tx.json({ summary: result?.summary ?? null })}, updated_at = now()
    WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;

  // §6.3：job 终态立即吊销短期模型 Token（容器残留也调不动模型；网关另按 job 状态逐请求兜底）
  const { revokeJobTokens } = await import("./gateway.js");
  await revokeJobTokens(jobId, `job_${status}`).catch(() => {});

  const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
  // §13.1 指标：终态计数 + 时长
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
    const { finalizeReportJob } = await import("./report.js");
    if (status === "succeeded") {
      await finalizeReportJob(tx, jobId, { summary: result?.summary ?? null });
    } else {
      await finalizeReportJob(tx, jobId, { failed: true, error: result?.error ?? "report_failed" });
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
  if (
    completedPayload.hub_followup === true &&
    job?.type !== "verify_finding" &&
    !isVerificationFollowup
  ) {
    forceHubReview = true;
    hubTrigger = { kind: "risk_acceptance_followup" };
  }

  // verify_finding：统一收口（证据硬门 + 回弹 / needs_human / confirmed）
  if (job?.type === "verify_finding" && job.finding_id) {
    const { closeVerifyRound } = await import("./verify.js");
    const closed = await closeVerifyRound(tx, jobId, {
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
    const { maybeReverifyAfterFollowup } = await import("./verify.js");
    await maybeReverifyAfterFollowup(tx, job);
  }

  // hub 循环（§8.3）：
  // - 成功 / verify 回弹：按既有 trigger 唤醒
  // - 任意终态后若画布已无待跑工作：canvas_idle 自动唤醒 Hub（含 hub 自身空决策结束）
  if (status === "succeeded" || forceHubReview) {
    await maybeTriggerHub(tx, job, {
      force: forceHubReview,
      sourceNodeIds: hubSourceNodeIds,
      trigger: hubTrigger,
    });
  }
  // 无论成功失败：统一推进画布终态。
  // Root 已 analysis_complete 时优先派 Report；否则按 canvas_idle 规则唤醒 Hub。
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
    const { closeVerifyRound } = await import("./verify.js");
    const closed = await closeVerifyRound(tx, jobId, {
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
          priority: job.priority ?? 0,
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

export type CanvasJobTerminalStatus =
  | "succeeded"
  | "failed"
  | "timeout"
  | "orphan"
  | "cancelled";

/**
 * 任意非 Report Job 进入终态后的统一画布推进。
 *
 * Hub 的 complete 提案与 mark_job_done 是两条独立事件：如果两者之间执行失败、
 * Reaper 收口或调度器重启，Root 已是 analysis_complete，但不会经过 succeeded finalize。
 * 因此所有终态入口都必须先尝试 Report，再回落到普通 canvas_idle Hub 唤醒。
 */
export async function advanceCanvasAfterTerminalJob(
  tx: Tx,
  job: Record<string, unknown>,
  terminalStatus: CanvasJobTerminalStatus,
  opts: {
    sourceNodeIds?: string[];
    trigger?: Record<string, unknown>;
  } = {},
): Promise<"report" | "hub" | "noop"> {
  const canvasId = job.canvas_id as string | null;
  if (!canvasId || job.type === "report") return "noop";

  const [root] = await tx`
    SELECT status FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
  if (root?.status === "analysis_complete" || root?.status === "reporting") {
    const { maybeDispatchReport } = await import("./report.js");
    await maybeDispatchReport(tx, canvasId);
    return "report";
  }

  await maybeTriggerHub(tx, job, {
    force: false,
    sourceNodeIds: opts.sourceNodeIds ?? [],
    trigger: opts.trigger ?? {
      kind: "canvas_idle",
      after_job_id: job.id,
      after_job_type: job.type,
      after_job_status: terminalStatus,
    },
    idleWake: true,
  });
  return "hub";
}

/**
 * 是否存在阻塞 Hub 的活跃 verify。
 * severities 非空时只统计这些 severity；空数组 = 任意 severity 的活跃 verify 都阻塞。
 */
async function hasActiveBlockingVerify(
  tx: Tx,
  canvasId: string,
  severities: string[],
): Promise<boolean> {
  if (severities.length === 0) {
    const rows = await tx`
      SELECT 1 FROM jobs
      WHERE canvas_id = ${canvasId} AND type = 'verify_finding'
        AND status IN ('pending','claimed','provisioning','running')
      LIMIT 1`;
    return rows.length > 0;
  }
  const rows = await tx`
    SELECT 1 FROM jobs j
    JOIN findings f ON f.id = j.finding_id
    WHERE j.canvas_id = ${canvasId} AND j.type = 'verify_finding'
      AND j.status IN ('pending','claimed','provisioning','running')
      AND lower(f.severity) = ANY(${severities})
    LIMIT 1`;
  return rows.length > 0;
}

async function hasActiveRoleJobs(tx: Tx, canvasId: string): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId}
      AND type NOT IN ('hub_reason', 'verify_finding', 'report')
      AND status IN ('pending','claimed','provisioning','running','waiting_human')
    LIMIT 1`;
  return rows.length > 0;
}

/** 画布上是否还有需要运行的工作节点（角色 / verify / hub / report）。 */
async function hasActiveRunnableJobs(
  tx: Tx,
  canvasId: string,
  excludeJobId?: string | null,
): Promise<boolean> {
  if (excludeJobId) {
    const rows = await tx`
      SELECT 1 FROM jobs
      WHERE canvas_id = ${canvasId}
        AND id <> ${excludeJobId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human')
      LIMIT 1`;
    return rows.length > 0;
  }
  const rows = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId}
      AND status IN ('pending','claimed','provisioning','running','waiting_human')
    LIMIT 1`;
  return rows.length > 0;
}

/** Root 是否已进入分析完成 / 报告 / 成功终态（不再需要 Hub 自驱）。 */
async function rootAnalysisFinished(tx: Tx, canvasId: string): Promise<boolean> {
  const [root] = await tx`
    SELECT status FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
  return ["analysis_complete", "reporting", "succeeded"].includes(String(root?.status ?? ""));
}

/**
 * 触发 Hub 读图决策。
 *
 * 唤醒条件（满足门禁后）：
 * 1. force / manual：显式回弹或人工
 * 2. idleWake：画布上没有待跑 job 节点时自动唤醒（§画布空闲 → Hub）
 * 3. 普通 graph_progress：角色/verify 推进后、关注级 verify 不阻塞时
 *
 * 不再在「关注级 verify 收敛」时 auto_stopped 停掉 Hub——空闲时应继续决策直到 complete。
 */
export async function maybeTriggerHub(
  tx: Tx,
  job: Record<string, unknown> | undefined,
  options: {
    force?: boolean;
    sourceNodeIds?: string[];
    trigger?: Record<string, unknown>;
    /** 人工 run-hub-now：忽略 hub_paused / auto_stopped */
    manual?: boolean;
    /**
     * 画布空闲唤醒：无待跑 job 时入队 Hub。
     * 允许在 hub_reason 终态后调用（避免 hub 空决策后画布卡死）。
     */
    idleWake?: boolean;
  } = {},
) {
  if (!job?.canvas_id) return;
  // 非 idle 路径：hub 自身终态不在这里递归；idle 路径专门处理「无待跑节点」
  if (job.type === "hub_reason" && !options.idleWake && !options.manual && !options.force) return;

  const canvasId = job.canvas_id as string;
  const projectId = job.project_id as string | undefined;
  if (!projectId) return;

  const rules = await rulesForProject(tx as unknown as typeof sql, projectId);
  if (!rules.hubEnabled && !options.force && !options.manual) return;

  // 分析已完成 / 报告中：不再唤醒 Hub
  if (await rootAnalysisFinished(tx, canvasId)) {
    return;
  }

  const convergence = await readCanvasConvergence(tx, canvasId);
  if (!options.manual) {
    if (convergence.hub_paused) {
      console.info(`[hub] 画布 ${canvasId} 已暂停决策（hub_paused），跳过`);
      return;
    }
    // force / idleWake（画布无待跑工作）可清 auto_stopped 继续自驱
    if (convergence.auto_stopped && !options.force && !options.idleWake) {
      console.info(`[hub] 画布 ${canvasId} 已自动停止自驱（auto_stopped），跳过`);
      return;
    }
    if (convergence.auto_stopped && (options.force || options.idleWake)) {
      await patchCanvasConvergence(tx as unknown as typeof sql, canvasId, {
        auto_stopped: false,
        paused_reason: undefined,
        paused_at: undefined,
      });
    }
  }

  // 已有活跃 Hub → 不重复入队
  const activeHub = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
      AND status IN ('pending', 'claimed', 'provisioning', 'running')
    LIMIT 1`;
  if (activeHub.length > 0) return;

  // idle 唤醒：必须确认画布上没有其它待跑节点（排除刚结束的 job）
  if (options.idleWake) {
    if (await hasActiveRunnableJobs(tx, canvasId, (job.id as string) ?? null)) {
      return;
    }
  } else if (!options.manual && !options.force) {
    // 普通路径：仍有角色 job 在跑则等它们结束（结束时会再触发）
    if (await hasActiveRoleJobs(tx, canvasId)) return;
  }

  // 关注级别 verify 阻塞非 force/manual 的 Hub（severity 只影响等待门，不决定是否验证）
  const waitSeverities = careSeverities(rules.minVerifySeverity);
  if (!options.manual && !options.force) {
    if (await hasActiveBlockingVerify(tx, canvasId, waitSeverities)) return;
  }

  // 预算只统计真正产出决策的轮次：failed/orphan 轮没有读图决策，
  // 计入预算会让排障/运维期的失败把 maxHubRounds 烧光。
  const [{ count }] = await tx<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM jobs
    WHERE canvas_id = ${canvasId} AND type = 'hub_reason' AND status = 'succeeded'`;
  if (count >= rules.maxHubRounds) {
    console.warn(`[hub] 画布 ${canvasId} 已达 hub 决策轮次上限 ${rules.maxHubRounds}，停止自驱`);
    // 护栏耗尽：pending/verifying → needs_human；仅当与 Hub complete 相同的统一完成门通过时才 Report
    const {
      settleCanvasFindingsAtGuardrail,
      evaluateAnalysisCompleteGate,
      hasSucceededRoleWork,
    } = await import("./verify.js");
    await settleCanvasFindingsAtGuardrail(tx, canvasId, "max_hub_rounds").catch((e) =>
      console.error(`[hub] settle findings at maxHubRounds failed:`, e),
    );
    const gate = await evaluateAnalysisCompleteGate(tx, canvasId, {
      excludeJobId: (job.id as string) ?? null,
    });
    if (gate.ok) {
      await tx`
        UPDATE canvas_nodes SET status = 'analysis_complete',
          body_json = body_json || ${tx.json({
            conclusion: `Hub 决策轮次达上限 ${rules.maxHubRounds}；未完成 Finding 已收口为 needs_human，自动进入报告。`,
            guardrail: "max_hub_rounds",
          })},
          updated_at = now()
        WHERE canvas_id = ${canvasId} AND node_type = 'root'
          AND status IS DISTINCT FROM 'succeeded'
          AND status IS DISTINCT FROM 'reporting'`;
      const { maybeDispatchReport } = await import("./report.js");
      await maybeDispatchReport(tx, canvasId).catch((e) =>
        console.error(`[hub] auto report after maxHubRounds failed:`, e),
      );
    } else {
      // 无角色工作 / 仍未收敛：停自驱并标人工，绝不空图成功报告
      const noRole = !(await hasSucceededRoleWork(tx, canvasId));
      await patchCanvasConvergence(tx as unknown as typeof sql, canvasId, {
        auto_stopped: true,
        paused_reason: noRole
          ? `max_hub_rounds_no_role_work:${rules.maxHubRounds}`
          : `max_hub_rounds_incomplete:${rules.maxHubRounds}`,
        paused_at: new Date().toISOString(),
      });
      console.warn(
        `[hub] maxHubRounds 后未过完成门 (${gate.blockers.join(",")})，auto_stopped，不派发 Report`,
      );
    }
    return;
  }

  const trigger = options.trigger ?? {
    kind: options.idleWake ? "canvas_idle" : "graph_progress",
  };
  const snapshot = await resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, "hub_reason");
  const [hubJob] = await tx`
    INSERT INTO jobs ${tx({
      project_id: projectId,
      canvas_id: canvasId,
      agent_snapshot_json: snapshot as never,
      type: "hub_reason",
      priority: ((job.priority as number) ?? 0) + 2, // hub 优先于普通角色 job，尽快收敛图
      payload_json: { trigger } as never,
      timeout_sec: rules.auditTimeoutSec,
      followup_depth: 0,
    })}
    RETURNING id`;

  // Hub 任务入队时立即上图；next 边表达“这些结论触发了下一轮 Agent 决策”。
  const [{ next_x }] = await tx<[{ next_x: number }]>`
    SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes
    WHERE canvas_id = ${canvasId}`;
  const title =
    options.force || options.manual
      ? "Hub 风险验收"
      : options.idleWake
        ? "Hub 空闲唤醒"
        : "Hub 决策";
  const [hubNode] = await tx`
    INSERT INTO canvas_nodes ${tx({
      canvas_id: canvasId,
      job_id: hubJob.id as string,
      node_type: "job",
      title,
      body_json: { type: "hub_reason", trigger } as never,
      x: next_x,
      y: 300,
      status: "pending",
    })}
    RETURNING id`;

  let sourceNodeIds = options.sourceNodeIds ?? [];
  if (sourceNodeIds.length === 0 && job.id) {
    const sources = await tx`
      SELECT id FROM canvas_nodes
      WHERE canvas_id = ${canvasId} AND job_id = ${job.id as string}
        AND node_type = ANY(${["fact", "finding", "intent", "job"]})`;
    sourceNodeIds = sources.map((source) => source.id as string);
  }
  if (sourceNodeIds.length === 0) {
    const [root] = await tx`
      SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
    if (root) sourceNodeIds = [root.id as string];
  }
  for (const sourceNodeId of sourceNodeIds) {
    await insertEdgeIfAbsent(
      tx,
      canvasId,
      sourceNodeId,
      hubNode.id as string,
      "next",
    );
  }

  console.info(
    `[hub] 画布 ${canvasId} 入队 Hub ${hubJob.id} trigger=${String((trigger as { kind?: string }).kind ?? "graph_progress")}` +
      (options.idleWake ? " (idleWake)" : "") +
      (options.force ? " (force)" : ""),
  );
}

/**
 * 人类对已确认 Finding 发表评论后：上图画布 + 唤醒 Hub 决策是否开新一轮。
 * - 仅 verify_status=confirmed（或 disposition=confirmed_vuln）触发
 * - 清除 auto_stopped，使自驱可继续
 * - 仍尊重 hub_paused（人工暂停时不抢跑）
 */
export async function triggerHubFromHumanComment(input: {
  findingId: string;
  commentId: string;
  commentBody: string;
  authorName: string;
}): Promise<{ hub_queued: boolean; reason?: string; canvas_id?: string; hub_job_id?: string }> {
  const [finding] = await sql`
    SELECT f.id, f.project_id, f.verify_status, f.disposition, f.title, f.node_id, f.job_id,
           j.canvas_id, j.priority
    FROM findings f
    JOIN jobs j ON j.id = f.job_id
    WHERE f.id = ${input.findingId}`;
  if (!finding) return { hub_queued: false, reason: "finding_not_found" };

  const confirmed =
    finding.verify_status === "confirmed" || finding.disposition === "confirmed_vuln";
  if (!confirmed) {
    return { hub_queued: false, reason: "not_confirmed", canvas_id: finding.canvas_id as string };
  }
  if (!finding.canvas_id) {
    return { hub_queued: false, reason: "no_canvas" };
  }

  const canvasId = finding.canvas_id as string;
  const projectId = finding.project_id as string;
  const preview = input.commentBody.trim().slice(0, 500);

  let hubJobId: string | undefined;
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Tx;

    // 画布 human 节点：进入 Hub 读图 hints，供决策参考
    const [findingNode] = finding.node_id
      ? await tx`SELECT id, x, y FROM canvas_nodes WHERE id = ${finding.node_id as string}`
      : [null];
    const x = findingNode ? (findingNode.x as number) + 40 : 200;
    const y = findingNode ? (findingNode.y as number) + 160 : 400;
    const [humanNode] = await tx`
      INSERT INTO canvas_nodes ${tx({
        canvas_id: canvasId,
        job_id: null,
        node_type: "human",
        title: `人工评论：${String(finding.title).slice(0, 80)}`,
        body_json: {
          reason: preview,
          kind: "finding_comment",
          finding_id: input.findingId,
          comment_id: input.commentId,
          author: input.authorName,
        } as never,
        x,
        y,
        status: "open",
      })}
      RETURNING id`;
    if (findingNode) {
      await insertEdgeIfAbsent(tx, canvasId, findingNode.id as string, humanNode.id as string, "next");
    }

    // 允许在「关注级别已收敛」后因人工反馈再决策
    await patchCanvasConvergence(tx as unknown as typeof sql, canvasId, {
      auto_stopped: false,
      paused_reason: undefined,
      paused_at: undefined,
    });

    const before = await tx`
      SELECT id FROM jobs WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
        AND status IN ('pending','claimed','provisioning','running') LIMIT 1`;

    await maybeTriggerHub(
      tx,
      {
        id: finding.job_id,
        project_id: projectId,
        canvas_id: canvasId,
        type: "human_comment",
        priority: (finding.priority as number) ?? 0,
      },
      {
        force: true,
        sourceNodeIds: [humanNode.id as string, ...(findingNode ? [findingNode.id as string] : [])],
        trigger: {
          kind: "human_comment",
          finding_id: input.findingId,
          comment_id: input.commentId,
          author: input.authorName,
          comment_preview: preview,
          finding_title: finding.title,
        },
      },
    );

    const after = await tx`
      SELECT id FROM jobs WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
        AND status IN ('pending','claimed','provisioning','running')
      ORDER BY created_at DESC LIMIT 1`;
    if (after[0] && (!before[0] || before[0].id !== after[0].id)) {
      hubJobId = after[0].id as string;
      await tx`
        UPDATE canvas_nodes SET title = 'Hub 人工反馈决策', updated_at = now()
        WHERE job_id = ${hubJobId} AND node_type = 'job'`;
    }
  });

  if (!hubJobId) {
    // 可能因 hub_paused / 已有活跃 hub / 轮次上限 未入队
    const conv = await readCanvasConvergence(sql, canvasId);
    if (conv.hub_paused) return { hub_queued: false, reason: "hub_paused", canvas_id: canvasId };
    return { hub_queued: false, reason: "hub_not_queued", canvas_id: canvasId };
  }
  return { hub_queued: true, canvas_id: canvasId, hub_job_id: hubJobId };
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
  "OPENROUTER_API_KEY",
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

/** 系统 Job 类型对应的角色配置名。 */
export function roleNameForJobType(jobType: string): string {
  if (jobType === "audit_module") return "audit";
  if (jobType === "verify_finding") return "verify";
  if (jobType === "report") return "report";
  return jobType;
}

/**
 * Dynamic test Jobs must consume the toolchain frozen into the selected
 * runtime image.  This policy is appended at snapshot time (rather than only
 * seeded in schema.sql) so existing databases and custom RoleConfigs receive
 * the same guard without overwriting operator-authored instructions.
 */
export const RUNTIME_TEST_TOOLCHAIN_POLICY = `### Runtime test toolchain (Scheduler policy)

This Job uses a Scheduler-selected, trusted runtime image. Before testing, read the frozen runtime manifest and verify only the preinstalled tools required by the target language: Java uses "command -v java" and "java -version"; Maven projects additionally use "command -v mvn" and "mvn -v" (and the versioned "java8"/"java11"/"java17" commands when required); Python uses the required "python3.x"/"uv" commands; Go uses "command -v go" and "go version"; Rust uses "command -v rustc"/"rustc --version" and "command -v cargo"/"cargo --version".

- Do **not** install or download JDK, Maven, Gradle, SDKMAN, or compiler toolchains in the sandbox. Do not use apt-get, curl/wget archives, ./mvnw, or equivalent bootstrap fallbacks for those tools.
- Project dependencies may be fetched only when the frozen DEEPSONAR_ALLOW_EGRESS policy permits it; dependency downloads are not a substitute for the prebuilt toolchain.
- If a required preinstalled command is missing, stop the dynamic attempt and submit structured inconclusive/needs-human evidence. Never claim a confirmed Finding from a static description alone.
- Record the runtime image key/digest, tool versions, target revision, exact steps, expected result, actual result, and limitations in emit_fact.verification for runtime-test evidence.`;

export function withRuntimeTestToolchainPolicy(
  roleName: string,
  instructions: string | null,
  resolvedRuntimeImageKey: string | null,
): string | null {
  // Test always performs runtime work. Verify receives the same guard only
  // when its project RoleConfig explicitly opts into a non-Base image; the
  // global Base Verify path remains suitable for static evidence review.
  const dynamicVerify =
    roleName === "verify" &&
    resolvedRuntimeImageKey !== null &&
    resolvedRuntimeImageKey !== "deepsonar-base";
  if (roleName !== "test" && !dynamicVerify) return instructions;
  const base = instructions?.trim() ?? "";
  if (base.includes("### Runtime test toolchain (Scheduler policy)")) return base;
  return `${base}${base ? "\n\n" : ""}${RUNTIME_TEST_TOOLCHAIN_POLICY}`;
}

/**
 * 解析 RoleConfig 并冻结为 Executor 运行快照。
 * 项目级 → 全局 → 平台缺省，无论哪一层都会产生完整快照。
 */
export async function resolveAgentSnapshotForJob(
  db: typeof sql,
  projectId: string,
  jobType: string,
): Promise<AgentRuntimeSnapshot> {
  warnIgnoredLegacyAgentDefaults();
  const roleName = roleNameForJobType(jobType);
  const [role] = await db`SELECT id, name, description, kind FROM agent_roles WHERE name = ${roleName}`;
  if (!role) throw new Error(`未注册的 Agent 角色: ${roleName}`);

  const [projectCfg] = await db`
    SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id = ${projectId}`;
  const [globalCfg] = projectCfg
    ? [undefined]
    : await db`SELECT * FROM role_configs WHERE role_id = ${role.id as string} AND project_id IS NULL`;
  const cfg = (projectCfg ?? globalCfg) as Record<string, unknown> | undefined;

  const modules = (cfg?.modules_json as string[]) ?? [];
  const expanded = await expandModules(modules);
  if (expanded.missing.length > 0) {
    console.warn(`[role-config] 模块未下发: ${expanded.missing.join(", ")}`);
  }
  const manualSkills = (cfg?.skills_json as { name?: string }[]) ?? [];
  const manualCommands = (cfg?.commands_json as { name?: string }[]) ?? [];
  const skills = [
    ...manualSkills,
    ...expanded.skills.filter((s) => !manualSkills.some((m) => m.name === (s as { name?: string }).name)),
  ];
  const commands = [
    ...manualCommands,
    ...expanded.commands.filter((c) => !manualCommands.some((m) => m.name === (c as { name?: string }).name)),
  ];

  const [llm] = cfg
    ? await db`
        SELECT c.id, c.name, c.provider, c.status, c.project_id AS cred_project_id, c.public_metadata_json
        FROM role_credentials rc
        JOIN credentials c ON c.id = rc.credential_id
        WHERE rc.role_config_id = ${cfg.id as string} AND rc.purpose = 'llm'
        LIMIT 1`
    : [undefined];
  if (llm) {
    const credProject = (llm.cred_project_id as string | null) ?? null;
    if (cfg?.project_id != null && credProject && credProject !== projectId) {
      throw new Error(`RoleConfig 引用了其他项目的 Credential ${llm.id}`);
    }
    if (cfg?.project_id == null && credProject) {
      throw new Error(`全局 RoleConfig 只能绑定全局 Credential`);
    }
    if ((llm.status as string) !== "active") {
      throw new Error(`Credential ${llm.id} 不可用（status=${String(llm.status)}）`);
    }
    const configuredModel = typeof cfg?.model === "string" && cfg.model.trim()
      ? cfg.model.trim()
      : PLATFORM_DEFAULT_AGENT_MODEL;
    const allowed = allowedModelIds(llm.public_metadata_json);
    if (allowed.length > 0 && !configuredModel) {
      throw new Error(`Credential ${llm.id} 已启用模型白名单，RoleConfig 必须显式选择模型`);
    }
    if (configuredModel && allowed.length > 0 && !allowed.includes(configuredModel)) {
      throw new Error(`模型 ${configuredModel} 不在 Credential ${llm.id} 的 allowed_model_ids 白名单`);
    }
  }
  const configFiles = cfg
    ? await db`
        SELECT path, content, content_sha256 FROM role_config_files
        WHERE role_config_id = ${cfg.id as string} ORDER BY path`
    : [];

  const reasoningRaw = (cfg?.reasoning as string | null) ?? null;
  const reasoning: ReasoningEffort | null =
    reasoningRaw === "low" || reasoningRaw === "medium" || reasoningRaw === "high" || reasoningRaw === "xhigh"
      ? reasoningRaw
      : null;
  const roleKind = role.kind as "role" | "hub" | "system";
  const platformTools = resolvePlatformTools(
    roleName,
    roleKind,
    (cfg?.platform_tools_json as PlatformToolConfig | undefined) ?? {},
  );
  const runtimeImageKey = (cfg?.runtime_image_key as string) ?? null;
  const runtimeImage = await resolveRuntimeImageForJob(db, projectId, roleName, runtimeImageKey);

  return {
    name: roleName,
    role_kind: roleKind,
    agent_cli: typeof cfg?.agent_cli === "string" && cfg.agent_cli.trim()
      ? cfg.agent_cli.trim()
      : PLATFORM_DEFAULT_AGENT_CLI,
    model: typeof cfg?.model === "string" && cfg.model.trim()
      ? cfg.model.trim()
      : PLATFORM_DEFAULT_AGENT_MODEL,
    reasoning,
    env_vars: cfg?.env_vars_json && typeof cfg.env_vars_json === "object"
      ? cfg.env_vars_json as Record<string, string>
      : {},
    env_keys: (cfg?.env_keys as string[]) ?? [],
    credential_id: (llm?.id as string) ?? null,
    credential_name: (llm?.name as string) ?? null,
    credential_provider: (llm?.provider as string) ?? null,
    modules,
    skill_revisions: expanded.revisions,
    skills,
    commands,
    mcps: (cfg?.mcps_json as unknown[]) ?? [],
    subagents: (cfg?.subagents_json as unknown[]) ?? [],
    role_description: (role.description as string) ?? roleName,
    instructions_markdown: withRuntimeTestToolchainPolicy(
      roleName,
      (cfg?.instructions_markdown as string) ?? null,
      runtimeImage.image_key,
    ),
    platform_tools: platformTools,
    config_files: configFiles as unknown as { path: string; content: string; content_sha256: string }[],
    role_config_id: (cfg?.id as string) ?? null,
    role_config_version: (cfg?.version as number) ?? null,
    // null 表示 RoleConfig 未绑定市场镜像；runtime_image 仍记录系统沙箱实际使用的不可变底座。
    runtime_image_key: runtimeImageKey,
    runtime_image: runtimeImage,
  };
}
