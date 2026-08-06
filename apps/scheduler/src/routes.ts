import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  PlatformToolName,
  allowedPlatformTools,
  CredentialBatchBindingImpact,
  CredentialBatchBindingErrorCode,
  CredentialBatchBindingRepairAction,
  CredentialBatchBindingRequest,
  FindingProtocolConfig,
  parseModuleSelector,
  requiredPlatformTools,
} from "@deepsonar/shared-types";
import { z } from "zod";
import { audit, credentialAuditState } from "./audit.js";
import { authHook } from "./auth.js";
import { config } from "./config.js";
import {
  allowedModelIds,
  credentialModelCatalogCapability,
  normalizeModelCatalog,
  encryptSecret,
  fingerprintOf,
  isProviderKnown,
  isProviderAllowedForKind,
  last4Of,
  projectCredentialProviderError,
  projectCredentialMetadata,
  projectJobEventPayload,
  projectJobPayload,
  projectCredentialProvider,
  providerSupportsBaseUrl,
  PROVIDER_CATALOG,
  sanitizeCredentialMetadata,
  UNKNOWN_PROVIDER_ERROR,
  type CredentialHealthErrorCategory,
  validateCredentialCompatibility,
  validateCredentialRuntimeMutation,
  type Encrypted,
} from "./credentials.js";
import { CredentialProbeError, listCredentialModels, testCredential } from "./credential-test.js";
import {
  CONFIG_FILE_MAX_BYTES,
  CONFIG_FILE_MAX_COUNT,
  CONFIG_FILE_MAX_TOTAL,
  DISPATCH_CLAIM_ADVISORY_KEY,
  PLATFORM_DEFAULT_AGENT_CLI,
  PLATFORM_DEFAULT_AGENT_MODEL,
  createJob,
  drainNonGateVerifies,
  ensureCanvasForTask,
  fixedPriorityForJob,
  globalRules,
  mergeGlobalRulesPatch,
  maybeTriggerHub,
  normalizePendingJobPriority,
  parseCanvasConvergence,
  patchCanvasConvergence,
  priorityMatchesJob,
  readCanvasConvergence,
  resolveAgentSnapshotForJob,
  resolveHubWaitSeverities,
  rolesForProject,
  rulesForProject,
  scanConfigContent,
  triggerHubFromHumanComment,
  validateConfigFilePath,
  validateEnvVars,
} from "./core.js";
import { sql } from "./db.js";
import { readEvidenceManifest, readMainSession, readNormalizedStreamPage } from "./evidence.js";
import { planePollOnce, planePollProject, planeWriteback } from "./plane-sync.js";
import { registerGateway } from "./gateway.js";
import { revokeJobTokens } from "./gateway.js";
import { finalizeReportJob } from "./report.js";
import { recoverVerifyJobTerminal } from "./core.js";
import { runner } from "./runtime.js";
import { canvasScopeDecision, isUuid, projectScopeAllows } from "./project-scope.js";
import { CursorError, cursorErrorHttpStatus, cursorForRow, decodeCursor, page, pageLimit } from "./pagination.js";
import {
  buildCanvasDelta,
  cursorGap,
  parseCanvasRevision,
} from "./canvas-delta.js";
import { loadReadiness, type ReadinessMaterialSource } from "./readiness.js";
import { allocateRoleUiColor } from "./role-colors.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { registerReportRoutes } from "./domains/report-convergence/routes.js";
import { registerFindingVerificationRoutes } from "./domains/finding-verification/routes.js";
import { registerSharedAssetRoutes } from "./domains/shared-assets/routes.js";
import { registerTransferRoutes } from "./domains/transfer/routes.js";
import { registerSystemRoutes } from "./domains/system/routes.js";
import { registerAuthRoutes } from "./domains/auth/routes.js";
import { registerStreamRoutes } from "./domains/stream/routes.js";
import { registerSkillSourceRoutes } from "./domains/skill-source/routes.js";
import { registerApiTokenRoutes } from "./domains/api-token/routes.js";
import { registerRuntimeImageRoutes } from "./domains/runtime-image/routes.js";
import { registerCredentialRoutes } from "./domains/credential/routes.js";
import { projectJobProviderFields, projectJobSnapshot } from "./domains/credential/projection.js";
export { RuntimeImageRegistryChannelBody } from "./domains/runtime-image/routes.js";
import { registerAuditRoutes } from "./domains/audit/routes.js";
import { recordJobSharedAssets } from "./domains/shared-assets/index.js";
import { resolveFindingProtocol } from "./finding-protocol.js";

const SyncProjectBody = z.object({
  plane_project_id: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

const CreateJobBody = z.object({
  project_id: z.string().uuid(),
  plane_issue_id: z.string().optional(),
  title: z.string().optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().optional(),
  timeout_sec: z.number().int().positive().optional(),
});

const ReasoningEffort = z.enum(["low", "medium", "high", "xhigh"]);

const RULE_CONCURRENCY_KEYS = new Set(["maxGlobalJobs", "maxJobsPerProject"]);
const CLI_CONCURRENCY_KEYS = new Set(["claude-code", "codex", "open-code"]);
const ACTIVE_JOB_STATUSES = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);
const STREAMABLE_JOB_STATUSES = new Set(["running", "waiting_human"]);

/**
 * Validate scheduler concurrency knobs at the API boundary. Other rule keys
 * remain open-ended for backwards compatibility, while these limits must be
 * finite integers in the same range used by globalRules().
 */
const RulesPatch = z.record(z.string(), z.unknown()).superRefine((rules, ctx) => {
  for (const key of RULE_CONCURRENCY_KEYS) {
    if (!(key in rules)) continue;
    const value = rules[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} 必须是 1-1000 的整数` });
    }
  }
  if (Object.prototype.hasOwnProperty.call(rules, "maxConcurrentByAgentCli")) {
    const cliRules = rules.maxConcurrentByAgentCli;
    if (!cliRules || typeof cliRules !== "object" || Array.isArray(cliRules)) {
      ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli"], message: "Agent CLI 并发必须是对象" });
    } else {
      for (const [cli, value] of Object.entries(cliRules as Record<string, unknown>)) {
        if (!CLI_CONCURRENCY_KEYS.has(cli) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
          ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli", cli], message: `${cli} 必须是 0-1000 的整数` });
        }
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(rules, "maxConcurrentByProvider")) return;
  const providerRules = rules.maxConcurrentByProvider;
  if (!providerRules || typeof providerRules !== "object" || Array.isArray(providerRules)) {
    ctx.addIssue({ code: "custom", path: ["maxConcurrentByProvider"], message: "Provider 并发必须是对象" });
    return;
  }
  for (const [provider, value] of Object.entries(providerRules as Record<string, unknown>)) {
    if (!isProviderKnown(provider) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
      const knownProvider = isProviderKnown(provider);
      ctx.addIssue({
        code: "custom",
        path: knownProvider ? ["maxConcurrentByProvider", provider] : ["maxConcurrentByProvider"],
        message: knownProvider ? `${provider} 必须是 0-1000 的整数` : UNKNOWN_PROVIDER_ERROR,
      });
    }
  }
});

/** Strict parser exported for unit tests and non-HTTP adapters. */
export function parseConcurrencyRulesPatch(input: unknown): Record<string, unknown> {
  return RulesPatch.parse(input);
}

// roles.enabled：hub 可下发角色清单（name 数组；null = 恢复默认=全部内置）
const SettingsPatchBody = z.object({
  rules: RulesPatch.optional(),
  roles: z.object({ enabled: z.array(z.string()).nullable() }).optional(),
  finding_protocol: FindingProtocolConfig.nullable().optional(),
});
const GlobalSettingsPatchBody = z.object({
  rules: RulesPatch.optional(),
  finding_protocol: FindingProtocolConfig.nullable().optional(),
}).refine((body) => body.rules !== undefined || body.finding_protocol !== undefined, {
  message: "at least one global setting is required",
});

function parseStoredFindingProtocolConfig(value: unknown) {
  if (value === undefined || value === null) return undefined;
  return FindingProtocolConfig.parse(value);
}

// 角色注册表：name 即 job.type，description 供 Hub 选角色时使用。
const RoleBody = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, "小写字母开头的标识符"),
  title: z.string().default(""),
  description: z.string().default(""),
});
const RolePatchBody = RoleBody.partial().omit({ name: true });

// 本地项目与任务管理（docs/LOCAL_PROJECT_MANAGEMENT_MIGRATION.md，阶段 A）
const CreateProjectBody = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  plane_project_id: z.string().nullish(), // 可选：创建时即绑定 Plane
});
const PatchProjectBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
const CreateTaskBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  /** 省略则继承项目 allowEgress；创建画布时会冻结最终值。 */
  allow_egress: z.boolean().optional(),
  /** 省略则继承项目/全局；声明字段只覆盖对应键。 */
  finding_protocol: FindingProtocolConfig.optional(),
});
const TriggerTaskBody = z.object({
  event_id: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(100),
  event_type: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
const PriorityBody = z.object({ priority: z.number().int() });
const PlaneBindBody = z.object({ plane_project_id: z.string().min(1) });

const ReadinessQuery = z.object({
  allow_egress: z.enum(["true", "false"]).optional(),
  material_source: z.enum(["workspace_or_offline", "external_or_workspace", "declared", "unspecified"]).optional(),
});

/** 清空任务画布上的运行数据（jobs / findings / 图节点等），保留 canvas 行本身。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function wipeCanvasRuntimeData(tx: any, canvasId: string): Promise<void> {
  await tx`UPDATE canvas_nodes SET job_id = NULL WHERE canvas_id = ${canvasId}`;
  await tx`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
  await tx`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
  await tx`
    DELETE FROM finding_verification_rounds
    WHERE finding_id IN (
      SELECT f.id FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE j.canvas_id = ${canvasId}
    )
    OR verify_job_id IN (SELECT id FROM jobs WHERE canvas_id = ${canvasId})`;
  await tx`DELETE FROM task_reports WHERE canvas_id = ${canvasId}`;
  await tx`
    DELETE FROM findings WHERE job_id IN (
      SELECT id FROM jobs WHERE canvas_id = ${canvasId}
    )`;
  await tx`
    DELETE FROM events WHERE job_id IN (
      SELECT id FROM jobs WHERE canvas_id = ${canvasId}
    )`;
  await tx`
    DELETE FROM event_dedup WHERE job_id IN (
      SELECT id FROM jobs WHERE canvas_id = ${canvasId}
    )`;
  await tx`
    UPDATE jobs SET parent_job_id = NULL, finding_id = NULL
    WHERE canvas_id = ${canvasId}`;
  await tx`DELETE FROM jobs WHERE canvas_id = ${canvasId}`;
}

async function recoverCancelledDerivedJob(
  job: Record<string, unknown>,
  reason: string,
): Promise<void> {
  const jobId = String(job.id);
  if (job.type === "verify_finding") {
    await recoverVerifyJobTerminal(jobId, "cancelled", reason);
    return;
  }
  if (job.type === "report") {
    await sql.begin((tx) => finalizeReportJob(
      tx as unknown as typeof sql,
      jobId,
      { failed: true, error: reason },
    ));
  }
}

/** 取消画布上全部活动 job（归档/删除前兜底）。 */
async function cancelActiveJobsOnCanvas(canvasId: string): Promise<number> {
  const active = await createSqlJobLifecycleApplication().cancelJobsOnCanvas(
    canvasId,
    "task archived/deleted",
    true,
    false,
  );
  if (active.length === 0) return 0;
  for (const job of active) {
    const id = job.id as string;
    if (job.sandbox_id) {
      await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
    }
    await revokeJobTokens(id, "cancelled").catch(() => {});
    await sql`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent", "report"]})`;
    await recoverCancelledDerivedJob(job, "task archived/deleted").catch(() => {});
  }
  return active.length;
}

export function registerRoutes(app: FastifyInstance) {
  // 平台 API Token 鉴权（SEC-01）：DEEPSONAR_AUTH_REQUIRED=true 时生效；/health 与 /webhooks/plane 豁免
  app.addHook("onRequest", authHook);
  // Central ownership guard for project-scoped tokens. Resource UUIDs are not
  // authorization: resolve their project_id server-side before any handler
  // reads or mutates a canvas/job, and constrain unqualified list queries.
  app.addHook("preHandler", async (req, reply) => {
    const routeUrl = req.routeOptions?.url ?? "";
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    if (routeUrl.startsWith("/jobs/:id") && !isUuid(params.id)) {
      return reply.code(400).send({ error: "invalid job id", error_code: "INVALID_ID" });
    }
    if (routeUrl.startsWith("/findings/:id") && !isUuid(params.id)) {
      return reply.code(400).send({ error: "invalid finding id", error_code: "INVALID_ID" });
    }
    if (routeUrl.startsWith("/reports/:id") && !isUuid(params.id)) {
      return reply.code(400).send({ error: "invalid report id", error_code: "INVALID_ID" });
    }
    if (routeUrl.startsWith("/canvases/:id") && !isUuid(params.id)) {
      return reply.code(400).send({ error: "invalid canvas id", error_code: "INVALID_ID" });
    }
    if (routeUrl.startsWith("/tasks/:canvasId") && !isUuid(params.canvasId)) {
      return reply.code(400).send({ error: "invalid canvas id", error_code: "INVALID_ID" });
    }
    if (routeUrl.startsWith("/canvases/:id/nodes/:nodeId") && !isUuid(params.nodeId)) {
      return reply.code(400).send({ error: "invalid canvas node id", error_code: "INVALID_ID" });
    }
    const query = (req.query ?? {}) as { project_id?: string; canvas_id?: string };
    if ((routeUrl === "/jobs" || routeUrl === "/findings") && query.project_id && !isUuid(query.project_id)) {
      return reply.code(400).send({ error: "invalid project id", error_code: "INVALID_ID" });
    }
    if ((routeUrl === "/jobs" || routeUrl === "/findings") && query.canvas_id && !isUuid(query.canvas_id)) {
      return reply.code(400).send({ error: "invalid canvas id", error_code: "INVALID_ID" });
    }
    const actorProjectId = req.actor?.projectId;
    if ((routeUrl === "/jobs" || routeUrl === "/findings") && query.canvas_id) {
      const [canvas] = await sql`SELECT project_id FROM canvases WHERE id = ${query.canvas_id}`;
      if (!canvas) return reply.code(404).send({ error: "canvas not found", error_code: "NOT_FOUND" });
      if (query.project_id && query.project_id.toLowerCase() !== String(canvas.project_id).toLowerCase()) {
        return reply.code(403).send({ error: "canvas project mismatch", error_code: "PROJECT_MISMATCH" });
      }
      if (canvasScopeDecision(actorProjectId, canvas.project_id as string | null) === "mismatch") {
        return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: "PROJECT_MISMATCH" });
      }
    }
    if (!actorProjectId) return;
    if (routeUrl.startsWith("/reports/:id/")) {
      // Report ids are not authorization boundaries. Resolve the report's
      // project through task_reports -> canvases before serving any artifact;
      // a project-scoped token must never read another project's report blob.
      const reportId = params.id;
      if (!reportId) return;
      const [report] = await sql`
        SELECT COALESCE(tr.project_id, fr.project_id) AS report_project_id,
               c.project_id AS canvas_project_id
        FROM (SELECT 1) anchor
        LEFT JOIN task_reports tr ON tr.id = ${reportId}
        LEFT JOIN finding_reports fr ON fr.id = ${reportId}
        LEFT JOIN canvases c ON c.id = COALESCE(tr.canvas_id, fr.canvas_id)
        WHERE tr.id IS NOT NULL OR fr.id IS NOT NULL`;
      if (report && (
        !projectScopeAllows(actorProjectId, report.report_project_id as string | null)
        || !projectScopeAllows(actorProjectId, report.canvas_project_id as string | null)
      )) {
        return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: "PROJECT_MISMATCH" });
      }
      return;
    }
    if (routeUrl.startsWith("/canvases/:id") || routeUrl.startsWith("/tasks/:canvasId")) {
      const canvasId = params.id ?? params.canvasId;
      if (!canvasId) return;
      const [canvas] = await sql`SELECT project_id FROM canvases WHERE id = ${canvasId}`;
      if (canvas && !projectScopeAllows(actorProjectId, canvas.project_id as string | null)) {
        return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: "PROJECT_MISMATCH" });
      }
      return;
    }
    if (routeUrl.startsWith("/jobs/:id")) {
      const jobId = params.id;
      if (!jobId) return;
      const [job] = await sql`SELECT project_id FROM jobs WHERE id = ${jobId}`;
      if (job && !projectScopeAllows(actorProjectId, job.project_id as string | null)) {
        return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: "PROJECT_MISMATCH" });
      }
      return;
    }
    if (routeUrl.startsWith("/findings/:id")) {
      const findingId = params.id;
      if (!findingId) return;
      const [finding] = await sql`SELECT project_id FROM findings WHERE id = ${findingId}`;
      if (finding && !projectScopeAllows(actorProjectId, finding.project_id as string | null)) {
        return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: "PROJECT_MISMATCH" });
      }
      return;
    }
    if (routeUrl === "/jobs" || routeUrl === "/findings") {
      if (query.project_id && query.project_id !== actorProjectId) {
        return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: "PROJECT_MISMATCH" });
      }
    }
  });

  // Report convergence is a bounded route registrar. Shared auth and project
  // scope hooks above are installed before it, preserving legacy behavior.
  registerReportRoutes(app);
  registerFindingVerificationRoutes(app);
  registerSharedAssetRoutes(app);

  // Model Gateway（§6.3）：自身用 DEEPSONAR_JOB_TOKEN 鉴权（authHook 豁免 /gateway/*）
  registerGateway(app);

  registerAuthRoutes(app);

  registerStreamRoutes(app);

  // ---------- 项目绑定（§7 POST /projects/sync） ----------
  app.post("/projects/sync", async (req, reply) => {
    const body = SyncProjectBody.parse(req.body);
    const [project] = await sql`
      INSERT INTO projects ${sql({
        plane_project_id: body.plane_project_id,
        canvas_id: crypto.randomUUID(),
        name: body.name,
        config_json: body.config as never,
      })}
      ON CONFLICT (plane_project_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING *`;
    // root 节点（幂等：每 canvas 只建一次）
    await sql`
      INSERT INTO canvas_nodes ${sql({
        canvas_id: project.canvas_id,
        node_type: "root",
        title: body.name,
        body_json: { plane_project_id: body.plane_project_id } as never,
        x: 100,
        y: 100,
        w: 320,
        h: 160,
        status: "active",
      })}
      ON CONFLICT DO NOTHING`;
    return project;
  });

  app.get("/projects", async (req) => {
    const actorProjectId = req.actor?.projectId ?? null;
    return sql`
      SELECT * FROM projects
      WHERE (${actorProjectId}::uuid IS NULL OR id = ${actorProjectId})
      ORDER BY created_at DESC`;
  });

  // ---------- 本地项目 CRUD（阶段 A：Plane 可选化，本地库为唯一真相） ----------
  // 创建不再生成历史项目级 root 画布（deprecated canvas_id 仅占位，任务创建时才铸任务画布）
  app.post("/projects", async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);
    try {
      const [project] = await sql`
        INSERT INTO projects ${sql({
          plane_project_id: body.plane_project_id ?? null,
          canvas_id: crypto.randomUUID(),
          name: body.name,
          description: body.description,
          config_json: {} as never,
        })}
        RETURNING *`;
      await audit(req, {
        action: "project.create",
        resourceType: "project",
        resourceId: project.id as string,
        projectId: project.id as string,
        after: { name: project.name },
      });
      return reply.code(201).send(project);
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "该 Plane 项目已绑定到其它本地项目" });
      }
      throw e;
    }
  });

  app.get("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`SELECT * FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.patch("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PatchProjectBody.parse(req.body);
    const sets: Record<string, unknown> = { updated_at: sql`now()` };
    if (body.name !== undefined) sets.name = body.name;
    if (body.description !== undefined) sets.description = body.description;
    if (body.status !== undefined) {
      sets.status = body.status;
      sets.archived_at = body.status === "archived" ? sql`now()` : null;
    }
    const [project] = await sql`
      UPDATE projects SET ${sql(sets as never)} WHERE id = ${id} RETURNING *`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    await audit(req, {
      action: "project.update",
      resourceType: "project",
      resourceId: id,
      projectId: id,
      after: body as unknown,
    });
    return project;
  });

  // 归档 = 软删除：历史任务/事件/Finding 全保留，仅不再允许新建任务与 Plane 同步
  app.post("/projects/:id/archive", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`
      UPDATE projects SET status = 'archived', archived_at = now(), updated_at = now()
      WHERE id = ${id} RETURNING id, status`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    await audit(req, { action: "project.archive", resourceType: "project", resourceId: id, projectId: id });
    return project;
  });

  // ---------- 语义化任务 API（一任务一画布：同事务建画布 + root + pending job） ----------
  app.post("/projects/:id/tasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateTaskBody.parse(req.body);
    const [project] = await sql`SELECT id, status FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (project.status !== "active") return reply.code(409).send({ error: "项目已归档，不能新建任务" });

    let canvasId: string;
    try {
      canvasId = await ensureCanvasForTask({
        projectId: id,
        title: body.title,
        target: {
          title: body.title,
          content: body.content,
          goal: body.content,
          ...(body.finding_protocol ? { finding_protocol: body.finding_protocol } : {}),
          ...(body.allow_egress !== undefined
            ? { network_policy: { allow_egress: body.allow_egress } }
            : {}),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("finding protocol")) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
    const { job, duplicated } = await createJob({
      projectId: id,
      canvasId,
      type: "hub_reason",
      payload: {
        title: body.title,
        content: body.content,
        goal: body.content,
        trigger: { kind: "user_task" },
      },
    });
    if (duplicated || !job) return reply.code(409).send({ error: "任务创建冲突" });
    await audit(req, {
      action: "task.create",
      resourceType: "job",
      resourceId: job.id as string,
      projectId: id,
      after: {
        title: body.title,
        canvas_id: canvasId,
        allow_egress: body.allow_egress ?? "project_default",
      },
    });
    return reply.code(201).send({ canvas_id: canvasId, job });
  });

  // 事件入口：监控、Webhook、CI 等机器事件与人工任务共用 Hub 决策链路。
  app.post("/projects/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = TriggerTaskBody.parse(req.body);
    const [project] = await sql`SELECT id, status FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (project.status !== "active") return reply.code(409).send({ error: "项目已归档，不能接收事件" });

    const serialized = JSON.stringify(body.data);
    const content = body.content ?? `收到 ${body.source} 的 ${body.event_type} 事件：\n${serialized}`;
    if (Buffer.byteLength(content, "utf8") > 20_000) {
      return reply.code(413).send({ error: "事件内容超过 20000 字节，请只发送决策所需信息" });
    }
    const title = body.title ?? `[${body.source}] ${body.event_type}`;
    const trigger = {
      kind: "external_event",
      source: body.source,
      event_type: body.event_type,
      event_id: body.event_id,
      data: body.data,
    };
    const ingressKey = `event:${body.source}:${body.event_id}`;
    const canvasId = await ensureCanvasForTask({
      projectId: id,
      title,
      target: { title, content, goal: content, trigger },
      triggerSource: body.source,
      triggerEventId: body.event_id,
      triggerPayload: body.data,
    });
    const { job, duplicated } = await createJob({
      projectId: id,
      canvasId,
      type: "hub_reason",
      ingressKey,
      payload: { title, content, goal: content, trigger },
    });
    if (duplicated || !job) {
      const [existing] = await sql`
        SELECT * FROM jobs WHERE project_id = ${id} AND ingress_key = ${ingressKey} LIMIT 1`;
      return reply.code(200).send({ canvas_id: canvasId, job: existing ?? null, duplicated: true });
    }
    return reply.code(201).send({ canvas_id: canvasId, job, duplicated: false });
  });

  /**
   * 恢复会话 = 继续执行任务（不删历史）。
   * 优先级：解除 hub_paused → 恢复最近可恢复 Job → 空闲时强制唤醒 Hub。
   */
  app.post("/tasks/:canvasId/resume-session", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    if ((canvas.status as string) === "archived") {
      return reply.code(409).send({ error: "任务已归档，请先取消归档再恢复会话" });
    }
    const projectId = canvas.project_id as string;

    const active = await sql`
      SELECT id, type, status FROM jobs WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human')
      ORDER BY created_at DESC LIMIT 5`;
    if (active.length > 0) {
      return {
        canvas_id: canvasId,
        action: "already_running" as const,
        jobs: active,
        message: "任务已有活动 Job，无需恢复",
      };
    }

    // 清暂停 / auto_stopped，允许继续自驱
    const convergence = await patchCanvasConvergence(sql, canvasId, {
      hub_paused: false,
      auto_stopped: false,
      paused_reason: undefined,
      paused_at: undefined,
    });

    // 优先恢复最近 failed/timeout/orphan（waiting_human 也算可继续）
    const [resumable] = await sql`
      SELECT id, type, status FROM jobs
      WHERE canvas_id = ${canvasId}
        AND status IN ('failed','timeout','orphan','waiting_human')
      ORDER BY created_at DESC LIMIT 1`;
    if (resumable) {
      const row = await createSqlJobLifecycleApplication().transitionJob(resumable.id as string, "pending", {
        error: null,
        lease_expires_at: null,
        claimed_at: null,
        started_at: null,
        finished_at: null,
        heartbeat_at: null,
      });
      if (row) {
        await normalizePendingJobPriority(resumable.id as string);
        await sql`
          UPDATE canvas_nodes SET status = 'pending', updated_at = now()
          WHERE job_id = ${resumable.id as string} AND node_type = ANY(${["job", "intent"]})`;
        await audit(req, {
          action: "task.resume_session",
          resourceType: "job",
          resourceId: resumable.id as string,
          projectId,
          after: { canvas_id: canvasId, mode: "resume_job", from_status: resumable.status },
        });
        await sql`SELECT pg_notify('deepsonar_jobs', 'resume_session')`;
        return reply.code(200).send({
          canvas_id: canvasId,
          action: "resume_job" as const,
          job: row,
          convergence,
        });
      }
    }

    // 无可恢复 Job：强制唤醒一轮 Hub 继续决策
    await sql.begin(async (tx) => {
      await maybeTriggerHub(
        tx as unknown as typeof sql,
        {
          id: null,
          project_id: projectId,
          canvas_id: canvasId,
          type: "manual",
          priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
        },
        { manual: true, force: true, trigger: { kind: "resume_session" } },
      );
    });
    const [hub] = await sql`
      SELECT id, type, status, created_at FROM jobs
      WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
      ORDER BY created_at DESC LIMIT 1`;
    await audit(req, {
      action: "task.resume_session",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId,
      after: { mode: "wake_hub", hub_job_id: hub?.id ?? null },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'resume_session')`;
    return reply.code(200).send({
      canvas_id: canvasId,
      action: "wake_hub" as const,
      job: hub ?? null,
      convergence,
    });
  });

  /**
   * 重试任务 = 清空本画布历史后从意图重新执行。
   * 保留 canvas 行与 target_json（任务意图）；删除 jobs/nodes/edges/findings/events/reports。
   */
  app.post("/tasks/:canvasId/retry", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    if ((canvas.status as string) === "archived") {
      return reply.code(409).send({ error: "任务已归档，请先取消归档再重试" });
    }
    const projectId = canvas.project_id as string;

    const active = await sql`
      SELECT 1 FROM jobs WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
    if (active.length > 0) return reply.code(409).send({ error: "该任务仍有活动 job，请先取消后再重试" });

    const target = { ...((canvas.target_json ?? {}) as Record<string, unknown>) };
    delete target.convergence;
    const title = (canvas.title as string) || "任务";
    const content =
      (typeof target.content === "string" && target.content.trim()) ||
      (typeof target.goal === "string" && target.goal.trim()) ||
      title;
    const payload: Record<string, unknown> = {
      title,
      content,
      goal: content,
      trigger: { kind: "user_task", restart: true },
    };
    if (target.network_policy && typeof target.network_policy === "object") {
      payload.network_policy = target.network_policy;
    }

    const retryResult = await sql.begin(async (tx) => {
      // Retry is a destructive canvas reset. Serialize the whole operation
      // on the same advisory key used by dispatcher claim, then on the canvas
      // row. This prevents a dispatcher from claiming a pending Job after the
      // active check but before wipeCanvasRuntimeData runs. Re-check active
      // work after acquiring both locks; the preflight query is only a fast
      // path.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      const [lockedCanvas] = await tx`
        SELECT id, status FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
      if (!lockedCanvas) return { job: null, reason: "canvas_not_found" as const };
      if ((lockedCanvas.status as string) === "archived") {
        return { job: null, reason: "archived" as const };
      }
      const activeInside = await tx`
        SELECT 1 FROM jobs WHERE canvas_id = ${canvasId}
          AND status IN ('pending','claimed','provisioning','running','waiting_human')
        LIMIT 1`;
      if (activeInside.length > 0) return { job: null, reason: "active" as const };
      await wipeCanvasRuntimeData(tx, canvasId);

      // 重置意图上的收敛态，保留用户任务内容
      await tx`
        UPDATE canvases SET target_json = ${tx.json(target as never)}
        WHERE id = ${canvasId}`;

      await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: null,
          node_type: "root",
          title,
          body_json: { target } as never,
          x: 100,
          y: 100,
          status: "active",
        })}`;

      // 同事务内插入入口 Hub，避免 createJob 另开连接看不到未提交删除
      const snapshot = await resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, "hub_reason");
      const [hubJob] = await tx`
        INSERT INTO jobs ${tx({
          project_id: projectId,
          canvas_id: canvasId,
          plane_issue_id: (canvas.plane_issue_id as string) ?? null,
          agent_snapshot_json: snapshot as never,
          type: "hub_reason",
          priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
          payload_json: { ...payload, scheduling_purpose: "hub" } as never,
          timeout_sec: config.timeouts.auditSec,
          followup_depth: 0,
        })}
        RETURNING *`;
      await recordJobSharedAssets(tx as unknown as typeof sql, hubJob.id as string, snapshot.shared_assets ?? []);

      const [{ next_x }] = await tx<[{ next_x: number }]>`
        SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes
        WHERE canvas_id = ${canvasId}`;
      const [hubNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: hubJob.id as string,
          node_type: "job",
          title: "Hub 决策",
          body_json: { type: "hub_reason", trigger: payload.trigger } as never,
          x: next_x,
          y: 300,
          status: "pending",
        })}
        RETURNING id`;
      const [root] = await tx`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
      if (root) {
        await tx`
          INSERT INTO canvas_edges ${tx({
            canvas_id: canvasId,
            from_node_id: root.id,
            to_node_id: hubNode.id,
            edge_type: "child",
          })}`;
      }
      return { job: hubJob, reason: undefined };
    });

    if (!retryResult.job) {
      if (retryResult.reason === "archived") {
        return reply.code(409).send({ error: "任务已归档，请先取消归档再重试" });
      }
      if (retryResult.reason === "active") {
        return reply.code(409).send({ error: "该任务仍有活动 Job，请先取消后再重试" });
      }
      return reply.code(404).send({ error: "canvas not found" });
    }
    const job = retryResult.job;

    await audit(req, {
      action: "task.retry_hard",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId,
      after: { canvas_id: canvasId, job_id: job.id, mode: "wipe_and_rerun" },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'task_retry')`;
    return reply.code(201).send(job);
  });

  /**
   * 归档任务（软删除）：取消活动 Job、暂停 hub，历史数据保留；默认列表隐藏。
   */
  app.post("/tasks/:canvasId/archive", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    if ((canvas.status as string) === "archived") {
      return reply.code(200).send({
        id: canvasId,
        status: "archived",
        archived_at: canvas.archived_at,
        cancelled_jobs: 0,
      });
    }
    const cancelled = await cancelActiveJobsOnCanvas(canvasId);
    await patchCanvasConvergence(sql, canvasId, {
      hub_paused: true,
      paused_reason: "task_archived",
    }).catch(() => {});
    const [row] = await sql`
      UPDATE canvases
      SET status = 'archived', archived_at = now()
      WHERE id = ${canvasId}
      RETURNING id, status, archived_at, project_id, title`;
    await audit(req, {
      action: "task.archive",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: row.project_id as string,
      after: { status: "archived", cancelled_jobs: cancelled },
    });
    return { ...row, cancelled_jobs: cancelled };
  });

  /** 取消归档：恢复为 active，不自动唤醒 Hub（需手动恢复会话）。 */
  app.post("/tasks/:canvasId/unarchive", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const [project] = await sql`SELECT status FROM projects WHERE id = ${canvas.project_id}`;
    if (project?.status === "archived") {
      return reply.code(409).send({ error: "所属项目已归档，不能恢复任务" });
    }
    const [row] = await sql`
      UPDATE canvases
      SET status = 'active', archived_at = NULL
      WHERE id = ${canvasId}
      RETURNING id, status, archived_at, project_id, title`;
    await audit(req, {
      action: "task.unarchive",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: row.project_id as string,
      after: { status: "active" },
    });
    return row;
  });

  /**
   * 硬删除任务数据：画布 + jobs/findings/events/报告/图节点一并清除，不可恢复。
   * 有活动 Job 时先取消；删除后画布行不存在。
   */
  app.delete("/tasks/:canvasId", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const projectId = canvas.project_id as string;
    const cancelled = await cancelActiveJobsOnCanvas(canvasId);

    await sql.begin(async (tx) => {
      await wipeCanvasRuntimeData(tx, canvasId);
      // 历史 projects.canvas_id 可能指向本画布（遗留字段）
      await tx`
        UPDATE projects SET canvas_id = ${`archived-${canvasId}`}
        WHERE canvas_id = ${canvasId}`;
      await tx`DELETE FROM canvases WHERE id = ${canvasId}`;
    });

    await audit(req, {
      action: "task.delete",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId,
      after: {
        deleted: true,
        title: canvas.title,
        cancelled_jobs: cancelled,
      },
    });
    return reply.code(200).send({
      ok: true,
      id: canvasId,
      deleted: true,
      cancelled_jobs: cancelled,
    });
  });

  // ---------- Plane 集成（按项目绑定；解绑不删除已导入任务） ----------
  app.put("/projects/:id/integrations/plane", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PlaneBindBody.parse(req.body);
    try {
      const [project] = await sql`
        UPDATE projects SET plane_project_id = ${body.plane_project_id}, updated_at = now()
        WHERE id = ${id} RETURNING id, name, plane_project_id`;
      if (!project) return reply.code(404).send({ error: "project not found" });
      await audit(req, {
        action: "plane.bind",
        resourceType: "project",
        resourceId: id,
        projectId: id,
        after: { plane_project_id: body.plane_project_id },
      });
      return project;
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "该 Plane 项目已绑定到其它本地项目" });
      }
      throw e;
    }
  });

  app.delete("/projects/:id/integrations/plane", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`
      UPDATE projects SET plane_project_id = NULL, updated_at = now()
      WHERE id = ${id} RETURNING id, name, plane_project_id`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    await audit(req, { action: "plane.unbind", resourceType: "project", resourceId: id, projectId: id });
    return project;
  });

  // 手动触发一次该项目的 Ready issue 导入（事件驱动之外的补跑入口）
  app.post("/projects/:id/integrations/plane/sync", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const created = await planePollProject(id);
      return { ok: true, created };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Plane 连接信息（任务页「去 Plane 下发任务」指引用；不含 token） */
  app.get("/plane-info", async () => ({
    enabled: config.plane.enabled,
    web_url: config.plane.webUrl,
    workspace_slug: config.plane.workspaceSlug,
    ready_state: config.plane.readyState,
  }));

  registerSkillSourceRoutes(app);

  registerRuntimeImageRoutes(app);

  // ---------- RoleConfig（§4.2：角色即配置；全局缺省 + 项目级覆盖） ----------

  const RoleConfigPutBody = z.object({
    agent_cli: z.enum(["claude-code", "open-code", "codex"]).default("claude-code"),
    model: z.string().nullish(),
    reasoning: ReasoningEffort.nullish(),
    env_keys: z.array(z.string()).default([]),
    env_vars: z.record(z.string(), z.string()).default({}),
    modules: z.array(z.string()).default([]),
    skills: z.array(z.record(z.string(), z.unknown())).default([]),
    commands: z.array(z.record(z.string(), z.unknown())).default([]),
    mcps: z.array(z.record(z.string(), z.unknown())).default([]),
    subagents: z.array(z.record(z.string(), z.unknown())).default([]),
    platform_tools: z.partialRecord(PlatformToolName, z.boolean()).default({}),
    instructions_markdown: z.string().max(100_000).nullish(),
    runtime_image_key: z.string().nullish(),
    credentials: z.array(z.object({ credential_id: z.string().uuid(), purpose: z.string().min(1).max(50) })).default([]),
    config_files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  });

  async function validateRoleConfigBody(
    body: z.infer<typeof RoleConfigPutBody>,
    projectId: string | null,
    role: { name: string; kind: "role" | "hub" | "system" },
    db: typeof sql = sql,
  ): Promise<string | null> {
    const envErr = validateEnvVars(body.env_vars);
    if (envErr) return envErr;
    for (const key of body.env_keys) {
      if (!config.runtime.isEnvKeyAllowed(key)) return `env_key 不在白名单: ${key}`;
    }
    for (const selector of body.modules) {
      try {
        parseModuleSelector(selector);
      } catch (error) {
        return `模块 selector 非法（${selector}）: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (body.runtime_image_key) {
      const [image] = await db`
        SELECT ri.id, ri.official, ri.project_opt_in,
               EXISTS (SELECT 1 FROM runtime_image_versions v WHERE v.runtime_image_id = ri.id AND v.trust_status = 'trusted') AS has_trusted,
               pri.enabled AS project_enabled
        FROM runtime_images ri
        LEFT JOIN project_runtime_images pri ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
        WHERE ri.image_key = ${body.runtime_image_key} AND ri.enabled = true`;
      if (!image) return `runtime_image_key 不存在或已禁用: ${body.runtime_image_key}`;
      const fakeOfficialCatalogImage = config.runtime.agentMode === "fake" && image.official && !image.project_opt_in;
      if (!image.has_trusted && !fakeOfficialCatalogImage) return `runtime_image_key 没有可信版本: ${body.runtime_image_key}`;
      if ((!image.official || image.project_opt_in) && (!projectId || image.project_enabled !== true)) {
        return `镜像必须先在目标项目显式启用: ${body.runtime_image_key}`;
      }
    }
    const allowedTools = new Set<string>(allowedPlatformTools(role.name, role.kind));
    for (const tool of Object.keys(body.platform_tools)) {
      if (!allowedTools.has(tool)) return `角色 ${role.name} 不支持平台工具: ${tool}`;
    }
    for (const tool of requiredPlatformTools(role.kind)) {
      if (body.platform_tools[tool] === false) return `终态必需平台工具不可关闭: ${tool}`;
    }
    for (const c of body.credentials) {
      // RoleConfig PUTs run under the same advisory lock as Credential
      // provider/project/metadata mutations.  Lock each row while reading so
      // a concurrent Credential PATCH cannot invalidate this validation.
      const [cred] = await db`
        SELECT id, project_id, status, provider, public_metadata_json
        FROM credentials WHERE id = ${c.credential_id} FOR UPDATE`;
      if (!cred) return `Credential 不存在: ${c.credential_id}`;
      if (projectId && cred.project_id && cred.project_id !== projectId) {
        return `Credential ${c.credential_id} 属于其他项目，不能绑定`;
      }
      if (!projectId && cred.project_id) return `全局 RoleConfig 只能绑定全局 Credential`;
      if (c.purpose === "llm") {
        const compatibilityError = validateCredentialCompatibility(body.agent_cli, String(cred.provider ?? ""));
        if (compatibilityError) return compatibilityError;
      }
      if (c.purpose === "llm" && body.model) {
        const allowed = allowedModelIds(cred.public_metadata_json);
        if (allowed.length > 0 && !allowed.includes(body.model)) {
          return `模型 ${body.model} 不在 Credential ${c.credential_id} 的 allowed_model_ids 白名单`;
        }
      }
      if (c.purpose === "llm" && !body.model && allowedModelIds(cred.public_metadata_json).length > 0) {
        return `Credential ${c.credential_id} 已启用模型白名单，请显式选择模型`;
      }
    }
    if (body.config_files.length > CONFIG_FILE_MAX_COUNT) return `配置文件数量超限（>${CONFIG_FILE_MAX_COUNT}）`;
    let totalBytes = 0;
    for (const f of body.config_files) {
      const pathErr = validateConfigFilePath(body.agent_cli, f.path);
      if (pathErr) return `配置文件 ${f.path}: ${pathErr}`;
      const bytes = Buffer.byteLength(f.content, "utf8");
      if (bytes > CONFIG_FILE_MAX_BYTES) return `配置文件 ${f.path} 超过单文件大小限制`;
      totalBytes += bytes;
      const secretHit = scanConfigContent(f.content);
      if (secretHit) return `配置文件 ${f.path} 命中密钥特征（${secretHit}），请改用 Credential`;
    }
    if (totalBytes > CONFIG_FILE_MAX_TOTAL) return `配置文件总大小超限`;
    return null;
  }

  async function upsertRoleConfigInTx(
    tx: typeof sql,
    roleId: string,
    projectId: string | null,
    body: z.infer<typeof RoleConfigPutBody>,
  ) {
    const [existing] = projectId
      ? await tx`SELECT id, version FROM role_configs WHERE role_id = ${roleId} AND project_id = ${projectId}`
      : await tx`SELECT id, version FROM role_configs WHERE role_id = ${roleId} AND project_id IS NULL`;
    const row = {
      role_id: roleId,
      project_id: projectId,
      agent_cli: body.agent_cli,
      model: body.model ?? null,
      reasoning: body.reasoning ?? null,
      env_keys: body.env_keys as never,
      env_vars_json: body.env_vars as never,
      modules_json: body.modules as never,
      skills_json: body.skills as never,
      commands_json: body.commands as never,
      mcps_json: body.mcps as never,
      subagents_json: body.subagents as never,
      platform_tools_json: body.platform_tools as never,
      instructions_markdown: body.instructions_markdown ?? null,
      runtime_image_key: body.runtime_image_key ?? null,
    };
    let configId: string;
    if (existing) {
      configId = existing.id as string;
      await tx`
        UPDATE role_configs SET ${tx(row as never)}, version = version + 1, updated_at = now()
        WHERE id = ${configId}`;
    } else {
      const [ins] = await tx`INSERT INTO role_configs ${tx(row as never)} RETURNING id`;
      configId = ins.id as string;
    }
    await tx`DELETE FROM role_credentials WHERE role_config_id = ${configId}`;
    for (const c of body.credentials) {
      await tx`
        INSERT INTO role_credentials ${tx({ role_config_id: configId, credential_id: c.credential_id, purpose: c.purpose })}
        ON CONFLICT DO NOTHING`;
    }
    await tx`DELETE FROM role_config_files WHERE role_config_id = ${configId}`;
    for (const f of body.config_files) {
      await tx`
        INSERT INTO role_config_files ${tx({
          role_config_id: configId,
          path: f.path,
          content: f.content,
          content_sha256: createHash("sha256").update(f.content, "utf8").digest("hex"),
        })}
        ON CONFLICT (role_config_id, path) DO UPDATE SET
          content = EXCLUDED.content, content_sha256 = EXCLUDED.content_sha256, updated_at = now()`;
    }
    return configId;
  }

  /**
   * Validate and upsert atomically.  Credential PATCH takes this same
   * advisory lock before locking its credential row, so validation cannot be
   * invalidated by a concurrent provider/project/metadata mutation.
   */
  async function mutateRoleConfig(
    roleId: string,
    projectId: string | null,
    body: z.infer<typeof RoleConfigPutBody>,
    role: { name: string; kind: "role" | "hub" | "system" },
  ): Promise<{ configId: string } | { statusCode: number; error: string }> {
    return sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      if (projectId && role.kind === "role") {
        const enabled = await rolesForProject(tx, projectId);
        if (!enabled.some((r) => r.name === role.name)) {
          return { statusCode: 409, error: `角色 ${role.name} 未在本项目启用` };
        }
      }
      const err = await validateRoleConfigBody(body, projectId, role, tx);
      if (err) return { statusCode: 400, error: err };
      return { configId: await upsertRoleConfigInTx(tx, roleId, projectId, body) };
    });
  }

  /**
   * Return a RoleConfig with Credential bindings projected for the caller's
   * project.  The RoleConfig row itself is only reached through an endpoint
   * whose scope has already been checked, but legacy/malformed bindings can
   * still point at a Credential owned by another project.  Never expose that
   * binding (or its project/name/provider/status metadata) to a project token.
   */
  async function roleConfigView(
    configId: string,
    actorProjectId: string | null = null,
  ): Promise<Record<string, unknown> | null> {
    const [cfg] = await sql`SELECT * FROM role_configs WHERE id = ${configId}`;
    if (!cfg) return null;
    const creds = await sql`
      SELECT rc.credential_id, rc.purpose, c.name, c.kind, c.provider, c.status, c.project_id
      FROM role_credentials rc JOIN credentials c ON c.id = rc.credential_id
      WHERE rc.role_config_id = ${configId}
        AND (${actorProjectId}::uuid IS NULL OR c.project_id IS NULL OR c.project_id = ${actorProjectId})`;
    const files = await sql`
      SELECT path, content, content_sha256 FROM role_config_files
      WHERE role_config_id = ${configId} ORDER BY path`;
    return {
      ...(cfg as Record<string, unknown>),
      credentials: creds.map((credential) => ({
        ...credential,
        ...projectCredentialProvider(credential.kind ?? "llm_provider", credential.provider),
      })),
      config_files: files,
    };
  }

  app.get("/role-configs/global", async (req) => {
    const actorProjectId = req.actor?.projectId ?? null;
    const rows = await sql`
      SELECT rc.id, r.name AS role_name, r.title AS role_title, r.kind AS role_kind
      FROM role_configs rc JOIN agent_roles r ON r.id = rc.role_id
      WHERE rc.project_id IS NULL ORDER BY r.name`;
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const view = await roleConfigView(row.id as string, actorProjectId);
      if (!view) continue;
      out.push({
        ...view,
        role_name: row.role_name,
        role_title: row.role_title,
        role_kind: row.role_kind,
      });
    }
    return out;
  });

  /** Unified binding picker for the Provider account flow. It intentionally
   * returns only RoleConfig identity/health metadata, never secret material. */
  app.get("/role-configs/bindable", async (req) => {
    const projectScope = req.actor?.projectId ?? null;
    const rows = await sql`
      SELECT rc.id, rc.role_id, r.name AS role_name, r.title AS role_title,
             rc.project_id, p.name AS project_name, rc.agent_cli, rc.model, rc.version,
             c.id AS credential_id, c.name AS credential_name, c.kind AS credential_kind,
             c.provider AS credential_provider, c.status AS credential_status
      FROM role_configs rc
      JOIN agent_roles r ON r.id = rc.role_id
      LEFT JOIN projects p ON p.id = rc.project_id
      LEFT JOIN LATERAL (
        SELECT c.id, c.name, c.kind, c.provider, c.status
        FROM role_credentials rcb
        JOIN credentials c ON c.id = rcb.credential_id
        WHERE rcb.role_config_id = rc.id AND rcb.purpose = 'llm'
          AND (${projectScope}::uuid IS NULL OR c.project_id IS NULL OR c.project_id = ${projectScope})
        ORDER BY c.created_at DESC
        LIMIT 1
      ) c ON true
      WHERE (${projectScope}::uuid IS NULL OR rc.project_id IS NULL OR rc.project_id = ${projectScope})
      ORDER BY rc.project_id NULLS FIRST, r.name`;
    return rows.map((row) => ({
      ...row,
      scope: row.project_id ? "project" : "global",
      can_bind: !projectScope || String(row.project_id ?? "") === projectScope,
      credential_provider: row.credential_provider
        ? projectCredentialProvider(row.credential_kind ?? "llm_provider", row.credential_provider).provider
        : null,
      credential_provider_valid: row.credential_provider
        ? projectCredentialProvider(row.credential_kind ?? "llm_provider", row.credential_provider).provider_valid
        : null,
    }));
  });

  app.put("/role-configs/global/:roleId", async (req, reply) => {
    const { roleId } = req.params as { roleId: string };
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may modify only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RoleConfigPutBody.parse(req.body);
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${roleId}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    const mutation = await mutateRoleConfig(roleId, null, body, {
      name: role.name as string,
      kind: role.kind as "role" | "hub" | "system",
    });
    if ("error" in mutation) return reply.code(mutation.statusCode).send({ error: mutation.error });
    const configId = mutation.configId;
    await audit(req, {
      action: "role_config.upsert",
      resourceType: "role_config",
      resourceId: configId,
      after: { role: role.name, scope: "global", credentials: body.credentials.length, files: body.config_files.length },
    });
    return roleConfigView(configId, req.actor?.projectId ?? null);
  });

  app.get("/projects/:id/role-configs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && actorProjectId !== id) {
      return reply.code(403).send({
        error: "project-scoped actors may read only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const [p] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const rows = await sql`
      SELECT r.id AS role_id, r.name, r.title, r.kind, r.builtin,
             pc.id AS project_config_id, pc.version AS project_config_version,
             gc.id AS global_config_id, gc.version AS global_config_version,
             CASE WHEN pc.id IS NOT NULL THEN 'project'
                  WHEN gc.id IS NOT NULL THEN 'global'
                  ELSE 'none' END AS config_source
      FROM agent_roles r
      LEFT JOIN role_configs pc ON pc.role_id = r.id AND pc.project_id = ${id}
      LEFT JOIN role_configs gc ON gc.role_id = r.id AND gc.project_id IS NULL
      ORDER BY r.kind, r.builtin DESC, r.name`;
    return Promise.all(rows.map(async (row) => ({
      ...row,
      project_config: row.project_config_id
        ? await roleConfigView(row.project_config_id as string, actorProjectId)
        : null,
    })));
  });

  app.put("/projects/:id/role-configs/:roleId", async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && actorProjectId !== id) {
      return reply.code(403).send({
        error: "project-scoped actors may modify only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RoleConfigPutBody.parse(req.body);
    const [p] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${roleId}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    const mutation = await mutateRoleConfig(roleId, id, body, {
      name: role.name as string,
      kind: role.kind as "role" | "hub" | "system",
    });
    if ("error" in mutation) return reply.code(mutation.statusCode).send({ error: mutation.error });
    const configId = mutation.configId;
    await audit(req, {
      action: "role_config.upsert",
      resourceType: "role_config",
      resourceId: configId,
      projectId: id,
      after: { role: role.name, scope: "project", credentials: body.credentials.length, files: body.config_files.length },
    });
    return roleConfigView(configId, actorProjectId);
  });

  app.delete("/projects/:id/role-configs/:roleId", async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && actorProjectId !== id) {
      return reply.code(403).send({
        error: "project-scoped actors may modify only their own project RoleConfigs",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const [row] = await sql`
      DELETE FROM role_configs WHERE role_id = ${roleId} AND project_id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: "该项目没有此角色的覆盖配置" });
    await audit(req, {
      action: "role_config.delete",
      resourceType: "role_config",
      resourceId: row.id as string,
      projectId: id,
    });
    return { ok: true };
  });

  // ---------- 角色注册表：hub 可下发的 agent 类型，全局注册 + 项目级启用 ----------
  app.get("/agent-roles", async () =>
    sql`SELECT id, name, title, description, builtin, kind, ui_color, created_at, updated_at
        FROM agent_roles ORDER BY kind DESC, builtin DESC, name`,
  );

  app.post("/agent-roles", async (req, reply) => {
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may not modify the global role registry",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RoleBody.parse(req.body);
    try {
      const row = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        // Serialize the used-color read with the INSERT.  Deleting a role
        // naturally releases its color because no tombstone is retained.
        const uiColor = await allocateRoleUiColor(tx);
        const [created] = await tx`
          INSERT INTO agent_roles ${tx({ ...body, builtin: false, kind: "role", ui_color: uiColor })}
          RETURNING id, name, title, description, builtin, kind, ui_color`;
        return created;
      });
      if (!row) throw new Error("角色创建失败：未返回新角色");
      await audit(req, {
        action: "role.create",
        resourceType: "agent_role",
        resourceId: row.id as string,
        after: { name: row.name, title: row.title, ui_color: row.ui_color },
      });
      return row;
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: `角色 ${body.name} 已存在` });
      }
      throw e;
    }
  });

  app.patch("/agent-roles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may not modify the global role registry",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const body = RolePatchBody.parse(req.body);
    const [row] = await sql`
      UPDATE agent_roles SET ${sql(body)}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, name, title, description, builtin, kind, ui_color`;
    if (!row) return reply.code(404).send({ error: "role not found" });
    await audit(req, {
      action: "role.update",
      resourceType: "agent_role",
      resourceId: id,
      after: {
        name: row.name,
        changed: Object.keys(body),
      },
    });
    return row;
  });

  app.delete("/agent-roles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (req.actor?.projectId) {
      return reply.code(403).send({
        error: "project-scoped actors may not modify the global role registry",
        error_code: "PROJECT_SCOPE_FORBIDDEN",
      });
    }
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${id}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    if (role.kind !== "role") {
      return reply.code(409).send({ error: "系统角色与 Hub 中枢不可删除，只能修改职责和运行配置" });
    }
    const [row] = await sql`
      DELETE FROM agent_roles WHERE id = ${id} AND kind = 'role' RETURNING id, name`;
    if (!row) return reply.code(409).send({ error: "角色状态已变化，请刷新后重试" });
    await audit(req, {
      action: "role.delete",
      resourceType: "agent_role",
      resourceId: id,
      before: { name: row.name, kind: role.kind },
    });
    return { ok: true };
  });

  // 项目视角的角色清单：全部角色 + 本项目启用状态
  app.get("/projects/:id/roles", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    const enabled = ((cfg.roles as Record<string, unknown> | undefined)?.enabled ?? null) as string[] | null;
    const all = await sql`
      SELECT id, name, title, description, builtin, kind, ui_color FROM agent_roles
      WHERE kind = 'role' ORDER BY builtin DESC, name`;
    const set = enabled == null ? null : new Set(enabled);
    return (all as unknown as { name: string; builtin: boolean; ui_color: string | null }[]).map((r) => ({
      ...r,
      enabled: set == null ? r.builtin : set.has(r.name),
      default_enabled: enabled == null,
    }));
  });

  // ---------- 全局设置（§8.1 所有配置落库：规则默认值 → global_settings 单例行） ----------
  const aggregateActive = (rows: Record<string, unknown>[], key: "agent_cli" | "provider") => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const name = key === "provider"
        ? row[key] == null || row[key] === ""
          ? ""
          : projectCredentialProvider("llm_provider", row[key]).provider
        : String(row[key] ?? "");
      if (name) out[name] = (out[name] ?? 0) + Number(row.count);
    }
    return out;
  };

  app.get("/global-settings", async () => {
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const storedRules = ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>;
    const findingProtocol = parseStoredFindingProtocolConfig(storedRules.finding_protocol);
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules: storedRules,
      effective_rules: await globalRules(sql),
      finding_protocol: findingProtocol ?? null,
      effective_finding_protocol: resolveFindingProtocol(findingProtocol),
      active_by_agent_cli: aggregateActive(activeRows, "agent_cli"),
      active_by_provider: aggregateActive(activeRows, "provider"),
    };
  });

  app.patch("/global-settings", async (req, reply) => {
    let body: z.infer<typeof GlobalSettingsPatchBody>;
    try {
      body = GlobalSettingsPatchBody.parse(req.body);
    } catch (error) {
      return reply.code(400).send({ error: "invalid global settings rules", details: error instanceof z.ZodError ? error.issues : undefined });
    }
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const current = ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>;
    const merged = body.rules ? mergeGlobalRulesPatch(current, body.rules) : { ...current };
    if (body.finding_protocol !== undefined) {
      if (body.finding_protocol === null) delete merged.finding_protocol;
      else merged.finding_protocol = body.finding_protocol;
    }
    let effectiveFindingProtocol;
    try {
      effectiveFindingProtocol = resolveFindingProtocol(
        parseStoredFindingProtocolConfig(merged.finding_protocol),
      );
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid finding protocol" });
    }
    await sql`UPDATE global_settings SET rules_json = ${sql.json(merged as never)}, updated_at = now() WHERE id = 'global'`;
    // Wake a LISTEN-driven dispatcher so a newly available slot/CLI cap is
    // observed without waiting for an optional polling interval or restart.
    await sql`SELECT pg_notify('deepsonar_jobs', 'global-settings-updated')`;
    // 全局规则修改是「全局规则修改」必记项
    await audit(req, {
      action: "settings.global_update",
      resourceType: "global_settings",
      resourceId: "global",
      after: {
        changed_keys: [
          ...Object.keys(body.rules ?? {}),
          ...(body.finding_protocol !== undefined ? ["finding_protocol"] : []),
        ],
      },
    });
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules: merged,
      effective_rules: await globalRules(sql),
      finding_protocol: parseStoredFindingProtocolConfig(merged.finding_protocol) ?? null,
      effective_finding_protocol: effectiveFindingProtocol,
      active_by_agent_cli: aggregateActive(activeRows, "agent_cli"),
      active_by_provider: aggregateActive(activeRows, "provider"),
    };
  });

  // ---------- 项目设置：运行规则 + 角色启停 ----------
  // ---------- Readiness / preflight projection (#35/#36, read-only) ----------
  // The projection reads only Scheduler-owned rows. Query values are a small
  // enum/boolean overlay for the task form; secrets, env names and OCI refs
  // are never accepted or returned here.
  function parseReadinessQuery(req: { query?: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): z.infer<typeof ReadinessQuery> | null {
    const parsed = ReadinessQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid readiness query", details: parsed.error.issues });
      return null;
    }
    return parsed.data;
  }

  async function readinessResponse(
    req: { query?: unknown },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    projectId?: string,
  ) {
    const query = parseReadinessQuery(req, reply);
    if (!query) return;
    if (projectId && !z.string().uuid().safeParse(projectId).success) {
      return reply.code(400).send({ error: "invalid project id" });
    }
    try {
      return await loadReadiness(sql, {
        projectId,
        allowEgress: query.allow_egress === undefined ? undefined : query.allow_egress === "true",
        materialSource: query.material_source as ReadinessMaterialSource | undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "project not found") {
        return reply.code(404).send({ error: "project not found" });
      }
      throw error;
    }
  }

  app.get("/readiness", async (req, reply) => readinessResponse(req, reply));
  app.get("/projects/:id/readiness", async (req, reply) => {
    const { id } = req.params as { id: string };
    return readinessResponse(req, reply, id);
  });

  app.get("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    const globalProtocol = parseStoredFindingProtocolConfig(
      ((g?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const projectProtocol = parseStoredFindingProtocolConfig(cfg.finding_protocol);
    return {
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
      roles: (cfg.roles ?? { enabled: null }) as Record<string, unknown>,
      effective_rules: await rulesForProject(sql, id),
      finding_protocol: projectProtocol ?? null,
      effective_finding_protocol: resolveFindingProtocol(globalProtocol, projectProtocol),
    };
  });

  app.patch("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    let body: z.infer<typeof SettingsPatchBody>;
    try {
      body = SettingsPatchBody.parse(req.body);
    } catch (error) {
      return reply.code(400).send({ error: "invalid project settings rules", details: error instanceof z.ZodError ? error.issues : undefined });
    }
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    if (body.rules) {
      cfg.rules = { ...((cfg.rules as Record<string, unknown>) ?? {}), ...body.rules };
    }
    if (body.roles) {
      const roles = { ...((cfg.roles as Record<string, unknown>) ?? {}) };
      if (body.roles.enabled === null) delete roles.enabled; // null = 恢复默认（全部内置）
      else if (body.roles.enabled !== undefined) roles.enabled = body.roles.enabled;
      cfg.roles = roles;
    }
    if (body.finding_protocol !== undefined) {
      if (body.finding_protocol === null) delete cfg.finding_protocol;
      else cfg.finding_protocol = body.finding_protocol;
    }
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const globalProtocol = parseStoredFindingProtocolConfig(
      ((g?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
    );
    const projectProtocol = parseStoredFindingProtocolConfig(cfg.finding_protocol);
    let effectiveFindingProtocol;
    try {
      effectiveFindingProtocol = resolveFindingProtocol(globalProtocol, projectProtocol);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid finding protocol" });
    }
    await sql`UPDATE projects SET config_json = ${sql.json(cfg as never)} WHERE id = ${id}`;
    // Project rule changes can alter effective task behavior; wake dispatch so
    // pending jobs do not wait for the next unrelated enqueue event.
    await sql`SELECT pg_notify('deepsonar_jobs', 'project-settings-updated')`;
    // 项目级 rules 覆盖 / roles 启停都属配置修改
    await audit(req, {
      action: "settings.project_update",
      resourceType: "project",
      resourceId: id,
      projectId: id,
      after: { changed: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined) },
    });
    return {
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
      roles: (cfg.roles ?? { enabled: null }) as Record<string, unknown>,
      effective_rules: await rulesForProject(sql, id),
      finding_protocol: projectProtocol ?? null,
      effective_finding_protocol: effectiveFindingProtocol,
    };
  });

  // ---------- 任务画布（§3.2：一任务一画布） ----------
  // 列表：项目下所有任务画布 + rollup 计数
  app.get("/projects/:id/canvases", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { status?: string };
    // 默认只返回 active；status=archived|all 显式筛选
    const statusFilter =
      q.status === "all" ? null : q.status === "archived" ? "archived" : "active";
    return sql`
      SELECT c.id, c.title, c.plane_issue_id, c.target_json, c.created_at,
        c.status, c.archived_at,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id) AS job_count,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id
           AND j.status IN ('pending','claimed','provisioning','running','waiting_human')) AS active_count,
        -- Lifecycle rollups are derived from Job execution timestamps. Pending work and
        -- waiting_human are both active work: pending has no started_at yet, while a
        -- human gate keeps the running interval open until the Job reaches a terminal state.
        (SELECT MIN(j.started_at) FROM jobs j WHERE j.canvas_id = c.id) AS started_at,
        (SELECT CASE
           WHEN COUNT(*) FILTER (WHERE j.status IN ('pending','claimed','provisioning','running','waiting_human')) = 0
           THEN MAX(j.finished_at)
           ELSE NULL
         END FROM jobs j WHERE j.canvas_id = c.id) AS ended_at,
        (SELECT n.status FROM canvas_nodes n
         WHERE n.canvas_id = c.id AND n.node_type = 'root'
         ORDER BY n.updated_at DESC LIMIT 1) AS root_status,
        (SELECT n.status FROM canvas_nodes n
         WHERE n.canvas_id = c.id AND n.node_type = 'report'
         ORDER BY n.updated_at DESC LIMIT 1) AS report_status,
        (SELECT COUNT(*)::int FROM canvas_nodes n WHERE n.canvas_id = c.id AND n.node_type = 'finding') AS finding_count,
        (SELECT COUNT(*)::int FROM canvas_nodes n WHERE n.canvas_id = c.id AND n.node_type = 'finding' AND n.status = 'confirmed') AS confirmed_count,
        lj.last_job_id, lj.last_job_status, lj.last_job_priority, lj.last_job_at
      FROM canvases c
      LEFT JOIN LATERAL (
        SELECT j.id AS last_job_id, j.status AS last_job_status,
               j.priority AS last_job_priority, j.created_at AS last_job_at
        FROM jobs j WHERE j.canvas_id = c.id ORDER BY j.created_at DESC LIMIT 1
      ) lj ON true
      WHERE c.project_id = ${id}
        AND (${statusFilter}::text IS NULL OR c.status = ${statusFilter})
      ORDER BY c.created_at DESC`;
  });

  // 详情：单任务画布的节点与边
  app.get("/canvases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Keep the detail response on the same lifecycle semantics as the project list:
    // canvas creation is the origin, the first non-null Job started_at is the first
    // actual start, and ended_at is only fixed after all active work (including
    // pending and waiting_human Jobs) is gone.
    const [canvas] = await sql`
      SELECT c.*,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id) AS job_count,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id
           AND j.status IN ('pending','claimed','provisioning','running','waiting_human')) AS active_count,
        (SELECT MIN(j.started_at) FROM jobs j WHERE j.canvas_id = c.id) AS started_at,
        (SELECT CASE
           WHEN COUNT(*) FILTER (WHERE j.status IN ('pending','claimed','provisioning','running','waiting_human')) = 0
           THEN MAX(j.finished_at)
           ELSE NULL
         END FROM jobs j WHERE j.canvas_id = c.id) AS ended_at,
        (SELECT n.status FROM canvas_nodes n
         WHERE n.canvas_id = c.id AND n.node_type = 'root'
         ORDER BY n.updated_at DESC LIMIT 1) AS root_status,
        (SELECT n.status FROM canvas_nodes n
         WHERE n.canvas_id = c.id AND n.node_type = 'report'
         ORDER BY n.updated_at DESC LIMIT 1) AS report_status
      FROM canvases c WHERE c.id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const [nodes, edges] = await Promise.all([
      sql`
        SELECT id, node_type, title, body_json, x, y, w, h, status, job_id, updated_at
        FROM canvas_nodes WHERE canvas_id = ${id} ORDER BY created_at`,
      sql`
        SELECT id, from_node_id, to_node_id, edge_type
        FROM canvas_edges WHERE canvas_id = ${id} ORDER BY created_at`,
    ]);
    return {
      canvas,
      canvas_id: id,
      nodes,
      edges,
      convergence: parseCanvasConvergence(canvas.target_json),
    };
  });

  /** L0 canvas projection: graph topology and bounded node summaries only. */
  app.get("/canvases/:id/summary", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      // Lock the canvas row before reading the projection.  Writers acquire
      // this same row lock before advancing change_revision, so the returned
      // upper revision and nodes/edges are one consistent snapshot.
      const [canvas] = await tx`
        SELECT c.id, c.title, c.target_json, c.project_id, c.created_at, c.status, c.archived_at,
          c.change_revision, c.change_floor_revision,
          (SELECT n.status FROM canvas_nodes n
           WHERE n.canvas_id = c.id AND n.node_type = 'root'
           ORDER BY n.updated_at DESC LIMIT 1) AS root_status,
          (SELECT n.status FROM canvas_nodes n
           WHERE n.canvas_id = c.id AND n.node_type = 'report'
           ORDER BY n.updated_at DESC LIMIT 1) AS report_status,
          (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id) AS job_count,
          (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id
             AND j.status IN ('pending','claimed','provisioning','running','waiting_human')) AS active_count,
          (SELECT MIN(j.started_at) FROM jobs j WHERE j.canvas_id = c.id) AS started_at,
          (SELECT CASE
             WHEN COUNT(*) FILTER (WHERE j.status IN ('pending','claimed','provisioning','running','waiting_human')) = 0
             THEN MAX(j.finished_at) ELSE NULL END FROM jobs j WHERE j.canvas_id = c.id) AS ended_at
        FROM canvases c WHERE c.id = ${id} FOR SHARE`;
      if (!canvas) return null;
      const [nodes, edges] = await Promise.all([
        tx`
          SELECT id, node_type, title,
            jsonb_build_object(
              'summary', LEFT(COALESCE(body_json->>'summary', body_json->>'description', body_json->>'message', ''), 240),
              'description', LEFT(COALESCE(body_json->>'description', body_json->>'summary', ''), 240),
              'severity', body_json->>'severity',
              'role', body_json->>'role',
              'type', body_json->>'type',
              'last_progress', CASE
                WHEN jsonb_typeof(body_json->'last_progress') = 'object' THEN jsonb_build_object(
                  'message', LEFT(COALESCE(body_json->'last_progress'->>'message', ''), 240),
                  'kind', LEFT(COALESCE(body_json->'last_progress'->>'kind', ''), 64)
                ) ELSE NULL END
            ) || CASE
              WHEN body_json->>'ui_color' ~ '^#[0-9A-Fa-f]{6}$'
              THEN jsonb_build_object('ui_color', lower(body_json->>'ui_color'))
              ELSE '{}'::jsonb
            END AS body_json,
            x, y, w, h, status, body_json->>'verification_status' AS verification_status, job_id, updated_at
          FROM canvas_nodes WHERE canvas_id = ${id} ORDER BY created_at`,
        tx`
          SELECT id, from_node_id, to_node_id, edge_type
          FROM canvas_edges WHERE canvas_id = ${id} ORDER BY created_at`,
      ]);
      return { canvas, nodes, edges };
    });
    if (!result) return reply.code(404).send({ error: "canvas not found", error_code: "CANVAS_NOT_FOUND" });
    const { canvas, nodes, edges } = result;
    return {
      canvas,
      canvas_id: id,
      nodes,
      edges,
      convergence: parseCanvasConvergence(canvas.target_json),
      projection: "L0",
      revision: String(canvas.change_revision ?? 0),
      floor_revision: String(canvas.change_floor_revision ?? 0),
      watermark: String(canvas.change_revision ?? 0),
      live: Number(canvas.active_count ?? 0) > 0,
    };
  });

  /** L1 on-demand hydration for one node; large body_json never enters L0. */
  app.get("/canvases/:id/nodes/:nodeId", async (req, reply) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    const [node] = await sql`
      SELECT id, canvas_id, node_type, title, body_json, x, y, w, h, status,
             body_json->>'verification_status' AS verification_status, job_id, updated_at
      FROM canvas_nodes WHERE id = ${nodeId} AND canvas_id = ${id}`;
    if (!node) return reply.code(404).send({ error: "canvas node not found", error_code: "NODE_NOT_FOUND" });
    return { node, projection: "L1" };
  });

  /** Durable revision-bounded L0 delta.  The upper revision is frozen while
   * the transaction reads the log, so concurrent writers are returned by the
   * next request rather than racing this response. */
  app.get("/canvases/:id/delta", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rawSince = String((req.query as { since?: string }).since ?? "");
    let since: bigint;
    try {
      since = parseCanvasRevision(rawSince);
    } catch {
      return reply.code(400).send(cursorGap("invalid canvas revision cursor", "INVALID_CURSOR"));
    }

    try {
      const result = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        const [canvas] = await tx`
          SELECT id, change_revision, change_floor_revision,
            (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = canvases.id) AS job_count,
            (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = canvases.id
               AND j.status IN ('pending','claimed','provisioning','running','waiting_human')) AS active_count,
            (SELECT MIN(j.started_at) FROM jobs j WHERE j.canvas_id = canvases.id) AS started_at,
            (SELECT CASE
               WHEN COUNT(*) FILTER (WHERE j.status IN ('pending','claimed','provisioning','running','waiting_human')) = 0
               THEN MAX(j.finished_at) ELSE NULL END FROM jobs j WHERE j.canvas_id = canvases.id) AS ended_at,
            (SELECT n.status FROM canvas_nodes n
             WHERE n.canvas_id = canvases.id AND n.node_type = 'root'
             ORDER BY n.updated_at DESC LIMIT 1) AS root_status,
            (SELECT n.status FROM canvas_nodes n
             WHERE n.canvas_id = canvases.id AND n.node_type = 'report'
             ORDER BY n.updated_at DESC LIMIT 1) AS report_status,
            EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.canvas_id = canvases.id
                AND j.status IN ('pending','claimed','provisioning','running','waiting_human')
            ) AS live
          FROM canvases WHERE id = ${id} FOR SHARE`;
        if (!canvas) return null;
        const upper = BigInt(String(canvas.change_revision ?? 0));
        const floor = BigInt(String(canvas.change_floor_revision ?? 0));
        if (since > upper) {
          return { kind: "future" as const, upper, floor, live: Boolean(canvas.live) };
        }
        if (since < floor) {
          return { kind: "gap" as const, upper, floor, live: Boolean(canvas.live) };
        }
        const rows = await tx`
          SELECT revision, entity_type, entity_id, op, projection_json
          FROM canvas_changes
          WHERE canvas_id = ${id}
            AND revision > ${since.toString()}::bigint
            AND revision <= ${upper.toString()}::bigint
          ORDER BY revision ASC`;
        return {
          kind: "ok" as const,
          upper,
          floor,
          live: Boolean(canvas.live),
          active_count: Number(canvas.active_count ?? 0),
          job_count: Number(canvas.job_count ?? 0),
          started_at: canvas.started_at,
          ended_at: canvas.ended_at,
          root_status: canvas.root_status,
          report_status: canvas.report_status,
          delta: buildCanvasDelta(id, since, upper, floor, rows as never),
        };
      });
      if (!result) return reply.code(404).send({ error: "canvas not found", error_code: "CANVAS_NOT_FOUND" });
      if (result.kind === "future") {
        return reply.code(400).send(cursorGap("canvas revision is ahead of the server", "CURSOR_GAP"));
      }
      if (result.kind === "gap") {
        return reply.code(409).send({
          ...cursorGap("canvas revision is no longer retained; reload L0", "CURSOR_GAP"),
          current_revision: result.upper.toString(),
          floor_revision: result.floor.toString(),
        });
      }
      return {
        ...result.delta,
        projection: "L0_DELTA",
        live: result.live,
        active_count: result.active_count,
        job_count: result.job_count,
        started_at: result.started_at,
        ended_at: result.ended_at,
        root_status: result.root_status,
        report_status: result.report_status,
      };
    } catch (error) {
      req.log.error(error, "canvas delta failed");
      return reply.code(500).send({ error: "canvas delta failed", error_code: "CANVAS_DELTA_FAILED" });
    }
  });

  // ---------- 画布收敛控制（暂停/恢复决策、门控停、清理低优先级 verify） ----------
  app.get("/canvases/:id/convergence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id, target_json FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const rules = await rulesForProject(sql, canvas.project_id as string);
    const care = resolveHubWaitSeverities(rules);
    return {
      canvas_id: id,
      convergence: parseCanvasConvergence(canvas.target_json),
      minVerifySeverity: rules.minVerifySeverity,
      maxVerificationRounds: rules.maxVerificationRounds,
      careSeverities: care,
      // 兼容旧前端字段名（severity 仅优先级/等待门，不再决定是否验证）
      hubWaitSeverities: care,
      autoVerifySeverities: care,
    };
  });

  app.post("/canvases/:id/convergence/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const convergence = await patchCanvasConvergence(sql, id, {
      hub_paused: true,
      paused_reason: body.reason ?? "manual_pause",
      paused_at: new Date().toISOString(),
    });
    await audit(req, {
      action: "canvas.convergence_pause",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
      after: convergence,
    });
    return { canvas_id: id, convergence };
  });

  app.post("/canvases/:id/convergence/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ force_hub: z.boolean().optional() }).parse(req.body ?? {});
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const convergence = await patchCanvasConvergence(sql, id, {
      hub_paused: false,
      auto_stopped: false,
      paused_reason: undefined,
      paused_at: undefined,
    });
    let hubTriggered = false;
    if (body.force_hub) {
      await sql.begin(async (tx) => {
        await maybeTriggerHub(
          tx as unknown as typeof sql,
          {
            id: null,
            project_id: canvas.project_id,
            canvas_id: id,
            type: "manual",
            priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
          },
          { manual: true, force: true, trigger: { kind: "manual_resume" } },
        );
      });
      hubTriggered = true;
    }
    await audit(req, {
      action: "canvas.convergence_resume",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
      after: { ...convergence, force_hub: body.force_hub ?? false },
    });
    return { canvas_id: id, convergence, hub_triggered: hubTriggered };
  });

  app.post("/canvases/:id/convergence/stop-after-gate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    // 画布级：打开 pause 标记说明「门控后由 autoStop 接管」；同时写 reason
    const convergence = await patchCanvasConvergence(sql, id, {
      hub_paused: false,
      auto_stopped: false,
      paused_reason: "stop_after_gate",
      paused_at: new Date().toISOString(),
    });
    // 快捷：把项目关注级别定为 high（critical+high），其余语义写死
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${canvas.project_id as string}`;
    const cfg = { ...((p?.config_json ?? {}) as Record<string, unknown>) };
    const rules = { ...((cfg.rules as Record<string, unknown>) ?? {}) };
    rules.minVerifySeverity = "high";
    cfg.rules = rules;
    await sql`UPDATE projects SET config_json = ${sql.json(cfg as never)} WHERE id = ${canvas.project_id as string}`;
    await audit(req, {
      action: "canvas.convergence_stop_after_gate",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
      after: { convergence, rules: { minVerifySeverity: "high" } },
    });
    return { canvas_id: id, convergence, project_rules: rules };
  });

  app.post("/canvases/:id/convergence/drain-priority", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const rules = await rulesForProject(sql, canvas.project_id as string);
    const wait = resolveHubWaitSeverities(rules);
    const result = await drainNonGateVerifies(sql, id, wait);
    await audit(req, {
      action: "canvas.convergence_drain_priority",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
      after: { ...result, hubWaitSeverities: wait },
    });
    return { canvas_id: id, hubWaitSeverities: wait, ...result };
  });

  app.post("/canvases/:id/convergence/run-hub-now", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    await sql.begin(async (tx) => {
      await maybeTriggerHub(
        tx as unknown as typeof sql,
        {
          id: null,
          project_id: canvas.project_id,
          canvas_id: id,
          type: "manual",
          priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
        },
        { manual: true, force: true, trigger: { kind: "manual_run_hub_now" } },
      );
    });
    await audit(req, {
      action: "canvas.convergence_run_hub_now",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
    });
    const convergence = await readCanvasConvergence(sql, id);
    return { canvas_id: id, ok: true, convergence };
  });

  // ---------- 画布（§7 GET /projects/{id}/canvas；§6.4 列表不含大字段） ----------
  // @deprecated 旧的项目级画布，仅为兼容历史数据保留；新代码用 /canvases/:id
  app.get("/projects/:id/canvas", async (req) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`SELECT * FROM projects WHERE id = ${id}`;
    if (!project) return { error: "project not found" };
    const [nodes, edges] = await Promise.all([
      sql`
        SELECT id, node_type, title, body_json, x, y, w, h, status, job_id, updated_at
        FROM canvas_nodes WHERE canvas_id = ${project.canvas_id} ORDER BY created_at`,
      sql`
        SELECT id, from_node_id, to_node_id, edge_type
        FROM canvas_edges WHERE canvas_id = ${project.canvas_id} ORDER BY created_at`,
    ]);
    return { canvas_id: project.canvas_id, nodes, edges };
  });

  // ---------- Jobs ----------
  app.post("/jobs", async (req, reply) => {
    const body = CreateJobBody.parse(req.body);
    // `verify` remains a compatibility alias used by the runtime-image smoke
    // to inspect the governed Verify snapshot. It is still scheduler-owned
    // for priority/purpose, but unlike `verify_finding` it has no Finding
    // lifecycle and cannot confirm anything on its own.
    const systemJobTypes = new Set(["hub_reason", "hub", "verify_finding", "report"]);
    if (systemJobTypes.has(body.type.trim().toLowerCase())) {
      return reply.code(409).send({ error: "scheduler-owned system Job types cannot be created through the public endpoint" });
    }
    // Scheduling lanes are scheduler-owned.  A public caller may include
    // arbitrary payload metadata, but cannot smuggle convergence_evidence (or
    // another system lane) into a custom role's fixed priority class.
    const payload = { ...body.payload };
    delete payload.scheduling_purpose;
    delete payload.scheduler_owned;
    if (payload.verification_followup && typeof payload.verification_followup === "object" && !Array.isArray(payload.verification_followup)) {
      const followup = { ...(payload.verification_followup as Record<string, unknown>) };
      delete followup.scheduler_owned;
      payload.verification_followup = followup;
    }
    const expectedPriority = fixedPriorityForJob({
      type: body.type,
      payload,
      severity:
        payload.severity ?? (payload.finding as Record<string, unknown> | undefined)?.severity,
    });
    if (body.priority !== undefined && body.priority !== expectedPriority) {
      return reply.code(409).send({
        error: "priority is fixed by scheduling class",
        expected_priority: expectedPriority,
      });
    }
    // 一任务一画布：有 issue 复用（重试），无 issue 每次新建 ad-hoc 画布
    const canvasId = await ensureCanvasForTask({
      projectId: body.project_id,
      planeIssueId: body.plane_issue_id,
      title: body.title ?? `${body.type} 任务`,
      target: { type: body.type, ...payload },
    });
    const { job, duplicated } = await createJob({
      projectId: body.project_id,
      canvasId,
      planeIssueId: body.plane_issue_id,
      type: body.type,
      payload,
      priority: body.priority,
      timeoutSec: body.timeout_sec,
    });
    if (duplicated) return reply.code(409).send({ error: "同一 issue 已有活动 job" });
    return reply.code(201).send(job);
  });

  app.get("/jobs", async (req, reply) => {
    const q = req.query as { project_id?: string; status?: string; canvas_id?: string; cursor?: string; after?: string; limit?: string };
    // 联表项目名 / 画布标题；从冻结快照抽出 CLI / 模型 / 角色，列表实时展示
    // agent_snapshot_json 在 createJob 时冻结，列表侧不二次解析 RoleConfig
    const projectId = q.project_id?.trim() || req.actor?.projectId || null;
    const status = q.status?.trim() || null;
    const canvasId = q.canvas_id?.trim() || null;
    const after = q.cursor ?? q.after ?? null;
    const paginated = Boolean(canvasId || after || q.limit || q.cursor);
    const cursor = after ? decodeCursor(after, "jobs") : null;
    if (after && (!cursor?.created_at || !cursor.id)) {
      return reply.code(400).send({ error: "invalid jobs cursor", error_code: "INVALID_CURSOR" });
    }
    const limit = paginated ? pageLimit(q.limit) : 200;
    const rows = await sql`
      SELECT j.id, j.project_id, j.canvas_id, j.plane_issue_id, j.type, j.status, j.priority, j.error,
             j.started_at, j.finished_at, j.created_at,
             p.name AS project_name, c.title AS canvas_title,
             j.agent_snapshot_json->>'agent_cli' AS agent_cli,
             j.agent_snapshot_json->>'model' AS model,
             j.agent_snapshot_json->>'name' AS role_name,
             j.agent_snapshot_json->>'credential_provider' AS credential_provider,
             NULLIF(j.agent_snapshot_json->>'role_config_version', '')::int AS role_config_version
      FROM jobs j
      JOIN projects p ON p.id = j.project_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      WHERE (${projectId}::uuid IS NULL OR j.project_id = ${projectId}::uuid)
        AND (${status}::text IS NULL OR j.status = ${status})
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId})
        AND (${cursor?.created_at ?? null}::timestamptz IS NULL
          OR j.created_at < ${cursor?.created_at ?? null}::timestamptz
          OR (j.created_at = ${cursor?.created_at ?? null}::timestamptz AND j.id < ${cursor?.id ?? null}::uuid))
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT ${paginated ? limit + 1 : limit}`;
    const items = rows.slice(0, limit).map((row) => projectJobProviderFields(row as Record<string, unknown>));
    if (!paginated) return items;
    const last = items.at(-1) as { id: string; created_at: string | Date } | undefined;
    const hasMore = rows.length > limit;
    return page(items, {
      after,
      nextCursor: hasMore && last ? cursorForRow("jobs", last) : null,
      hasMore,
      live: false,
    });
  });

  const DISPOSITIONS = ["open", "accepted", "confirmed_vuln", "rejected_fp", "resolved", "archived"] as const;

  app.patch("/findings/:id/disposition", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        disposition: z.enum(DISPOSITIONS),
        note: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const [cur] = await sql`SELECT id, disposition, verify_status, project_id FROM findings WHERE id = ${id}`;
    if (!cur) return reply.code(404).send({ error: "finding not found" });
    // 技术 confirmed 唯一入口是系统 Verify；人工 disposition 不得旁路
    if (body.disposition === "confirmed_vuln" && cur.verify_status !== "confirmed") {
      return reply.code(409).send({
        error: "confirmed_vuln_requires_verify",
        message: "仅当系统 Verify 已将 verify_status 置为 confirmed 后，才允许 disposition=confirmed_vuln",
        verify_status: cur.verify_status,
      });
    }
    const actorName = req.actor?.name ?? "unknown";
    const [row] = await sql`
      UPDATE findings SET
        disposition = ${body.disposition},
        disposition_note = ${body.note ?? null},
        disposition_by = ${actorName},
        disposition_at = now(),
        updated_at = now()
      WHERE id = ${id}
      RETURNING *`;
    // rejected_fp 仅人工业务处置；不伪造技术 confirmed，也不把未收敛 round 绕过
    // 不再把 verify_status 写成 false_positive（新流程否定结论走 rework→pending）
    await audit(req, {
      action: "finding.disposition",
      resourceType: "finding",
      resourceId: id,
      projectId: row.project_id as string,
      before: { disposition: cur.disposition, verify_status: cur.verify_status },
      after: { disposition: body.disposition, note: body.note ?? null, verify_status: row.verify_status },
    });
    return row;
  });

  app.post("/findings/:id/comments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        body: z.string().trim().min(1).max(8000),
        /** 默认 true：对 confirmed Finding 评论后唤醒 Hub 再决策 */
        request_hub: z.boolean().optional().default(true),
      })
      .parse(req.body);
    const [f] = await sql`
      SELECT id, project_id, verify_status, disposition FROM findings WHERE id = ${id}`;
    if (!f) return reply.code(404).send({ error: "finding not found" });
    const authorName = req.actor?.name ?? "unknown";
    const [row] = await sql`
      INSERT INTO finding_comments ${sql({
        finding_id: id,
        body: body.body,
        author_type: req.actor?.type ?? "user",
        author_id: req.actor?.id ?? null,
        author_name: authorName,
      })}
      RETURNING *`;
    await sql`UPDATE findings SET updated_at = now() WHERE id = ${id}`;

    let hub: { hub_queued: boolean; reason?: string; canvas_id?: string; hub_job_id?: string } | null =
      null;
    const isConfirmed =
      f.verify_status === "confirmed" || f.disposition === "confirmed_vuln";
    if (body.request_hub !== false && isConfirmed) {
      hub = await triggerHubFromHumanComment({
        findingId: id,
        commentId: row.id as string,
        commentBody: body.body,
        authorName,
      });
    }

    await audit(req, {
      action: "finding.comment",
      resourceType: "finding",
      resourceId: id,
      projectId: f.project_id as string,
      after: {
        comment_id: row.id,
        verified: f.verify_status,
        hub_queued: hub?.hub_queued ?? false,
        hub_reason: hub?.reason ?? null,
        hub_job_id: hub?.hub_job_id ?? null,
      },
    });
    return reply.code(201).send({
      ...row,
      hub: hub ?? {
        hub_queued: false,
        reason: isConfirmed ? "request_hub_false" : "not_confirmed",
      },
    });
  });

  app.delete("/findings/:id/comments/:commentId", async (req, reply) => {
    const { id, commentId } = req.params as { id: string; commentId: string };
    const [row] = await sql`
      DELETE FROM finding_comments
      WHERE id = ${commentId} AND finding_id = ${id}
      RETURNING id, finding_id`;
    if (!row) return reply.code(404).send({ error: "comment not found" });
    await audit(req, {
      action: "finding.comment_delete",
      resourceType: "finding_comment",
      resourceId: commentId,
    });
    return { ok: true };
  });

  app.post("/findings/:id/links", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        url: z.string().trim().url().max(2000),
        title: z.string().trim().max(200).optional(),
        link_type: z.enum(["related", "ticket", "pr", "doc", "evidence"]).default("related"),
      })
      .parse(req.body);
    const [f] = await sql`SELECT id, project_id FROM findings WHERE id = ${id}`;
    if (!f) return reply.code(404).send({ error: "finding not found" });
    const [row] = await sql`
      INSERT INTO finding_links ${sql({
        finding_id: id,
        url: body.url,
        title: body.title ?? "",
        link_type: body.link_type,
        created_by: req.actor?.name ?? null,
      })}
      RETURNING *`;
    await sql`UPDATE findings SET updated_at = now() WHERE id = ${id}`;
    await audit(req, {
      action: "finding.link",
      resourceType: "finding",
      resourceId: id,
      projectId: f.project_id as string,
      after: { link_id: row.id, url: body.url },
    });
    return reply.code(201).send(row);
  });

  app.delete("/findings/:id/links/:linkId", async (req, reply) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    const [row] = await sql`
      DELETE FROM finding_links WHERE id = ${linkId} AND finding_id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: "link not found" });
    await audit(req, {
      action: "finding.link_delete",
      resourceType: "finding_link",
      resourceId: linkId,
    });
    return { ok: true };
  });

  app.get("/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "not found" });
    const [events, findings] = await Promise.all([
      sql`SELECT id, job_seq, type, payload_json, created_at FROM events WHERE job_id = ${id} ORDER BY id LIMIT 50`,
      sql`SELECT id, fingerprint, title, severity, location, verify_status FROM findings WHERE job_id = ${id}`,
    ]);
    const snapshot = job.agent_snapshot_json;
    const missingModules =
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && Array.isArray((snapshot as Record<string, unknown>).missing_modules)
        ? (snapshot as Record<string, unknown>).missing_modules
        : [];
    const safeJob = {
      ...job,
      error: projectCredentialProviderError(job.error),
      payload_json: projectJobPayload(job.payload_json),
      agent_snapshot_json: projectJobSnapshot(snapshot),
    };
    return {
      job: safeJob,
      events: events.map((event) => ({
        ...event,
        payload_json: projectJobEventPayload(event.payload_json),
      })),
      findings,
      missing_modules: missingModules,
    };
  });

  /** Keyset event pages keep the heavy timeline out of the Job detail request. */
  app.get("/jobs/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { cursor?: string; after?: string; limit?: string };
    const [job] = await sql`SELECT id FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "job not found", error_code: "JOB_NOT_FOUND" });
    const after = q.cursor ?? q.after ?? null;
    const cursor = after ? decodeCursor(after, "events") : null;
    if (after && (!cursor?.created_at || !cursor.id)) {
      return reply.code(400).send({ error: "invalid events cursor", error_code: "INVALID_CURSOR" });
    }
    const limit = pageLimit(q.limit);
    const rows = await sql`
      SELECT id, job_seq, type, payload_json, created_at
      FROM events WHERE job_id = ${id}
        AND (${cursor?.created_at ?? null}::timestamptz IS NULL
          OR created_at > ${cursor?.created_at ?? null}::timestamptz
          OR (created_at = ${cursor?.created_at ?? null}::timestamptz AND id > ${cursor?.id ?? null}::bigint))
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit).map((event) => ({
      ...event,
      payload_json: projectJobEventPayload(event.payload_json),
    }));
    const last = items.at(-1) as { id: string; created_at: string | Date } | undefined;
    return page(items, {
      after,
      nextCursor: rows.length > limit && last ? cursorForRow("events", last) : null,
      hasMore: rows.length > limit,
      live: false,
    });
  });

  app.get("/jobs/:id/evidence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await sql`SELECT id, transcript_uri FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "job not found" });
    const manifest = await readEvidenceManifest(id);
    if (!manifest) return reply.code(404).send({ error: "该 Job 没有持久化运行证据" });
    return { transcript_uri: job.transcript_uri, manifest };
  });

  app.get("/jobs/:id/evidence/session", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await readMainSession(id);
    if (!session) return reply.code(404).send({ error: "该 Job 没有原始 Session" });
    const max = 2 * 1024 * 1024;
    return {
      meta: session.meta,
      text: session.content.subarray(0, max).toString("utf8"),
      truncated: session.content.byteLength > max,
    };
  });

  app.get("/jobs/:id/evidence/session/download", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await readMainSession(id);
    if (!session) return reply.code(404).send({ error: "该 Job 没有原始 Session" });
    const safeName = session.meta.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("content-disposition", `attachment; filename=\"${safeName}\"`)
      .send(session.content);
  });

  app.get("/jobs/:id/evidence/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { cursor?: string; after?: string; limit?: string; tail?: string };
    const [job] = await sql`SELECT id, status FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "job not found" });
    const after = q.cursor ?? q.after ?? null;
    let result;
    try {
      result = await readNormalizedStreamPage(id, {
        after,
        limit: pageLimit(q.limit),
        tail: q.tail === "1" || q.tail === "true",
        live: STREAMABLE_JOB_STATUSES.has(String(job.status)),
      });
    } catch (error) {
      if (error instanceof CursorError) {
        return reply.code(cursorErrorHttpStatus(error.code)).send({
          error: error.code,
          error_code: error.code,
          gap: error.code === "CURSOR_GAP",
        });
      }
      throw error;
    }
    // `events` is retained as a compatibility alias while `items` is the
    // canonical HTTP/WS envelope field.
    return { ...result, events: result.items };
  });

  // 只有 pending 可调整优先级（运行中/终态改优先级无意义）
  app.patch("/jobs/:id/priority", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PriorityBody.parse(req.body);
    const [current] = await sql`
      SELECT id, type, status, priority, finding_id, payload_json
      FROM jobs WHERE id = ${id}`;
    if (!current) return reply.code(404).send({ error: "job not found" });
    let severity: string | undefined;
    if (current.finding_id) {
      const [finding] = await sql`SELECT severity FROM findings WHERE id = ${current.finding_id as string}`;
      severity = finding?.severity as string | undefined;
    }
    const expected = fixedPriorityForJob({
      type: current.type as string,
      severity,
      payload: (current.payload_json ?? {}) as Record<string, unknown>,
    });
    if (!priorityMatchesJob({
      type: current.type as string,
      severity,
      payload: (current.payload_json ?? {}) as Record<string, unknown>,
    }, body.priority)) {
      return reply.code(409).send({
        error: "priority is fixed by scheduling class; use an in-class value",
        expected_priority: expected,
      });
    }
    const [job] = await sql`
      UPDATE jobs SET priority = ${body.priority}
      WHERE id = ${id} AND status = 'pending'
      RETURNING id, status, priority`;
    if (!job) return reply.code(409).send({ error: "只有 pending 状态的 job 可调整优先级" });
    await audit(req, { action: "job.priority", resourceType: "job", resourceId: id, after: { priority: body.priority } });
    return job;
  });

  // 取消 / 强制退出（§8.3）：置 cancel 终态 + 立即停容器 + 画布节点同步；后续语义事件在摄入门禁以 job_not_running 拒绝
  app.post("/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        /** 强制退出时写入 error 字段，便于 UI/审计区分 */
        force: z.boolean().optional(),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body ?? {});
    const reason =
      body.reason?.trim() ||
      (body.force ? "强制退出" : "cancelled");
    const job = await createSqlJobLifecycleApplication().cancelJob(id, reason);
    if (!job) return reply.code(409).send({ error: "job 不在可取消状态" });
    if (job.sandbox_id) {
      await runner.destroy({ sandboxId: job.sandbox_id as string }).catch((e) => {
        console.error(`[cancel] 沙箱回收失败 ${job.sandbox_id}:`, e);
      });
    }
    // §6.3：取消即吊销短期模型 Token
    await revokeJobTokens(id, "cancelled").catch(() => {});
    await sql`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent", "report"]})`;
    await recoverCancelledDerivedJob(job, reason).catch((e) =>
      console.error(`[cancel] derived job recovery failed:`, e),
    );
    await planeWriteback(id).catch(() => {});
    await audit(req, {
      action: body.force ? "job.force_cancel" : "job.cancel",
      resourceType: "job",
      resourceId: id,
      projectId: (job.project_id as string) ?? null,
      after: { status: "cancelled", force: body.force ?? false, reason },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'job_cancelled')`;
    return { id: job.id, status: job.status, force: body.force ?? false, reason };
  });

  /** 强制退出画布上全部活动 Job（pending/claimed/provisioning/running/waiting_human） */
  app.post("/canvases/:id/jobs/cancel-active", async (req, reply) => {
    const { id: canvasId } = req.params as { id: string };
    const body = z
      .object({ reason: z.string().max(500).optional() })
      .parse(req.body ?? {});
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const reason = body.reason?.trim() || "强制退出全部活动 Job";
    const active = await createSqlJobLifecycleApplication().cancelJobsOnCanvas(canvasId, reason);
    let cancelled = 0;
    for (const job of active) {
      const jobId = job.id as string;
      cancelled += 1;
      if (job.sandbox_id) {
        await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
      }
      await revokeJobTokens(jobId, "cancelled").catch(() => {});
      await sql`
        UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
        WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;
      await recoverCancelledDerivedJob(job, reason).catch(() => {});
      await planeWriteback(jobId).catch(() => {});
    }
    await audit(req, {
      action: "canvas.force_cancel_active",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: canvas.project_id as string,
      after: { cancelled, reason },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'canvas_force_cancel')`;
    return { canvas_id: canvasId, cancelled, reason };
  });

  // 人工处理后恢复（§4.4/§8.3）：waiting_human/orphan/failed/timeout → pending 重入队
  // 走原子状态机；清空上一轮执行痕迹；画布节点回到 pending 等再运行
  app.post("/jobs/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await createSqlJobLifecycleApplication().transitionJob(id, "pending", {
      error: null,
      lease_expires_at: null,
      claimed_at: null,
      started_at: null,
      finished_at: null,
      heartbeat_at: null,
    });
    if (row) await normalizePendingJobPriority(id);
    if (!row) return reply.code(409).send({ error: "job 不在可恢复状态（succeeded/cancelled 不可恢复，重跑请用 retry）" });
    await sql`
      UPDATE canvas_nodes SET status = 'pending', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent"]})`;
    await audit(req, {
      action: "job.resume",
      resourceType: "job",
      resourceId: id,
      projectId: (row.project_id as string) ?? null,
    });
    return row;
  });

  // ---------- Plane webhook（§7；HMAC-SHA256 校验） ----------
  app.post("/webhooks/plane", async (req, reply) => {
    if (config.plane.webhookSecret) {
      const sig = (req.headers["x-plane-signature"] ?? "") as string;
      const expected = createHmac("sha256", config.plane.webhookSecret)
        .update(JSON.stringify(req.body))
        .digest("hex");
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(401).send({ error: "bad signature" });
      }
    }
    // issue.updated → 立即触发一次领取（不等待轮询周期）
    const body = req.body as { event?: string; action?: string };
    if (body.event === "issue") {
      void planePollOnce().catch((e) => console.error("[webhook] poll 失败:", e));
    }
    return { ok: true };
  });

  registerApiTokenRoutes(app);

  registerCredentialRoutes(app);

  registerAuditRoutes(app);
  registerTransferRoutes(app);
  registerSystemRoutes(app);
}
