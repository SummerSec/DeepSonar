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
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { expandModules } from "./skill-sources.js";

// ---------- 状态机（§3.3）：允许的状态迁移 ----------

const TRANSITIONS: Record<string, string[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["provisioning", "cancelled", "failed"],
  provisioning: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "timeout", "orphan", "cancelled", "waiting_human"],
  waiting_human: ["pending", "cancelled", "failed"], // resume → pending 重入队
  // 终态失败可经人工 resume 复活（原执行恢复，区别于 retry 新建 job）；
  // cancelled 是最终人工意图不可复活（要重跑用 /tasks/:id/retry）
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

/** confirmed 后如何触发 Hub（见 docs/TODO_VERIFY_PRIORITY_AND_CONVERGENCE_PLAN.md） */
export type ConfirmedHubMode = "immediate" | "gated" | "batch" | "off";
/** 自驱自动停止策略 */
export type AutoStopMode = "never" | "after_wait_gate" | "after_all_auto_verify";

export interface ProjectRules {
  autoVerifySeverities: string[];
  maxFollowupsPerJob: number;
  maxFollowupDepth: number;
  maxAutoRetries: number;
  auditTimeoutSec: number;
  verifyTimeoutSec: number;
  /** hub 循环：角色 job 成功后触发 hub_reason 读图决策（§8.3） */
  hubEnabled: boolean;
  maxHubRounds: number;
  maxIntentsPerDecision: number;
  /** Worker 是否可访问模型网关之外的网络；任务创建时可覆盖并冻结。 */
  allowEgress: boolean;
  /** claim 时是否按 severity 抬升 verify job 优先级 */
  verifySeverityPriority: boolean;
  /** confirmed 后 Hub 触发模式 */
  confirmedHubMode: ConfirmedHubMode;
  /**
   * Hub 等待门：这些 severity 的活跃 verify 会阻塞非 immediate Hub。
   * 空数组时回落到 autoVerifySeverities。
   */
  hubWaitSeverities: string[];
  /** 门控/全量 auto-verify 终态后是否停止自动 maybeTriggerHub */
  autoStopMode: AutoStopMode;
  /** batch 模式 debounce 秒数（Phase 3；当前 batch 按 gated 处理） */
  confirmedHubBatchSec: number;
}

/** 画布收敛控制态（落在 canvases.target_json.convergence，免 schema 迁移） */
export interface CanvasConvergence {
  hub_paused: boolean;
  paused_reason?: string;
  paused_at?: string;
  auto_stopped: boolean;
  pending_confirmed_ids?: string[];
}

const CONFIRMED_HUB_MODES = new Set<ConfirmedHubMode>(["immediate", "gated", "batch", "off"]);
const AUTO_STOP_MODES = new Set<AutoStopMode>(["never", "after_wait_gate", "after_all_auto_verify"]);

const SEVERITY_PRIORITY_DELTA: Record<string, number> = {
  critical: 40,
  high: 30,
  medium: 10,
  low: 0,
  info: -5,
};

function asStringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

function asConfirmedHubMode(v: unknown, fallback: ConfirmedHubMode): ConfirmedHubMode {
  const s = String(v ?? "").trim().toLowerCase() as ConfirmedHubMode;
  return CONFIRMED_HUB_MODES.has(s) ? s : fallback;
}

function asAutoStopMode(v: unknown, fallback: AutoStopMode): AutoStopMode {
  const s = String(v ?? "").trim().toLowerCase() as AutoStopMode;
  return AUTO_STOP_MODES.has(s) ? s : fallback;
}

/** env 兜底默认值（全局规则未配置时的最终回落） */
function envDefaultRules(): ProjectRules {
  return {
    autoVerifySeverities: config.rules.autoVerifySeverities,
    maxFollowupsPerJob: config.limits.maxFollowupsPerJob,
    maxFollowupDepth: config.limits.maxFollowupDepth,
    maxAutoRetries: config.limits.maxAutoRetries,
    auditTimeoutSec: config.timeouts.auditSec,
    verifyTimeoutSec: config.timeouts.verifySec,
    hubEnabled: config.hub.enabled,
    maxHubRounds: config.hub.maxRounds,
    maxIntentsPerDecision: config.hub.maxIntents,
    allowEgress: true,
    verifySeverityPriority: true,
    confirmedHubMode: "gated",
    hubWaitSeverities: ["critical", "high"],
    autoStopMode: "after_wait_gate",
    confirmedHubBatchSec: 60,
  };
}

function mergeRulesLayer(raw: Record<string, unknown>, base: ProjectRules): ProjectRules {
  return {
    autoVerifySeverities: asStringArray(raw.autoVerifySeverities, base.autoVerifySeverities),
    maxFollowupsPerJob: (raw.maxFollowupsPerJob as number) ?? base.maxFollowupsPerJob,
    maxFollowupDepth: (raw.maxFollowupDepth as number) ?? base.maxFollowupDepth,
    maxAutoRetries: (raw.maxAutoRetries as number) ?? base.maxAutoRetries,
    auditTimeoutSec: (raw.auditTimeoutSec as number) ?? base.auditTimeoutSec,
    verifyTimeoutSec: (raw.verifyTimeoutSec as number) ?? base.verifyTimeoutSec,
    hubEnabled: (raw.hubEnabled as boolean) ?? base.hubEnabled,
    maxHubRounds: (raw.maxHubRounds as number) ?? base.maxHubRounds,
    maxIntentsPerDecision: (raw.maxIntentsPerDecision as number) ?? base.maxIntentsPerDecision,
    allowEgress: (raw.allowEgress as boolean) ?? base.allowEgress,
    verifySeverityPriority: (raw.verifySeverityPriority as boolean) ?? base.verifySeverityPriority,
    confirmedHubMode: asConfirmedHubMode(raw.confirmedHubMode, base.confirmedHubMode),
    hubWaitSeverities: asStringArray(raw.hubWaitSeverities, base.hubWaitSeverities),
    autoStopMode: asAutoStopMode(raw.autoStopMode, base.autoStopMode),
    confirmedHubBatchSec: (raw.confirmedHubBatchSec as number) ?? base.confirmedHubBatchSec,
  };
}

/** 解析 Hub 等待门 severity；未配置时回落 autoVerifySeverities */
export function resolveHubWaitSeverities(rules: ProjectRules): string[] {
  const wait = rules.hubWaitSeverities.map((s) => s.toLowerCase()).filter(Boolean);
  if (wait.length > 0) return wait;
  return rules.autoVerifySeverities.map((s) => s.toLowerCase()).filter(Boolean);
}

export function severityPriorityDelta(severity: string | null | undefined): number {
  return SEVERITY_PRIORITY_DELTA[String(severity ?? "").toLowerCase()] ?? 0;
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
  return mergeRulesLayer(r, mergeRulesLayer(gr, envDefaultRules()));
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
  /** 绑定的 Provider Credential（§6.2）：快照只存 id/provider，密钥运行时解密，不进快照 */
  credential_id: string | null;
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

    // 规则引擎：派生验证（§4.3 单一决策点）
    await evaluateFollowup(tx, job, finding);
    return;
  }

  if (type === "fact") {
    // 角色 agent 的发现 → fact 节点（§8.3：agent 只负责把发现写入画布）
    const p = payload as { intent_node_id?: string; title?: string; description?: string };
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
      // 结论：引用 facts 收敛到 root；root 置 succeeded + 结论入 body
      const [root] = await tx`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
      if (root) {
        await tx`
          UPDATE canvas_nodes SET status = 'succeeded',
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
      const trigger = ((job.payload_json as Record<string, unknown> | undefined)?.trigger ?? {}) as {
        kind?: string;
      };
      const hubFollowup = ["confirmed_finding", "risk_acceptance_followup"].includes(trigger.kind ?? "");
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
            ...(hubFollowup ? { hub_followup: true } : {}),
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

// ---------- 规则引擎：finding → verify 派生（§4.3） ----------

async function evaluateFollowup(tx: Tx, job: Record<string, unknown>, finding: Record<string, unknown>) {
  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
  if ((job.followup_depth as number) >= rules.maxFollowupDepth) return;

  // severity 门控：仅 autoVerifySeverities 内的 finding 自动派生 verify（人工点验另走 API）
  const severity = String(finding.severity ?? "").toLowerCase();
  const allowed = new Set(rules.autoVerifySeverities.map((s) => s.toLowerCase()));
  if (!allowed.has(severity)) return;

  // 同一 finding 已有 verify job → 不重复派生
  const existing = await tx`
    SELECT 1 FROM jobs WHERE finding_id = ${finding.id as string} AND type = 'verify_finding' LIMIT 1`;
  if (existing.length > 0) return;

  // 每 job followup 上限（§4.3 护栏）
  const [{ count }] = await tx<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM jobs WHERE parent_job_id = ${job.id as string}`;
  if (count >= rules.maxFollowupsPerJob) {
    // 超限转人工
    await applySideEffects(tx, job.id as string, "human", {
      reason: `followup 数超过上限 ${rules.maxFollowupsPerJob}，请人工确认`,
    });
    return;
  }

  const snapshot = await resolveAgentSnapshotForJob(
    tx as unknown as typeof sql,
    job.project_id as string,
    "verify_finding",
  );

  const basePriority = (job.priority as number) + 1;
  const priority = rules.verifySeverityPriority
    ? basePriority + severityPriorityDelta(severity)
    : basePriority;

  const [verifyJob] = await tx`
    INSERT INTO jobs ${tx({
      project_id: job.project_id as string,
      canvas_id: (job.canvas_id as string) ?? null, // 继承父审计 job 的任务画布
      agent_snapshot_json: snapshot as never,
      plane_issue_id: null,
      parent_job_id: job.id as string,
      finding_id: finding.id as string,
      type: "verify_finding",
      priority,
      payload_json: {
        finding: {
          fingerprint: finding.fingerprint,
          title: finding.title,
          location: finding.location,
          summary: finding.summary,
          severity,
        },
      } as never,
      timeout_sec: rules.verifyTimeoutSec,
      followup_depth: (job.followup_depth as number) + 1,
    })}
    RETURNING id`;
  await tx`UPDATE findings SET verify_status = 'verifying' WHERE id = ${finding.id as string}`;

  // 验证任务创建时立即上图：finding → verify，画布先展示待执行链路，而不是结束后补边。
  const [findingNode] = await tx`
    SELECT node_id FROM findings WHERE id = ${finding.id as string}`;
  if (findingNode?.node_id) {
    const [source] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes WHERE id = ${findingNode.node_id}`;
    if (source) {
      const [verifyNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: source.canvas_id as string,
          job_id: verifyJob.id as string,
          node_type: "job",
          title: `验证：${String(finding.title).slice(0, 100)}`,
          body_json: { type: "verify_finding", finding_id: finding.id } as never,
          x: (source.x as number) + 340,
          y: source.y as number,
          status: "pending",
        })}
        RETURNING id`;
      await insertEdgeIfAbsent(
        tx,
        source.canvas_id as string,
        source.id as string,
        verifyNode.id as string,
        "verifies",
      );
      await tx`UPDATE canvas_nodes SET status = 'verifying', updated_at = now() WHERE id = ${source.id}`;
    }
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
    WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]})`;

  // §6.3：job 终态立即吊销短期模型 Token（容器残留也调不动模型；网关另按 job 状态逐请求兜底）
  const { revokeJobTokens } = await import("./gateway.js");
  await revokeJobTokens(jobId, `job_${status}`).catch(() => {});

  // verify_finding 闭环：结论写回 finding；confirmed 按 confirmedHubMode 触发 Hub。
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
  let forceHubReview = false;
  let hubSourceNodeIds: string[] = [];
  let hubTrigger: Record<string, unknown> | undefined;
  const completedPayload = (job?.payload_json ?? {}) as Record<string, unknown>;
  if (completedPayload.hub_followup === true) {
    forceHubReview = true;
    hubTrigger = { kind: "risk_acceptance_followup" };
  }
  if (job?.type === "verify_finding" && job.finding_id && status === "succeeded") {
    const verdict = result?.verdict ?? "needs_human";
    await tx`UPDATE findings SET verify_status = ${verdict} WHERE id = ${job.finding_id}`;
    const [verifyNode] = await tx`
      SELECT id, canvas_id FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'job'`;
    const [finding] = await tx`SELECT node_id FROM findings WHERE id = ${job.finding_id}`;
    if (verifyNode && finding?.node_id) {
      await tx`
        UPDATE canvas_nodes SET status = ${verdict}, updated_at = now() WHERE id = ${finding.node_id}`;
      if (verdict === "confirmed") {
        const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
        // batch 一期按 gated 处理；off = 不因 confirmed 单独 force
        const mode = rules.confirmedHubMode === "batch" ? "gated" : rules.confirmedHubMode;
        if (mode !== "off") {
          forceHubReview = true;
          hubSourceNodeIds = [finding.node_id as string];
          hubTrigger = { kind: "confirmed_finding", finding_id: job.finding_id, mode };
        }
      }
    }
  }

  // hub 循环（§8.3）：非 hub job 成功后触发 hub_reason 读图决策（单画布同一时间最多一个活跃 hub）
  if (status === "succeeded") {
    await maybeTriggerHub(tx, job, {
      force: forceHubReview,
      sourceNodeIds: hubSourceNodeIds,
      trigger: hubTrigger,
    });
  }
  return true;
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

/** 门控 severity 的 verify 是否均已终态（无 pending/running 等） */
async function gateVerifiesSettled(tx: Tx, canvasId: string, severities: string[]): Promise<boolean> {
  if (severities.length === 0) return !(await hasActiveBlockingVerify(tx, canvasId, []));
  return !(await hasActiveBlockingVerify(tx, canvasId, severities));
}

async function hasActiveRoleJobs(tx: Tx, canvasId: string): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId}
      AND type NOT IN ('hub_reason', 'verify_finding')
      AND status IN ('pending','claimed','provisioning','running','waiting_human')
    LIMIT 1`;
  return rows.length > 0;
}

export async function maybeTriggerHub(
  tx: Tx,
  job: Record<string, unknown> | undefined,
  options: {
    force?: boolean;
    sourceNodeIds?: string[];
    trigger?: Record<string, unknown>;
    /** 人工 run-hub-now：忽略 hub_paused / auto_stopped */
    manual?: boolean;
  } = {},
) {
  if (!job?.canvas_id || job.type === "hub_reason") return;
  const canvasId = job.canvas_id as string;
  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
  if (!rules.hubEnabled && !options.force && !options.manual) return;

  const convergence = await readCanvasConvergence(tx, canvasId);
  if (!options.manual) {
    if (convergence.hub_paused) {
      console.info(`[hub] 画布 ${canvasId} 已暂停决策（hub_paused），跳过`);
      return;
    }
    if (convergence.auto_stopped) {
      console.info(`[hub] 画布 ${canvasId} 已自动停止自驱（auto_stopped），跳过`);
      return;
    }
  }

  const waitSeverities = resolveHubWaitSeverities(rules);
  const mode = rules.confirmedHubMode === "batch" ? "gated" : rules.confirmedHubMode;
  // immediate force 才完全绕过等待门；gated force / 普通路径都要等门控 severity
  const bypassWait = Boolean(options.force && mode === "immediate") || Boolean(options.manual);
  if (!bypassWait) {
    if (await hasActiveBlockingVerify(tx, canvasId, waitSeverities)) return;
  }

  // 自动停止：门控（或全部 auto-verify）验完且无活跃角色 job 时标记并停自驱
  if (!options.manual && !options.force && rules.autoStopMode !== "never") {
    const stopSeverities =
      rules.autoStopMode === "after_all_auto_verify"
        ? rules.autoVerifySeverities.map((s) => s.toLowerCase())
        : waitSeverities;
    if ((await gateVerifiesSettled(tx, canvasId, stopSeverities)) && !(await hasActiveRoleJobs(tx, canvasId))) {
      await patchCanvasConvergence(tx, canvasId, {
        auto_stopped: true,
        paused_reason: `autoStopMode=${rules.autoStopMode}`,
        paused_at: new Date().toISOString(),
      });
      console.info(`[hub] 画布 ${canvasId} 触发 ${rules.autoStopMode}，标记 auto_stopped`);
      return;
    }
  }

  const active = await tx`
    SELECT 1 FROM jobs
    WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
      AND status IN ('pending', 'claimed', 'provisioning', 'running')
    LIMIT 1`;
  if (active.length > 0) return;

  // 预算只统计真正产出决策的轮次：failed/orphan 轮没有读图决策，
  // 计入预算会让排障/运维期的失败把 maxHubRounds 烧光，画布在仍有 verify 验收需求时提前停止自驱。
  const [{ count }] = await tx<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM jobs
    WHERE canvas_id = ${canvasId} AND type = 'hub_reason' AND status = 'succeeded'`;
  if (count >= rules.maxHubRounds) {
    console.warn(`[hub] 画布 ${canvasId} 已达 hub 决策轮次上限 ${rules.maxHubRounds}，停止自驱`);
    return;
  }

  const snapshot = await resolveAgentSnapshotForJob(tx as unknown as typeof sql, job.project_id as string, "hub_reason");
  const [hubJob] = await tx`
    INSERT INTO jobs ${tx({
      project_id: job.project_id as string,
      canvas_id: canvasId,
      agent_snapshot_json: snapshot as never,
      type: "hub_reason",
      priority: ((job.priority as number) ?? 0) + 2, // hub 优先于普通角色 job，尽快收敛图
      payload_json: { trigger: options.trigger ?? { kind: "graph_progress" } } as never,
      timeout_sec: rules.auditTimeoutSec,
      followup_depth: 0,
    })}
    RETURNING id`;

  // Hub 任务入队时立即上图；next 边表达“这些结论触发了下一轮 Agent 决策”。
  const [{ next_x }] = await tx<[{ next_x: number }]>`
    SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes
    WHERE canvas_id = ${canvasId}`;
  const [hubNode] = await tx`
    INSERT INTO canvas_nodes ${tx({
      canvas_id: canvasId,
      job_id: hubJob.id as string,
      node_type: "job",
      title: options.force || options.manual ? "Hub 风险验收" : "Hub 决策",
      body_json: { type: "hub_reason", trigger: options.trigger ?? { kind: "graph_progress" } } as never,
      x: next_x,
      y: 300,
      status: "pending",
    })}
    RETURNING id`;

  let sourceNodeIds = options.sourceNodeIds ?? [];
  if (sourceNodeIds.length === 0) {
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
  return jobType;
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
        SELECT c.id, c.provider, c.status, c.project_id AS cred_project_id
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

  return {
    name: roleName,
    role_kind: roleKind,
    agent_cli: (cfg?.agent_cli as string) ?? config.runtime.agentProvider,
    model: (cfg?.model as string) ?? config.runtime.agentModel ?? null,
    reasoning,
    env_vars: (cfg?.env_vars_json as Record<string, string>) ?? config.runtime.agentEnv,
    env_keys: (cfg?.env_keys as string[]) ?? [],
    credential_id: (llm?.id as string) ?? null,
    credential_provider: (llm?.provider as string) ?? null,
    modules,
    skill_revisions: expanded.revisions,
    skills,
    commands,
    mcps: (cfg?.mcps_json as unknown[]) ?? [],
    subagents: (cfg?.subagents_json as unknown[]) ?? [],
    role_description: (role.description as string) ?? roleName,
    instructions_markdown: (cfg?.instructions_markdown as string) ?? null,
    platform_tools: platformTools,
    config_files: configFiles as unknown as { path: string; content: string; content_sha256: string }[],
    role_config_id: (cfg?.id as string) ?? null,
    role_config_version: (cfg?.version as number) ?? null,
    runtime_image_key: (cfg?.runtime_image_key as string) ?? null,
  };
}
