import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import {
  advanceCanvasAfterTerminalJob,
  DISPATCH_CLAIM_ADVISORY_KEY,
  globalRules,
  ingestEvent,
  PLATFORM_DEFAULT_AGENT_CLI,
  projectJobQuotaFromConfig,
  recoverVerifyJobTerminal,
  rolesForProject,
  type AgentRuntimeSnapshot,
  type ProjectRules,
} from "./core.js";
import { credentialConcurrencyPolicy } from "./credentials.js";
import { snapshotUpstreamModel } from "./provider-effective-model.js";
import { sql } from "./db.js";
import { buildJobSharedAssetCatalog, materializeSharedAssetBlob, SHARED_ASSETS_READONLY_ROOT } from "./domains/shared-assets/index.js";
import { executeReal, preparePlatformCapability, type PreparedPlatformCapability } from "./executor-real.js";
import { inc } from "./metrics.js";
import { planeWriteback } from "./plane-sync.js";
import { runner, sharedAssetsVolumeManager } from "./runtime.js";
import { assertRuntimeImageAvailable, RuntimeImageNotReadyError, shouldInspectLocalRuntimeImage } from "./runtime-images.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { activateProvisionedJobCapabilityTokens, revokeJobCapabilityTokens } from "./domains/platform-api/tokens.js";
import {
  beginEffect,
  createOrGetActiveAttempt,
  getActiveAttempt,
  interruptProvision,
  markEffectUnknown,
  registerProvisionCancellation,
  settleEffect,
  settleAttemptTerminal,
  updateAttemptResource,
} from "./domains/job-attempt/index.js";

export function classifyDispatcherFailure(error: unknown): { reason: string; message: string } {
  if (error instanceof RuntimeImageNotReadyError) {
    return { reason: "runtime_image_not_ready", message: `runtime_image_not_ready: ${error.imageRef}` };
  }
  return { reason: "exception", message: error instanceof Error ? error.message : String(error) };
}
import { finalizeReportJob } from "./report.js";
import { canvasFindingsConverged, collectEvidenceSnapshot } from "./verify.js";
import {
  assertChromeRuntimeEgressAllowed,
  requireFrozenSnapshotAllowEgress,
} from "./domains/role-runtime-snapshot/index.js";
import { bindScheduleWake, refreshScheduleWakeFromDb } from "./schedule-wake.js";
import { canvasScheduleBlocksDispatch } from "./task-schedule.js";
import { canvasExecutionIsPaused } from "./task-execution-control.js";
import { hostDiskAllowsDispatch, refreshHostDiskPressure } from "./host-disk.js";

/**
 * Dispatcher（§4.2 调度循环的 DB 侧）：
 * 从 pending 领取 job（遵守全局/每项目并发上限）→ claimed → provisioning → running
 * fake 模式走通状态机 + 事件 + 画布 + lease，不启动真实 Agent。
 */

const activeLeases = new Map<string, ReturnType<typeof setInterval>>();

/** Kept as a dispatcher export for existing diagnostics/tests. */
export { CHROME_RUNTIME_IMAGE_KEYS } from "./domains/role-runtime-snapshot/index.js";

/** 在执行的 job（优雅退出 drain 用，§12.2） */
const inFlight = new Set<Promise<void>>();

export type DispatchCandidate = {
  id?: unknown;
  project_id: unknown;
  canvas_id?: unknown;
  finding_id?: unknown;
  type?: unknown;
  payload_json?: unknown;
  canvas_target_json?: unknown;
  project_config_json?: unknown;
  agent_cli: unknown;
  credential_provider: unknown;
  credential_id: unknown;
  model: unknown;
  upstream_model?: unknown;
  credential_metadata: unknown;
  agent_snapshot_json?: unknown;
};

function attemptSnapshotIdentity(snapshot: unknown): Record<string, string> {
  const value = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const runtimeImage = value.runtime_image && typeof value.runtime_image === "object" && !Array.isArray(value.runtime_image)
    ? value.runtime_image as Record<string, unknown>
    : {};
  const adapter = value.agent_runtime && typeof value.agent_runtime === "object" && !Array.isArray(value.agent_runtime)
    ? value.agent_runtime as Record<string, unknown>
    : {};
  const identity = {
    ...(typeof value.agent_cli === "string" ? { agent_cli: value.agent_cli } : {}),
    ...(typeof value.snapshot_sha256 === "string" ? { snapshot_sha256: value.snapshot_sha256 } : {}),
    ...(typeof adapter.adapter_id === "string" ? { adapter_id: adapter.adapter_id } : {}),
    ...(typeof adapter.adapter_version === "string" ? { adapter_version: adapter.adapter_version } : {}),
    ...(typeof runtimeImage.image_ref === "string" ? { runtime_image_ref: runtimeImage.image_ref } : {}),
    ...(typeof runtimeImage.image_key === "string" ? { runtime_image_key: runtimeImage.image_key } : {}),
  };
  if (!identity.snapshot_sha256) {
    identity.snapshot_sha256 = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  return identity;
}

export interface GraphEligibilityState {
  activeHub?: boolean;
  activeWaitingHuman?: boolean;
  activeRole?: boolean;
  pendingHubOlder?: boolean;
  pendingReportOlder?: boolean;
  waitingEvidence?: boolean;
  rootStatus?: string | null;
  activeCanvasJob?: boolean;
}

/** Page-scoped graph facts loaded once before candidate evaluation. */
export interface GraphEligibilityBatch {
  verifyWaitingIds: ReadonlySet<string>;
  systemStates: ReadonlyMap<string, GraphEligibilityState>;
}

/**
 * Verify eligibility used to issue one round lookup per pending candidate.
 * Load the bounded page's waiting-evidence markers in one query instead, so a
 * large backlog cannot turn the dispatcher claim transaction into an N+1
 * advisory/row-lock fanout.
 */
export async function loadGraphEligibilityBatch(
  tx: typeof sql,
  pending: readonly DispatchCandidate[],
): Promise<GraphEligibilityBatch> {
  const verifyIds = pending
    .filter((job) => String(job.type ?? "") === "verify_finding" && job.id)
    .map((job) => String(job.id));
  const canvasIds = [...new Set(
    pending
      .filter((job) => ["hub_reason", "report"].includes(String(job.type ?? "")) && job.canvas_id)
      .map((job) => String(job.canvas_id)),
  )];
  const [verifyRows, systemRows, oldestRows] = await Promise.all([
    verifyIds.length > 0
      ? tx`
          SELECT verify_job_id
          FROM finding_verification_rounds
          WHERE verify_job_id = ANY(${verifyIds}::uuid[])
            AND status IN ('pending','running')
            AND requirements_json->>'eligibility' = 'waiting_evidence'`
      : Promise.resolve([]),
    canvasIds.length > 0
      ? tx`
          WITH requested AS (
            SELECT canvas_id
            FROM unnest(${canvasIds}::text[]) AS input(canvas_id)
          ),
          node_state AS (
            SELECT n.canvas_id,
                   MAX(n.status) FILTER (WHERE n.node_type = 'root') AS root_status
            FROM canvas_nodes n
            JOIN requested r ON r.canvas_id = n.canvas_id
            GROUP BY n.canvas_id
          ),
          job_state AS (
            SELECT j.canvas_id,
                   COALESCE(BOOL_OR(j.type = 'hub_reason' AND j.status IN ('claimed','provisioning','running','waiting_human')), false) AS active_hub,
                   COALESCE(BOOL_OR(j.status = 'waiting_human'), false) AS active_waiting_human,
                   COALESCE(BOOL_OR(j.type NOT IN ('hub_reason','verify_finding','report')
                     AND j.status IN ('pending','claimed','provisioning','running','waiting_human')), false) AS active_role,
                   COALESCE(BOOL_OR(
                     j.status IN ('claimed','provisioning','running','waiting_human')
                     OR (j.status = 'pending' AND j.type <> 'report')
                   ), false) AS active_canvas_job
            FROM jobs j
            JOIN requested r ON r.canvas_id = j.canvas_id
            GROUP BY j.canvas_id
          )
          SELECT r.canvas_id,
                 ns.root_status,
                 COALESCE(js.active_hub, false) AS active_hub,
                 COALESCE(js.active_waiting_human, false) AS active_waiting_human,
                 COALESCE(js.active_role, false) AS active_role,
                 COALESCE(js.active_canvas_job, false) AS active_canvas_job
          FROM requested r
          LEFT JOIN node_state ns ON ns.canvas_id = r.canvas_id
          LEFT JOIN job_state js ON js.canvas_id = r.canvas_id`
      : Promise.resolve([]),
    canvasIds.length > 0
      ? tx`
          SELECT canvas_id,
                 (array_agg(id ORDER BY created_at ASC, id ASC) FILTER (WHERE type = 'hub_reason'))[1] AS oldest_hub_id,
                 (array_agg(id ORDER BY created_at ASC, id ASC) FILTER (
                   WHERE type = 'report'
                     AND COALESCE(payload_json->>'kind', 'task_report') <> 'finding_report'
                 ))[1] AS oldest_task_report_id,
                 (array_agg(id ORDER BY created_at ASC, id ASC) FILTER (
                   WHERE type = 'report'
                     AND payload_json->>'kind' = 'finding_report'
                 ))[1] AS oldest_finding_report_id
          FROM jobs
          WHERE canvas_id = ANY(${canvasIds}::text[])
            AND status = 'pending'
            AND type IN ('hub_reason','report')
          GROUP BY canvas_id`
      : Promise.resolve([]),
  ]);
  const systemByCanvas = new Map<string, Record<string, unknown>>(
    systemRows.map((row) => [String(row.canvas_id), row as Record<string, unknown>]),
  );
  const oldestByCanvas = new Map<string, Record<string, unknown>>(
    oldestRows.map((row) => [String(row.canvas_id), row as Record<string, unknown>]),
  );
  const systemStates = new Map<string, GraphEligibilityState>();
  for (const job of pending) {
    const type = String(job.type ?? "");
    if (type !== "hub_reason" && type !== "report") continue;
    const canvasId = String(job.canvas_id ?? "").trim();
    if (!canvasId) continue;
    const current = systemByCanvas.get(canvasId);
    const oldest = oldestByCanvas.get(canvasId);
    if (!current) continue;
    const reportScope = type === "report" && parseDispatchPayload(job.payload_json).kind === "finding_report"
      ? "finding_report"
      : "task_report";
    const oldestReportId = reportScope === "finding_report"
      ? oldest?.oldest_finding_report_id
      : oldest?.oldest_task_report_id;
    systemStates.set(String(job.id ?? ""), {
      activeHub: Boolean(current.active_hub),
      activeWaitingHuman: Boolean(current.active_waiting_human),
      activeRole: Boolean(current.active_role),
      activeCanvasJob: Boolean(current.active_canvas_job),
      rootStatus: (current.root_status as string | null) ?? null,
      pendingHubOlder: Boolean(oldest?.oldest_hub_id && oldest.oldest_hub_id !== job.id),
      pendingReportOlder: Boolean(oldestReportId && oldestReportId !== job.id),
    });
  }
  return {
    verifyWaitingIds: new Set(verifyRows.map((row) => String(row.verify_job_id))),
    systemStates,
  };
}

/** Pure graph-stage gate kept separate from numeric ordering/resource caps. */
export function graphEligibilityReason(
  job: Pick<DispatchCandidate, "type" | "payload_json">,
  state: GraphEligibilityState,
): string | null {
  const type = String(job.type ?? "");
  if (type === "hub_reason") {
    if (state.activeHub) return "hub_active";
    if (state.activeWaitingHuman) return "waiting_human";
    if (state.pendingHubOlder) return "hub_pending_older";
    if (state.activeRole) return "canvas_busy";
    if (state.rootStatus && ["analysis_complete", "reporting", "succeeded"].includes(state.rootStatus)) {
      return "root_finished";
    }
  }
  if (type === "verify_finding" && state.waitingEvidence) return "waiting_evidence";
  if (type === "report") {
    if (state.pendingReportOlder) return "report_pending_older";
    const payload = parseDispatchPayload(job.payload_json);
    const findingScoped = payload.kind === "finding_report";
    if (!findingScoped && (state.activeCanvasJob || !["analysis_complete", "reporting"].includes(String(state.rootStatus)))) {
      return "report_gate";
    }
  }
  return null;
}

/** JSONB is normally decoded by postgres.js, but characterize legacy/string
 * snapshots too so the report scope is never silently lost at the gate. */
function parseDispatchPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid/legacy payloads retain the task-report default gate.
    }
  }
  return {};
}

export type DispatchCounts = {
  project: Map<string, number>;
  provider: Map<string, number>;
  credential: Map<string, number>;
  model: Map<string, number>;
  cli: Map<string, number>;
};

const dispatchModelKey = (credentialId: string, model: string) => `${credentialId}\u0000${model}`;

/** Number of additional active jobs the effective global cap permits. */
export function dispatchSlots(maxGlobalJobs: number, totalActive: number): number {
  return Math.max(0, maxGlobalJobs - totalActive);
}

/** 允许进入 claimed/provisioning 阶段的额外 Job 数量。 */
export function provisionSlots(maxConcurrentProvisioning: number, activeProvisioning: number): number {
  return Math.max(0, maxConcurrentProvisioning - activeProvisioning);
}

/**
 * Select eligible candidates across one or more pending pages. The caller
 * supplies keyset pages; this helper intentionally keeps scanning later pages
 * when an earlier page is entirely ineligible (the former LIMIT 500 head
 * starvation bug).
 */
export function scanDispatchPages<T>(
  pages: Iterable<readonly T[]>,
  slots: number,
  isEligible: (candidate: T) => boolean,
): T[] {
  if (slots <= 0) return [];
  const selected: T[] = [];
  for (const page of pages) {
    for (const candidate of page) {
      if (selected.length >= slots) return selected;
      if (isEligible(candidate)) selected.push(candidate);
    }
  }
  return selected;
}

/**
 * Return the first resource gate that blocks a pending candidate, or null if
 * the candidate can be claimed. Kept pure so the quota ordering is unit
 * testable without a live Postgres/Scheduler process.
 */
export function dispatchSkipReason(
  job: DispatchCandidate,
  counts: DispatchCounts,
  rules: Pick<ProjectRules, "maxConcurrentByProvider" | "maxConcurrentByAgentCli">,
  projectJobLimit: number,
): string | null {
  const projectId = String(job.project_id);
  // Historical snapshots may omit agent_cli; use the platform default rather
  // than the mutable AGENT_PROVIDER environment value in quota accounting.
  const cli = String(job.agent_cli ?? PLATFORM_DEFAULT_AGENT_CLI);
  const provider = String(job.credential_provider ?? "");
  const credentialId = String(job.credential_id ?? "");
  const model = snapshotUpstreamModel(job) ?? "";
  if ((counts.project.get(projectId) ?? 0) >= projectJobLimit) return "project";
  const providerLimit = provider ? rules.maxConcurrentByProvider[provider] : undefined;
  if (providerLimit !== undefined && (counts.provider.get(provider) ?? 0) >= providerLimit) return "provider";
  const credentialPolicy = credentialConcurrencyPolicy(job.credential_metadata);
  if (credentialId && credentialPolicy.maxConcurrent !== null && (counts.credential.get(credentialId) ?? 0) >= credentialPolicy.maxConcurrent) {
    return "credential";
  }
  const modelLimit = model ? credentialPolicy.modelConcurrency[model] : undefined;
  if (credentialId && model && modelLimit !== undefined && (counts.model.get(dispatchModelKey(credentialId, model)) ?? 0) >= modelLimit) {
    return "model";
  }
  const cliLimit = rules.maxConcurrentByAgentCli[cli];
  if (cliLimit !== undefined && (counts.cli.get(cli) ?? 0) >= cliLimit) return "agent_cli";
  return null;
}

export function projectJobLimitForCandidate(
  job: Pick<DispatchCandidate, "project_config_json">,
  globalMaxJobsPerProject: number,
): number {
  if (!Object.prototype.hasOwnProperty.call(job, "project_config_json")) {
    throw new Error("DISPATCH_PROJECT_CONFIG_MISSING");
  }
  return projectJobQuotaFromConfig(job.project_config_json, globalMaxJobsPerProject).limit;
}

/** 等所有在执行的 job 收尾（超时强制返回；超时未完成的由下次启动 reconcile 接管为 orphan） */
export async function drainInFlight(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, 500))]);
  }
  if (inFlight.size > 0) {
    console.warn(`[dispatcher] drain 超时，仍有 ${inFlight.size} 个 job 在执行（重启后由 reconcile 判 orphan）`);
  }
}

/** 内置 real 类型；其余 job.type 若在角色注册表（agent_roles）中也为 real（Phase ② 自定义角色） */
const REAL_BASE_TYPES = new Set(["audit_module", "verify_finding", "hub_reason", "report"]);

async function isRealType(type: string): Promise<boolean> {
  if (REAL_BASE_TYPES.has(type)) return true;
  const [r] = await sql`SELECT 1 FROM agent_roles WHERE name = ${type}`;
  return Boolean(r);
}

async function graphEligibilityReasonFromDb(
  tx: typeof sql,
  job: Pick<DispatchCandidate, "id" | "canvas_id" | "type" | "finding_id" | "payload_json">,
  batch?: GraphEligibilityBatch,
): Promise<string | null> {
  const type = String(job.type ?? "");
  // Ordinary role/discovery Jobs are eligible once resource quotas pass; do
  // not pay the graph-state query cost for them on every pending scan.
  if (type !== "hub_reason" && type !== "verify_finding" && type !== "report") return null;
  const canvasId = String(job.canvas_id ?? "").trim();
  if (!canvasId) return null;
  const id = String(job.id ?? "");
  const activeStatuses = ["pending", "claimed", "provisioning", "running", "waiting_human"];
  if (type === "verify_finding") {
    if (!job.finding_id) return null;
    if (batch) {
      return graphEligibilityReason({ type, payload_json: job.payload_json }, { waitingEvidence: batch.verifyWaitingIds.has(id) });
    }
    const rows = await tx`
      SELECT 1 FROM finding_verification_rounds
      WHERE finding_id = ${String(job.finding_id)}
        AND verify_job_id = ${String(job.id)}
        AND status IN ('pending','running')
        AND requirements_json->>'eligibility' = 'waiting_evidence'
      LIMIT 1`;
    return graphEligibilityReason({ type, payload_json: job.payload_json }, { waitingEvidence: rows.length > 0 });
  }

  if (type === "report") {
    const batchedState = batch?.systemStates.get(id);
    if (batchedState) {
      return graphEligibilityReason({ type, payload_json: job.payload_json }, batchedState);
    }
    const reportScope = parseDispatchPayload(job.payload_json).kind === "finding_report"
      ? "finding_report"
      : "task_report";
    const [root, activeCanvas, oldestPendingReport] = await Promise.all([
      tx`SELECT status FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`,
      tx`SELECT 1 FROM jobs WHERE canvas_id = ${canvasId} AND id <> ${id}
         AND (
           status IN ('claimed','provisioning','running','waiting_human')
           OR (status = 'pending' AND type <> 'report')
         ) LIMIT 1`,
      tx`SELECT id FROM jobs WHERE canvas_id = ${canvasId} AND type = 'report' AND status = 'pending'
         AND CASE WHEN ${reportScope} = 'finding_report'
           THEN payload_json->>'kind' = 'finding_report'
           ELSE COALESCE(payload_json->>'kind', 'task_report') <> 'finding_report'
         END
         ORDER BY created_at ASC, id ASC LIMIT 1`,
    ]);
    return graphEligibilityReason(
      { type, payload_json: job.payload_json },
      {
        rootStatus: (root[0]?.status as string | null) ?? null,
        activeCanvasJob: activeCanvas.length > 0,
        pendingReportOlder: Boolean(oldestPendingReport[0]?.id && oldestPendingReport[0].id !== id),
      },
    );
  }

  const batchedState = batch?.systemStates.get(id);
  if (batchedState) {
    return graphEligibilityReason({ type, payload_json: job.payload_json }, batchedState);
  }

  const [activeHub, activeWaitingHuman, activeRole, root, oldestPendingHub] = await Promise.all([
    tx`SELECT 1 FROM jobs WHERE canvas_id = ${canvasId} AND id <> ${id} AND type = 'hub_reason'
       AND status = ANY(${["claimed", "provisioning", "running", "waiting_human"]}) LIMIT 1`,
    tx`SELECT 1 FROM jobs WHERE canvas_id = ${canvasId} AND id <> ${id} AND status = 'waiting_human' LIMIT 1`,
    tx`SELECT 1 FROM jobs WHERE canvas_id = ${canvasId} AND id <> ${id}
       AND type NOT IN ('hub_reason','verify_finding','report')
       AND status = ANY(${activeStatuses}) LIMIT 1`,
    tx`SELECT status FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`,
    tx`SELECT id FROM jobs
       WHERE canvas_id = ${canvasId} AND type = 'hub_reason' AND status = 'pending'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
  ]);
  return graphEligibilityReason(
    { type, payload_json: job.payload_json },
    {
      activeHub: activeHub.length > 0,
      activeWaitingHuman: activeWaitingHuman.length > 0,
      pendingHubOlder: Boolean(oldestPendingHub[0]?.id && oldestPendingHub[0].id !== id),
      activeRole: activeRole.length > 0,
      rootStatus: (root[0]?.status as string | null) ?? null,
    },
  );
}

/**
 * 在调度器 advisory lock 下抢占 pending Job，但不执行 provision 或 Agent。
 * 集成测试通过这个窄入口独立验证数据库侧配额决策。
 */
export async function claimPendingJobs(): Promise<{ id: string }[]> {
  if (config.runtime.agentMode === "real" && config.runtime.provider === "local-docker") {
    const disk = await refreshHostDiskPressure();
    if (!hostDiskAllowsDispatch(disk)) {
      if (disk.level === "error") {
        console.error(
          `[dispatcher] HOST_DISK_PRESSURE ${disk.usedPercent?.toFixed(2)}% >= ${disk.errorPercent}%: new claims paused`,
        );
      } else {
        console.error(`[dispatcher] host disk status unknown at ${disk.path}: new claims paused`);
      }
      return [];
    }
  }
  // 单次 claim 在 advisory xact lock 内核对：平台 → 项目 → Provider → Credential → Model → Agent CLI。
  // CLI 是最低优先级资源门；Credential 总量不会被 CLI 配额覆盖或替代。
  // 即使未来误启动两个 Scheduler，也不会出现先 count 后 update 的超配竞态。
  const claimedJobs = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
    const lifecycle = createSqlJobLifecycleApplication(tx as unknown as typeof sql);
    // global_settings is the scheduler-wide hard cap; per-project
    // maxConcurrentJobs may only tighten maxJobsPerProject at claim time.
    const rules = await globalRules(tx as unknown as typeof sql);
    const active = await tx`
      SELECT status, project_id,
             agent_snapshot_json->>'agent_cli' AS agent_cli,
             agent_snapshot_json->>'credential_id' AS credential_id,
             agent_snapshot_json->>'credential_provider' AS credential_provider,
             agent_snapshot_json->>'model' AS model,
             agent_snapshot_json->>'upstream_model' AS upstream_model,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running')
      GROUP BY status, project_id,
               agent_snapshot_json->>'agent_cli',
               agent_snapshot_json->>'credential_id',
               agent_snapshot_json->>'credential_provider',
               agent_snapshot_json->>'model',
               agent_snapshot_json->>'upstream_model'`;
    const totalActive = active.reduce((n, row) => n + Number(row.count), 0);
    const activeProvisioning = active.reduce(
      (n, row) => n + (["claimed", "provisioning"].includes(String(row.status)) ? Number(row.count) : 0),
      0,
    );
    const slots = Math.min(
      dispatchSlots(rules.maxGlobalJobs, totalActive),
      provisionSlots(rules.maxConcurrentProvisioning, activeProvisioning),
    );
    if (slots <= 0) return [] as { id: string }[];

    const projectCounts = new Map<string, number>();
    const providerCounts = new Map<string, number>();
    const credentialCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const cliCounts = new Map<string, number>();
    for (const row of active) {
      const projectId = row.project_id as string;
      // 历史 Job 可能缺少 agent_cli；仅使用平台常量，禁止读取可变的
      // AGENT_PROVIDER 环境变量。
      const cli = String(row.agent_cli ?? PLATFORM_DEFAULT_AGENT_CLI);
      const provider = String(row.credential_provider ?? "");
      const credentialId = String(row.credential_id ?? "");
      const model = snapshotUpstreamModel(row) ?? "";
      projectCounts.set(projectId, (projectCounts.get(projectId) ?? 0) + Number(row.count));
      if (provider) providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + Number(row.count));
      if (credentialId) credentialCounts.set(credentialId, (credentialCounts.get(credentialId) ?? 0) + Number(row.count));
      if (credentialId && model) modelCounts.set(dispatchModelKey(credentialId, model), (modelCounts.get(dispatchModelKey(credentialId, model)) ?? 0) + Number(row.count));
      cliCounts.set(cli, (cliCounts.get(cli) ?? 0) + Number(row.count));
    }
    const claimed: { id: string }[] = [];
    /**
     * Scan pending jobs in bounded pages, advancing a keyset cursor after
     * every page. A single LIMIT 500 lets an ineligible high-priority prefix
     * starve eligible jobs behind it; keyset paging keeps scanning until all
     * available slots are filled or pending is exhausted.
     */
    const pendingPageSize = 500;
    let cursor: { priority: number; createdAt: string; id: string } | null = null;
    while (claimed.length < slots) {
      // Outer joins remain unlocked. Lock the Job for claim and the inner
      // project row in SHARE mode so a concurrent settings update linearizes
      // before or after this claim instead of changing policy mid-decision.
      // ORDER BY uses mixed directions, so the keyset predicate is expanded
      // explicitly instead of relying on a tuple comparison.
      const pending = cursor
        ? await tx`
            SELECT j.id, j.project_id, j.canvas_id, j.finding_id, j.type, j.payload_json,
                   j.priority, j.created_at::text AS created_at_key, j.agent_snapshot_json,
                   j.agent_snapshot_json->>'agent_cli' AS agent_cli,
                   j.agent_snapshot_json->>'credential_id' AS credential_id,
                   j.agent_snapshot_json->>'credential_provider' AS credential_provider,
                   j.agent_snapshot_json->>'model' AS model,
                   j.agent_snapshot_json->>'upstream_model' AS upstream_model,
                   p.config_json AS project_config_json,
                   c.public_metadata_json AS credential_metadata,
                   cv.target_json AS canvas_target_json
            FROM jobs j
            JOIN projects p ON p.id = j.project_id
            LEFT JOIN credentials c ON c.id = NULLIF(j.agent_snapshot_json->>'credential_id', '')::uuid
            LEFT JOIN canvases cv ON cv.id = j.canvas_id
            WHERE j.status = 'pending'
              AND (
                j.priority < ${cursor.priority}
              OR (j.priority = ${cursor.priority} AND j.created_at > ${sql.typed(cursor.createdAt, 25)}::timestamptz)
              OR (j.priority = ${cursor.priority} AND j.created_at = ${sql.typed(cursor.createdAt, 25)}::timestamptz AND j.id > ${cursor.id}::uuid)
              )
            ORDER BY j.priority DESC, j.created_at ASC, j.id ASC
            LIMIT ${pendingPageSize}
            FOR UPDATE OF j SKIP LOCKED
            FOR SHARE OF p`
        : await tx`
            SELECT j.id, j.project_id, j.canvas_id, j.finding_id, j.type, j.payload_json,
                   j.priority, j.created_at::text AS created_at_key, j.agent_snapshot_json,
                   j.agent_snapshot_json->>'agent_cli' AS agent_cli,
                   j.agent_snapshot_json->>'credential_id' AS credential_id,
                   j.agent_snapshot_json->>'credential_provider' AS credential_provider,
                   j.agent_snapshot_json->>'model' AS model,
                   j.agent_snapshot_json->>'upstream_model' AS upstream_model,
                   p.config_json AS project_config_json,
                   c.public_metadata_json AS credential_metadata,
                   cv.target_json AS canvas_target_json
            FROM jobs j
            JOIN projects p ON p.id = j.project_id
            LEFT JOIN credentials c ON c.id = NULLIF(j.agent_snapshot_json->>'credential_id', '')::uuid
            LEFT JOIN canvases cv ON cv.id = j.canvas_id
            WHERE j.status = 'pending'
            ORDER BY j.priority DESC, j.created_at ASC, j.id ASC
            LIMIT ${pendingPageSize}
            FOR UPDATE OF j SKIP LOCKED
            FOR SHARE OF p`;

      if (pending.length === 0) break;
      const last = pending[pending.length - 1] as Record<string, unknown>;
      cursor = {
        priority: Number(last.priority),
        createdAt: String(last.created_at_key),
        id: String(last.id),
      };
      const graphBatch = await loadGraphEligibilityBatch(
        tx as unknown as typeof sql,
        pending as unknown as DispatchCandidate[],
      );

      for (const job of pending) {
        if (claimed.length >= slots) break;
        // Canvas execution control is a database-authoritative admission gate.
        // Lock the Canvas after the candidate Job so a concurrent pause either
        // linearizes before this re-read (and blocks claim) or after the claim.
        // The initial join is only a scan hint; it is not authoritative.
        let canvasTarget = (job as DispatchCandidate).canvas_target_json;
        if (job.canvas_id) {
          const [lockedCanvas] = await tx`
            SELECT target_json FROM canvases
            WHERE id = ${job.canvas_id as string}
            FOR SHARE`;
          if (!lockedCanvas) continue;
          canvasTarget = lockedCanvas.target_json;
          if (canvasExecutionIsPaused(canvasTarget)) continue;
        }
        // Task-level schedule gate: hold every job on the canvas until start_at.
        if (canvasScheduleBlocksDispatch(canvasTarget)) continue;
        const graphSkip = await graphEligibilityReasonFromDb(
          tx as unknown as typeof sql,
          job as DispatchCandidate,
          graphBatch,
        );
        if (graphSkip) continue;
        const projectId = job.project_id as string;
        // Historical snapshots may omit agent_cli; keep quota accounting on
        // the immutable platform default rather than mutable env config.
        const cli = String(job.agent_cli ?? PLATFORM_DEFAULT_AGENT_CLI);
        const provider = String(job.credential_provider ?? "");
        const credentialId = String(job.credential_id ?? "");
        const model = snapshotUpstreamModel(job) ?? "";
        const skipReason = dispatchSkipReason(
          job as DispatchCandidate,
          {
            project: projectCounts,
            provider: providerCounts,
            credential: credentialCounts,
            model: modelCounts,
            cli: cliCounts,
          },
          rules,
          projectJobLimitForCandidate(job, rules.maxJobsPerProject),
        );
        if (skipReason) continue;
        const row = await lifecycle.claimPendingJob(job.id as string);
        if (!row) continue;
        await createOrGetActiveAttempt(
          tx as unknown as typeof sql,
          String(job.id),
          attemptSnapshotIdentity(job.agent_snapshot_json),
          { "deepsonar.job": String(job.id) },
        );
        // A Finding Report is queued as `pending`; it becomes visible as
        // `generating` only after the DB claim succeeds.  Keep this update in
        // the same transaction as the jobs CAS so a report can never advertise
        // generation for a still-queued job (or remain queued after a claim).
        if (String(job.type ?? "") === "report") {
          await tx`
            UPDATE finding_reports
            SET status = 'generating', updated_at = now()
            WHERE report_job_id = ${row.id as string} AND status = 'pending'`;
        }
        claimed.push({ id: row.id as string });
        projectCounts.set(projectId, (projectCounts.get(projectId) ?? 0) + 1);
        if (provider) providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
        if (credentialId) credentialCounts.set(credentialId, (credentialCounts.get(credentialId) ?? 0) + 1);
        if (credentialId && model) modelCounts.set(dispatchModelKey(credentialId, model), (modelCounts.get(dispatchModelKey(credentialId, model)) ?? 0) + 1);
        cliCounts.set(cli, (cliCounts.get(cli) ?? 0) + 1);
      }
    }
    return claimed;
  });

  return claimedJobs;
}

export async function dispatchOnce(): Promise<number> {
  const claimedJobs = await claimPendingJobs();

  for (const job of claimedJobs) {
    const p = runJob(job.id).catch((e) => console.error(`[dispatcher] job ${job.id} 异常:`, e));
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }
  return claimedJobs.length;
}

async function runJob(jobId: string) {
  let handle: { sandboxId: string } | null = null;
  let sharedAssetsVolumeName: string | null = null;
  let attemptId: string | null = null;
  let provisionEffectId: string | null = null;
  let platformCapability: PreparedPlatformCapability | null = null;
  const lifecycle = createSqlJobLifecycleApplication();
  try {
    const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId}`;
    if (!job) return;
    const attempt = await getActiveAttempt(sql, jobId);
    if (!attempt) throw new Error(`job ${jobId} 缺少持久 Attempt`);
    attemptId = String(attempt.id);

    // provisioning：起沙箱（real 模式注入 agent 凭据 + 放行 LLM 端点出网）
    // provision 纳入同一异常保护 + 独立超时（§8.3：provision 异常不得让 job 永久卡住）
    const useReal = config.runtime.agentMode === "real" && (await isRealType(job.type as string));
    const snapshot = job.agent_snapshot_json as AgentRuntimeSnapshot | null;
    if (!snapshot) throw new Error(`job ${jobId} 缺少冻结的 Agent 运行快照`);
    const snapshotAllowEgress = requireFrozenSnapshotAllowEgress(snapshot, jobId);
    const runtimeImageKey = String(snapshot.runtime_image?.image_key ?? snapshot.runtime_image_key ?? "");
    // Hub 与 Worker 共用 Job 创建时冻结的 allow_egress。
    const allowEgress = useReal && snapshotAllowEgress;
    assertChromeRuntimeEgressAllowed(runtimeImageKey, snapshotAllowEgress);
    if (!snapshot.sandbox_limits) {
      throw new Error(`job ${jobId} 缺少冻结的沙箱资源限制`);
    }
    const runtimeImage = snapshot.runtime_image?.image_ref;
    if (!runtimeImage) throw new Error(`job ${jobId} 缺少创建期冻结的 runtime_image.image_ref`);
    if (!(await lifecycle.transitionJob(jobId, "provisioning"))) return; // 竞态：已被 cancel/reap
    if (useReal) {
      // Capability authentication remains disabled until `running`, but the
      // plaintext must exist before Docker creates immutable Config.Env.
      platformCapability = await preparePlatformCapability(jobId, snapshot);
      // Agentbox 在调度器宿主 docker inspect；OpenSandbox 由 server 拉镜像，
      // 合同/digest 在 provision 后重验，不能把本机缺层当成 Job 不可调度。
      if (shouldInspectLocalRuntimeImage()) {
        await assertRuntimeImageAvailable(runtimeImage);
      }
    }
    const frozenAssets = snapshot.shared_assets ?? [];
    if (useReal && frozenAssets.length > 0) {
      const files = [];
      for (const asset of frozenAssets) {
        files.push({
          sourcePath: await materializeSharedAssetBlob(asset.blob_uri),
          relativePath: asset.mount_path.replace(`${SHARED_ASSETS_READONLY_ROOT}/`, ""),
        });
      }
      sharedAssetsVolumeName = await sharedAssetsVolumeManager.prepare({
        jobId,
        files,
        catalog: buildJobSharedAssetCatalog({
          revision: snapshot.shared_assets_revision,
          assets: frozenAssets as unknown as Array<Record<string, unknown>>,
        }),
      });
    }
    provisionEffectId = `provision:${String(attempt.attempt_no)}`;
    await sql.begin(async (tx) => {
      await beginEffect(tx as unknown as typeof sql, attemptId!, {
        effectId: provisionEffectId!,
        kind: "provision",
        inputDigest: String(
          attempt.snapshot_identity_json && typeof attempt.snapshot_identity_json === "object"
            ? (attempt.snapshot_identity_json as Record<string, unknown>).snapshot_sha256 ?? ""
            : "",
        ).replace(/^sha256:/, "") || null,
        resourceIdentity: { job_id: jobId, attempt_id: attemptId },
        intent: { image_ref: runtimeImage, network: useReal ? (allowEgress ? "egress" : "restricted") : "none" },
      });
    });
    try {
      const provisionAbort = new AbortController();
      const provisionInput = {
        jobId,
        attemptId: attemptId!,
        resourceLabels: { "deepsonar.job": jobId, "deepsonar.attempt": attemptId! },
        image: runtimeImage,
        env: useReal
          ? {
              DEEPSONAR_ALLOW_EGRESS: allowEgress ? "1" : "0",
              ...platformCapability!.env,
            }
          : undefined,
        network: useReal ? (allowEgress ? "egress" : "restricted") : "none",
        gatewayUpstreamUrl: useReal ? config.gateway.proxyUpstreamUrl : undefined,
        expectedContract: snapshot.runtime_image.contract_version,
        expectedToolsManifestSha256: snapshot.runtime_image.tools_manifest_sha256,
        sharedAssetsMount: sharedAssetsVolumeName ? { volumeName: sharedAssetsVolumeName } : undefined,
        // Job 快照是运行时资源的唯一权威；这里不读取可变服务配置，保证
        // pending/running Job 的执行仍可复现。
        limits: snapshot.sandbox_limits,
        // provision 超时或取消时，运行时适配器必须真正终止外部创建并清理迟到资源。
        signal: provisionAbort.signal,
      } as Parameters<typeof runner.provision>[0] & { signal?: AbortSignal };
      const cancellableRunner = runner as typeof runner & {
        cancelProvision?: (input: { jobId: string; attemptId: string }) => Promise<void>;
      };
      const unregisterProvision = registerProvisionCancellation(jobId, {
        attemptId: attemptId!,
        abortController: provisionAbort,
        cancelProvision: cancellableRunner.cancelProvision
          ? () => cancellableRunner.cancelProvision!({ jobId, attemptId: attemptId! })
          : undefined,
      });
      try {
        const [stillProvisioning] = await sql`
          SELECT id FROM jobs
          WHERE id = ${jobId} AND status = 'provisioning'`;
        if (!stillProvisioning) {
          await interruptProvision(jobId, attemptId!);
          throw new Error(`job ${jobId} 在 provision 启动前已离开 provisioning 状态`);
        }
        const frozenProvisionSec = snapshot.runtime_knobs?.provision_timeout_sec;
        const provisionSec = typeof frozenProvisionSec === "number" && frozenProvisionSec > 0
          ? frozenProvisionSec
          : (await globalRules(sql)).provisionTimeoutSec;
        const provider = config.runtime.agentMode !== "real"
          ? "noop"
          : config.runtime.provider === "opensandbox" ? "opensandbox" : "agentbox";
        const provisionStarted = Date.now();
        try {
          handle = await withProvisionTimeout(
            runner.provision(provisionInput),
            provisionSec * 1000,
            `provision 超时（${provisionSec}s）`,
            () => interruptProvision(jobId, attemptId!),
            (lateHandle) => runner.destroy(lateHandle).catch((error) => {
              inc("deepsonar_sandbox_cleanup_failed_total");
              console.error(`[dispatcher] late sandbox cleanup failed ${lateHandle.sandboxId}:`, error);
            }),
          );
          inc("deepsonar_sandbox_provision_seconds_sum", { provider }, Math.max(1, Math.round((Date.now() - provisionStarted) / 1000)));
          inc("deepsonar_sandbox_provision_seconds_count", { provider });
        } catch (error) {
          inc("deepsonar_sandbox_provision_failed_total", { provider });
          throw error;
        }
      } finally {
        unregisterProvision();
      }
    } catch (error) {
      await sql.begin(async (tx) => {
        await markEffectUnknown(tx as unknown as typeof sql, attemptId!, provisionEffectId!, error);
      }).catch(() => {});
      throw error;
    }
    await sql.begin(async (tx) => {
      await settleEffect(tx as unknown as typeof sql, attemptId!, provisionEffectId!, {
        status: "settled",
        outcome: { sandbox_id: handle?.sandboxId ?? null },
      });
      await updateAttemptResource(tx as unknown as typeof sql, attemptId!, {
        sandboxId: handle?.sandboxId ?? null,
        phase: "provisioned",
      });
      const [bound] = await tx`
        UPDATE jobs SET sandbox_id = ${handle?.sandboxId ?? null}
        WHERE id = ${jobId} AND status = 'provisioning'
        RETURNING id`;
      if (!bound) throw new Error(`job ${jobId} 在 provision 收口前已失去 provisioning 状态`);
    });

    // running：开 lease（竞态守卫：此时被 cancel 则放弃执行，直接走 finally 回收）
    const lease = new Date(Date.now() + config.timeouts.leaseTtlSec * 1000);
    if (!(await lifecycle.transitionJob(jobId, "running", { started_at: new Date(), lease_expires_at: lease }))) {
      return;
    }
    if (platformCapability) await activateProvisionedJobCapabilityTokens(jobId);
    // Provisioning admission 统计 claimed/provisioning Job；离开该阶段后
    // 立即唤醒 dispatcher，让 pending Job 无需等待轮询或终态事件即可占用槽位。
    kickDispatcher();
    await sql.begin(async (tx) => {
      const started = await beginEffect(tx as unknown as typeof sql, attemptId!, {
        effectId: `agent_run:${String(attempt.attempt_no)}`,
        kind: "agent_run",
        inputDigest: String(
          attempt.snapshot_identity_json && typeof attempt.snapshot_identity_json === "object"
            ? (attempt.snapshot_identity_json as Record<string, unknown>).snapshot_sha256 ?? ""
            : "",
        ).replace(/^sha256:/, "") || null,
        resourceIdentity: { job_id: jobId, attempt_id: attemptId, sandbox_id: handle!.sandboxId },
        intent: { runner: useReal ? "real" : "fake", job_type: String(job.type) },
      });
      if (!started) throw new Error(`job ${jobId} 的 Attempt 已不再活动，禁止启动 agent_run`);
    });
    startLeaseRenewal(jobId, handle);

    // 画布：job 节点（如不存在）——claim 时由 routes/planeSync 建 root 之外的 job 节点
    await ensureJobNode(jobId, job);

    await execute(jobId, job.type, platformCapability);
    // execute 内部通过 done 事件 finalize；若 type 未主动发送 done，这里兜底
    // finalizeJob 有 running 守卫：执行期间被 cancel 时这个兜底 done 会被安全忽略
    const [cur] = await sql`SELECT status FROM jobs WHERE id = ${jobId}`;
    if (cur?.status === "running") {
      await ingestEvent(jobId, {
        v: 1,
        event_id: randomUUID(),
        type: "done",
        payload: { summary: "executor 正常退出" },
      });
    }
  } catch (e) {
    const [current] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
    if (current?.status === "waiting_human") {
      // request_human already closed this run. A late exclusive-tool rejection
      // must not paint the wait gate as failed or hide the reply target.
      return;
    }
    const rawMessage = e instanceof Error ? e.message : String(e);
    const details = e && typeof e === "object" && "code" in e
      ? (e as { code?: unknown; metadata?: { bucket?: unknown; retry_after_sec?: unknown; limit?: unknown } })
      : null;
    // 对执行器边界后的限流错误保留稳定、低基数观测，不序列化事件正文。
    const classified = classifyDispatcherFailure(e);
    const failureReason = classified.reason;
    const msg = e instanceof RuntimeImageNotReadyError
      ? classified.message
      : details?.code === "event_rate_limited"
      ? `${rawMessage} (code=event_rate_limited bucket=${String(details.metadata?.bucket ?? "unknown")} retry_after_sec=${String(details.metadata?.retry_after_sec ?? "unknown")} limit=${String(details.metadata?.limit ?? "unknown")})`
      : rawMessage;
    inc("deepsonar_jobs_failed_total", { reason: failureReason });
    // 守卫：只覆盖活动状态；cancelled/timeout/orphan 终态不被失败覆盖（§8.2）
    const failedRow = await sql.begin(async (tx) => {
      const txLifecycle = createSqlJobLifecycleApplication(tx as unknown as typeof sql);
      const row = await txLifecycle.failExecution(jobId, msg);
      if (row) {
        await settleAttemptTerminal(tx as unknown as typeof sql, jobId, "failed", { reason: failureReason }, msg);
      }
      return row;
    });
    const failed = failedRow ? [failedRow] : [];
    await sql`UPDATE canvas_nodes SET status = 'failed', updated_at = now() WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]}) AND status IN ('running','pending')`;
    if (failed[0]?.type === "verify_finding") {
      await recoverVerifyJobTerminal(jobId, "failed", msg).catch((err) =>
        console.error(`[dispatcher] verify recovery failed:`, err),
      );
    }
    if (failed[0]?.type === "report") {
      await sql.begin(async (tx) => {
        await finalizeReportJob(tx as unknown as typeof sql, jobId, { failed: true, error: msg });
      }).catch(() => {});
    }
    // 异常失败后统一推进画布：analysis_complete → Report，否则空闲唤醒 Hub。
    if (failed[0] && failed[0].type !== "report") {
      const [meta] = await sql`SELECT id, type, canvas_id, project_id, priority FROM jobs WHERE id = ${jobId}`;
      if (meta?.canvas_id) {
        await sql.begin(async (txRaw) => {
          await advanceCanvasAfterTerminalJob(
            txRaw as unknown as typeof sql,
            meta as Record<string, unknown>,
            "failed",
          );
        }).catch((err) => console.error(`[dispatcher] terminal canvas advance failed:`, err));
      }
    }
  } finally {
    stopLeaseRenewal(jobId);
    if (platformCapability) {
      await revokeJobCapabilityTokens(jobId).catch(() => {});
      platformCapability = null;
    }
    if (handle) {
      const h = handle;
      await runner.destroy(h).catch((e) => {
        inc("deepsonar_sandbox_cleanup_failed_total");
        console.error(`[dispatcher] 沙箱回收失败 ${h.sandboxId}:`, e);
      });
    }
    if (sharedAssetsVolumeName) {
      await sharedAssetsVolumeManager.removeForJob(jobId).catch((e) => {
        inc("deepsonar_shared_assets_cleanup_failed_total");
        console.error(`[dispatcher] 共享资产卷回收失败 ${jobId}:`, e);
      });
    }
    await planeWriteback(jobId).catch((e) => console.error("[plane] 回写异常:", e));
  }
}

export async function withProvisionTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout: () => Promise<unknown>,
  onLateResolve: (value: T) => Promise<unknown>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === "resolved") return outcome.value;
  if (outcome.kind === "rejected") throw outcome.error;

  await onTimeout().catch(() => {});
  const settled = await promise.then(
    (value) => ({ kind: "resolved" as const, value }),
    () => ({ kind: "rejected" as const }),
  );
  if (settled.kind === "resolved") await onLateResolve(settled.value).catch(() => {});
  throw new Error(message);
}

/** 执行器路由：real 模式走 provider-neutral RuntimeHost；否则内置假 agent（联调/演示用） */
async function execute(jobId: string, type: string, platformCapability: PreparedPlatformCapability | null) {
  if (config.runtime.agentMode === "real" && (await isRealType(type))) {
    if (!platformCapability) throw new Error(`job ${jobId} 缺少 provision 阶段的平台 capability`);
    await executeReal(jobId, type, platformCapability);
    return;
  }
  await executeFake(jobId, type);
}

/** fake 执行器：audit/verify/hub/角色任务由内置脚本驱动（联调/演示用） */
async function executeFake(jobId: string, type: string) {
  const emit = (t: string, payload: unknown) =>
    ingestEvent(jobId, { v: 1, event_id: randomUUID(), type: t as never, payload });

  if (type === "audit_module" || type === "audit") {
    const [job] = await sql`SELECT payload_json FROM jobs WHERE id = ${jobId}`;
    const fake = (job?.payload_json?.fake_finding ?? null) as {
      title?: string;
      severity?: string;
      location?: string;
      summary?: string;
    } | null;
    await emit("progress", { message: "假 agent：开始审计", percent: 10 });
    // 模拟真实 agent 产出的结构化 finding（severity 默认 high → 触发规则引擎派生验证）
    await emit("finding", {
      title: fake?.title ?? "SQL 注入：未参数化的查询拼接",
      severity: fake?.severity ?? "high",
      location: fake?.location ?? "auth/login.php:42",
      summary: fake?.summary ?? "用户输入未经参数化处理直接拼入 SQL 查询语句，攻击者可构造恶意参数改变查询语义并读取未授权数据。",
      rule_id: "fake-sqli-001",
      suggest_verify: true,
      raw: { source: "fake-agent", v: 1 },
    });
    await emit("progress", { message: "假 agent：审计完成", percent: 100 });
    return; // done 由 runJob 兜底
  }

  if (type === "verify_finding") {
    await emit("progress", { message: "假 agent：验证中（证据硬门）", percent: 50 });
    // 有合格 review+test 才 confirmed；否则 rework 回弹 Hub
    const [vjob] = await sql`SELECT finding_id, payload_json FROM jobs WHERE id = ${jobId}`;
    const findingId = vjob?.finding_id as string | null;
    let canConfirm = false;
    if (findingId) {
      const [f] = await sql`SELECT job_id FROM findings WHERE id = ${findingId}`;
      const snap = await collectEvidenceSnapshot(sql, findingId, (f?.job_id as string) ?? null);
      canConfirm = snap.qualified;
    }
    await ingestEvent(jobId, {
      v: 1,
      event_id: randomUUID(),
      type: "done",
      payload: canConfirm
        ? { summary: "假 agent：独立复核与实测证据充分，确认可利用", verdict: "confirmed" }
        : {
            summary: "假 agent：缺少独立复核或实测证据，需要 Hub 补证",
            verdict: "rework",
            missing_evidence: ["independent_review", "runtime_test"],
          },
    });
    return;
  }

  if (type === "report") {
    await emit("progress", { message: "假 agent：生成任务报告", percent: 60 });
    await ingestEvent(jobId, {
      v: 1,
      event_id: randomUUID(),
      type: "done",
      payload: {
        summary:
          "假 agent 任务报告：已区分已确认问题与待人工确认；SARIF 仅含 confirmed。本次演示路径覆盖完整收敛闭环。",
      },
    });
    return;
  }

  if (type === "hub_reason") {
    // 假 Hub 也实时读取数据库角色注册表；只模拟状态机，不维护第二份角色白名单。
    const [job] = await sql`SELECT canvas_id, project_id, payload_json FROM jobs WHERE id = ${jobId}`;
    const canvasId = job?.canvas_id as string | null;
    const trigger = (job?.payload_json?.trigger ?? {}) as {
      kind?: string;
      finding_id?: string;
      missing_evidence?: string[];
    };
    const roles = job ? await rolesForProject(sql, job.project_id as string) : [];
    const chooseRole = (preferred: string) => roles.find((role) => role.name === preferred) ?? roles[0];
    await emit("progress", { message: "假 hub：读图决策中", percent: 50 });
    if (canvasId) {
      if (["user_task", "plane_issue", "external_event"].includes(trigger.kind ?? "")) {
        const selected = chooseRole("audit");
        if (!selected) return;
        const refs = await sql`
          SELECT id FROM canvas_nodes
          WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
        await emit("hub_decision", {
          intents: [
            {
              from: refs.map((r) => r.id as string),
              role: selected.name,
              description: `由 ${selected.title} 角色执行首次取证：${selected.description}`,
              prompt: `读取任务目标和画布，按 ${selected.name} 角色职责执行，并提交可验证的增量结果。`,
            },
          ],
        });
        return;
      }
      // verify 未通过 / 失败 → 派发 review + test 补证（绑定 finding）
      if (trigger.kind === "verify_rework" || trigger.kind === "verify_failed") {
        const findingId = trigger.finding_id;
        const refs = findingId
          ? await sql`SELECT node_id AS id FROM findings WHERE id = ${findingId} AND node_id IS NOT NULL`
          : [];
        const from = refs.map((r) => r.id as string);
        const review = chooseRole("review");
        const test = chooseRole("test");
        const intents: Array<Record<string, unknown>> = [];
        if (review) {
          intents.push({
            from,
            role: review.name,
            description: `独立复核 Finding：补充 review 证据`,
            prompt: `对绑定 Finding 做独立静态/逻辑复核，通过 emit_fact 提交 verification.evidence_kind=review 的结构化证据。finding_id=${findingId}`,
          });
        }
        if (test) {
          intents.push({
            from,
            role: test.name,
            description: `实测 Finding：补充 runtime test 证据`,
            prompt: `对绑定 Finding 做实际 runtime_test，通过 emit_fact 提交 verification.evidence_kind=test 的结构化证据（含 subject_revision/steps/expected/actual）。先依据目标语言和构建文件检查 Scheduler 冻结镜像内与目标相关的预装工具：Java 用 command -v java、java -version；使用 Maven 时再用 command -v mvn、mvn -v；Python 用对应 python3.x/uv；Go 用 command -v go、go version；Rust 用 command -v rustc、rustc --version、command -v cargo、cargo --version。禁止 apt-get、下载 JDK/Maven 压缩包、./mvnw 或其它工具链 bootstrap fallback。相关工具缺失时提交 inconclusive/needs_human，不得臆造 confirmed。finding_id=${findingId}`,
          });
        }
        if (intents.length > 0) {
          await emit("hub_decision", { intents });
          return;
        }
      }
      if (trigger.kind === "report_gate_failed") {
        // Report 打回：按 problems 派 test/review 补证
        const problems = Array.isArray((trigger as { problems?: Array<{ finding_id?: string }> }).problems)
          ? (trigger as { problems: Array<{ finding_id?: string }> }).problems
          : [];
        const findingId = problems[0]?.finding_id ?? (trigger as { finding_id?: string }).finding_id;
        const selected = chooseRole("test") ?? chooseRole("review");
        if (!selected) return;
        const refs = findingId
          ? await sql`SELECT node_id AS id FROM findings WHERE id = ${findingId} AND node_id IS NOT NULL`
          : [];
        await emit("hub_decision", {
          intents: [
            {
              from: refs.map((r) => r.id as string),
              role: selected.name,
              description: `Report 门禁失败：补证或收口未收敛 Finding`,
              prompt: `针对 report_gate_failed 列出的 Finding 补充证据或推动至 confirmed/needs_human。finding_id=${findingId ?? "见 trigger.problems"}`,
            },
          ],
        });
        return;
      }
      if (trigger.kind === "confirmed_finding") {
        // 已确认后：自动验证范围内 Finding 收敛（confirmed|needs_human）才 complete
        const care = await canvasFindingsConverged(sql, canvasId);
        if (care.ok) {
          const refs = await sql`
            SELECT id FROM canvas_nodes
            WHERE canvas_id = ${canvasId} AND node_type = ANY(${["finding", "fact", "root"]})
            ORDER BY created_at LIMIT 5`;
          await emit("hub_decision", {
            complete: {
              from: refs.map((r) => r.id as string),
              description: "假 hub：自动验证范围内 Finding 已收敛（confirmed/needs_human），分析完成，可生成报告。",
            },
          });
          return;
        }
        const pending = care.problems;
        const selected = chooseRole("test");
        if (!selected) return;
        const badId = pending[0]?.finding_id ?? trigger.finding_id;
        const refs = badId
          ? await sql`SELECT node_id AS id FROM findings WHERE id = ${badId} AND node_id IS NOT NULL`
          : trigger.finding_id
            ? await sql`SELECT node_id AS id FROM findings WHERE id = ${trigger.finding_id} AND node_id IS NOT NULL`
            : [];
        await emit("hub_decision", {
          intents: [
            {
              from: refs.map((r) => r.id as string),
              role: selected.name,
              description: `由 ${selected.title} 角色补证未收敛 Finding`,
              prompt: `针对尚未 confirmed/needs_human 的 Finding 补充实测证据。finding_id=${badId ?? "见画布"}`,
            },
          ],
        });
        return;
      }
      // 默认 / canvas_idle：自动验证范围内 Finding 收敛则 complete，否则 explore/补证
      const careGate = await canvasFindingsConverged(sql, canvasId);
      const facts = await sql`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'fact' ORDER BY created_at`;
      // 尚无任何角色工作：空闲唤醒也要先派 audit/explore，不能直接 complete
      const roleDone = await sql`
        SELECT 1 FROM jobs
        WHERE canvas_id = ${canvasId}
          AND type NOT IN ('hub_reason', 'verify_finding', 'report')
          AND status = 'succeeded'
        LIMIT 1`;
      if (careGate.ok && roleDone.length > 0 && facts.length > 0) {
        await emit("hub_decision", {
          complete: {
            from: facts.map((f) => f.id as string),
            description: "假 hub：事实已足够且 Finding 已收敛，目标达成。",
          },
        });
      } else if (careGate.ok && roleDone.length > 0) {
        const refs = await sql`
          SELECT id FROM canvas_nodes
          WHERE canvas_id = ${canvasId} AND node_type = ANY(${["finding", "root"]})
          ORDER BY created_at LIMIT 3`;
        await emit("hub_decision", {
          complete: {
            from: refs.map((r) => r.id as string),
            description: "假 hub：Finding 已收敛（confirmed/needs_human），分析完成。",
          },
        });
      } else {
        const selected = chooseRole(roleDone.length === 0 ? "audit" : "explore") ?? chooseRole("explore");
        if (!selected) return;
        const refs = await sql`
          SELECT id FROM canvas_nodes
          WHERE canvas_id = ${canvasId} AND node_type = ANY(${["finding", "fact", "root"]})
          ORDER BY created_at LIMIT 2`;
        await emit("hub_decision", {
          intents: [
            {
              from: refs.map((r) => r.id as string),
              role: selected.name,
              description: `假 Hub：由 ${selected.title} 角色${roleDone.length === 0 ? "首次取证" : "补充事实"}`,
              prompt: `围绕画布目标和现有证据，按 ${selected.name} 角色职责补充尚缺的可验证${selected.name === "audit" ? "发现" : "事实"}；完成后通过平台工具提交结构化结果。`,
            },
          ],
        });
      }
    }
    return; // done 由 runJob 兜底
  }

  // 角色 job（explore/analyze/review/test/code/自定义）：假 agent 产出演示事实 / 验证证据
  const [roleJob] = await sql`SELECT payload_json FROM jobs WHERE id = ${jobId}`;
  const rolePayload = (roleJob?.payload_json ?? {}) as Record<string, unknown>;
  const vf = rolePayload.verification_followup as { finding_id?: string; required_evidence?: string[] } | undefined;
  await emit("progress", { message: `假 agent（${type}）：执行中`, percent: 50 });

  if (vf?.finding_id && (type === "review" || type === "test" || type === "analyze" || type === "audit")) {
    const kind = type === "test" ? "test" : "review";
    // 若 required 明确只要另一类，仍按角色默认：test→test，其它→review
    const evidenceKind = type === "test" ? "test" : kind;
    await emit("fact", {
      intent_node_id: (rolePayload.intent_node_id as string) ?? null,
      title: `假 agent ${evidenceKind} 证据`,
      description: `假 agent（${type}）：对 Finding ${vf.finding_id} 的${evidenceKind === "test" ? "实测" : "独立复核"}证据（演示）。`,
      verification: {
        finding_id: vf.finding_id,
        evidence_kind: evidenceKind,
        outcome: "supports",
        subject_revision: "demo-target@v1",
        environment: "fake-sandbox",
        steps: [
          evidenceKind === "test" ? "构造恶意输入" : "阅读相关源码路径",
          evidenceKind === "test" ? "发送请求并观察响应" : "追踪数据流至汇点",
          "记录可复核结果",
        ],
        expected: evidenceKind === "test" ? "未授权数据不应返回" : "输入应参数化",
        actual: evidenceKind === "test" ? "响应包含其他租户记录" : "$_GET 直达查询拼接",
        artifact_refs: [{ uri: `fake://evidence/${jobId}` }],
      },
    });
    return;
  }

  await emit("fact", {
    intent_node_id: (rolePayload.intent_node_id as string) ?? null,
    title: `假 agent ${type} 事实`,
    description: `假 agent（${type}）：auth/login.php:42 存在未参数化拼接，用户输入经 $_GET 直达 mysqli_query，属高危数据流（演示事实）。`,
  });
  return; // done 由 runJob 兜底
}

// lease 续期：调度器侧维护（§3.3；接入 SDK 后改为控制通道探测驱动）
function startLeaseRenewal(jobId: string, handle: { sandboxId: string }) {
  const timer = setInterval(async () => {
    const alive = await runner.isAlive(handle).catch(() => false);
    if (!alive) return; // 停续，交给 Reaper 判 orphan
    await sql`
      UPDATE jobs SET lease_expires_at = now() + (${config.timeouts.leaseTtlSec} * interval '1 second'),
                      heartbeat_at = now()
      WHERE id = ${jobId} AND status = 'running'`;
  }, Math.max(5, config.timeouts.leaseTtlSec / 3) * 1000);
  activeLeases.set(jobId, timer);
}

function stopLeaseRenewal(jobId: string) {
  const t = activeLeases.get(jobId);
  if (t) clearInterval(t);
  activeLeases.delete(jobId);
}

async function ensureJobNode(jobId: string, job: Record<string, unknown>) {
  // intent 节点由 hub_decision 随角色 job 同事务创建（1:1）；已有节点则只同步运行态
  const existing = await sql`SELECT id, node_type FROM canvas_nodes WHERE job_id = ${jobId}`;
  if (existing.length > 0) {
    // resume 重跑的 job：节点已在（上一轮终态），同步回 running
    await sql`
      UPDATE canvas_nodes SET status = 'running', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]}) AND status = 'pending'`;
    return;
  }
  // 一任务一画布：优先 job 自带的任务画布；历史 job（canvas_id 为空）兜底到项目旧画布
  let canvasId = job.canvas_id as string | null;
  if (!canvasId) {
    const [project] = await sql`SELECT canvas_id FROM projects WHERE id = ${job.project_id as string}`;
    canvasId = (project?.canvas_id as string) ?? null;
  }
  if (!canvasId) return;
  const [{ next_x }] = await sql<[{ next_x: number }]>`
    SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
  const roleSnapshot = job.agent_snapshot_json as { role_kind?: string; ui_color?: string | null } | null;
  const [node] = await sql`
    INSERT INTO canvas_nodes ${sql({
      canvas_id: canvasId,
      job_id: jobId,
      node_type: "job",
      title: `${job.type} #${(jobId as string).slice(0, 8)}`,
      body_json: {
        type: job.type,
        role: job.type,
        payload: job.payload_json,
        ...(roleSnapshot?.role_kind === "role" && roleSnapshot.ui_color
          ? { ui_color: roleSnapshot.ui_color }
          : {}),
      } as never,
      x: next_x,
      y: 300,
      status: "running",
    })}
    RETURNING id`;
  // child 边：任务 root → job（早退保证不重复）
  const [root] = await sql`
    SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
  if (root) {
    await sql`
      INSERT INTO canvas_edges ${sql({
        canvas_id: canvasId,
        from_node_id: root.id,
        to_node_id: node.id,
        edge_type: "child",
      })}`;
  }
}

/**
 * 事件驱动的领取触发器（§4.2：全程事件触发，无轮询）：
 * jobs 表触发器 pg_notify('deepsonar_jobs') → LISTEN 收到即跑一轮 dispatchOnce。
 * 重入保护：运行中再来事件只标记补跑，不并发抢。
 */
let kickRunning = false;
let kickAgain = false;

export function kickDispatcher() {
  if (kickRunning) {
    kickAgain = true;
    return;
  }
  kickRunning = true;
  void (async () => {
    try {
      do {
        kickAgain = false;
        await dispatchOnce();
      } while (kickAgain);
    } catch (e) {
      console.error("[dispatcher]", e);
    } finally {
      kickRunning = false;
    }
  })();
}

export function startDispatcher() {
  // Wire schedule wake before any kick so future start_at can re-arm safely.
  bindScheduleWake(kickDispatcher);

  // 事件源：DB LISTEN/NOTIFY（0005_job_events.sql；NOTIFY 提交后投递，与事务可见性一致）
  const listenPromise = sql.listen("deepsonar_jobs", () => kickDispatcher());
  // 启动补跑： scheduler 停机期间堆积的 pending job 不会产生新事件，先清一次
  void listenPromise
    .then(() => {
      kickDispatcher();
      void refreshScheduleWakeFromDb();
    })
    .catch((e) => console.error("[dispatcher] LISTEN 失败:", e));

  // 兜底轮询默认关闭；DEEPSONAR_DISPATCH_POLL_SEC>0 显式开启（调试/极端场景用）
  let timer: ReturnType<typeof setInterval> | null = null;
  if (config.timeouts.dispatchPollSec > 0) {
    timer = setInterval(() => kickDispatcher(), config.timeouts.dispatchPollSec * 1000);
    console.log(`[dispatcher] 兜底轮询已开启：${config.timeouts.dispatchPollSec}s（默认应关闭，事件驱动）`);
  }
  return () => {
    if (timer) clearInterval(timer);
    void listenPromise.then((l) => l.unlisten()).catch(() => {});
  };
}
