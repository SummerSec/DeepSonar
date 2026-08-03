import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { PlatformToolName, allowedPlatformTools, requiredPlatformTools } from "@deepsonar/shared-types";
import { z } from "zod";
import { audit } from "./audit.js";
import { ALL_SCOPES, authHook, generateToken } from "./auth.js";
import {
  countUsers,
  createUser,
  listUsers,
  loginUser,
  revokeSession,
  setUserPassword,
  toPublicUser,
  updateUser,
  type UserRole,
} from "./users.js";
import { renderMetrics } from "./metrics.js";
import { config } from "./config.js";
import {
  allowedModelIds,
  credentialConcurrencyPolicy,
  encryptSecret,
  fingerprintOf,
  isProviderKnown,
  last4Of,
  type Encrypted,
} from "./credentials.js";
import { listCredentialModels, testCredential } from "./credential-test.js";
import {
  CONFIG_FILE_MAX_BYTES,
  CONFIG_FILE_MAX_COUNT,
  CONFIG_FILE_MAX_TOTAL,
  PLATFORM_DEFAULT_AGENT_CLI,
  createJob,
  drainNonGateVerifies,
  ensureCanvasForTask,
  globalRules,
  maybeTriggerHub,
  parseCanvasConvergence,
  patchCanvasConvergence,
  readCanvasConvergence,
  resolveAgentSnapshotForJob,
  resolveHubWaitSeverities,
  rolesForProject,
  rulesForProject,
  scanConfigContent,
  triggerHubFromHumanComment,
  transitionJob,
  validateConfigFilePath,
  validateEnvVars,
} from "./core.js";
import { sql } from "./db.js";
import { readEvidenceManifest, readMainSession, readNormalizedStream } from "./evidence.js";
import { planePollOnce, planePollProject, planeWriteback } from "./plane-sync.js";
import { registerGateway } from "./gateway.js";
import { buildOpenApiDocument, buildSchemaSummary, loadApiMarkdown } from "./openapi.js";
import { runner } from "./runtime.js";
import { syncSkillSource, validateSourceUrl } from "./skill-sources.js";
import { streamBuffer, subscribeStream } from "./stream-bus.js";
import { resolveModules } from "./transfer/modules.js";
import { buildPreview, applyImport } from "./transfer/import.js";
import { saveImportUpload, loadPackFile, removeFileSafe, sha256Hex, openDeepsonarPack } from "./transfer/pack.js";
import {
  applyPlatformImport,
  buildPlatformPreview,
  PLATFORM_FORMAT,
  resolvePlatformModules,
} from "./transfer/platform.js";
import { processExportRow } from "./transfer/worker.js";
import {
  immutableDigest,
  inspectLocalRuntimeImage,
  localImageDigest,
  runtimeImagePullStatus,
  runtimeImageRegistryWithOverrides,
  startRuntimeImagePull,
  syncOfficialRuntimeCatalog,
} from "./runtime-images.js";

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
  priority: z.number().int().default(0),
  timeout_sec: z.number().int().positive().optional(),
});

const ReasoningEffort = z.enum(["low", "medium", "high", "xhigh"]);

// Git 模块源（§8.2）
const SkillSourceBody = z.object({
  name: z.string().min(1),
  repo_url: z.string().min(1),
  branch: z.string().default("main"),
});

const RULE_CONCURRENCY_KEYS = new Set(["maxGlobalJobs", "maxJobsPerProject"]);
const CLI_CONCURRENCY_KEYS = new Set(["claude-code", "codex", "open-code"]);

/**
 * Validate scheduler concurrency knobs at the API boundary. Other rule keys
 * remain open-ended for backwards compatibility, while these limits must be
 * finite integers in the same range used by globalRules().
 */
const RulesPatch = z.record(z.string(), z.unknown()).superRefine((rules, ctx) => {
  for (const key of RULE_CONCURRENCY_KEYS) {
    if (!(key in rules)) continue;
    const n = Number(rules[key]);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} 必须是 1-1000 的整数` });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(rules, "maxConcurrentByAgentCli")) return;
  const cliRules = rules.maxConcurrentByAgentCli;
  if (!cliRules || typeof cliRules !== "object" || Array.isArray(cliRules)) {
    ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli"], message: "Agent CLI 并发必须是对象" });
    return;
  }
  for (const [cli, value] of Object.entries(cliRules as Record<string, unknown>)) {
    if (!CLI_CONCURRENCY_KEYS.has(cli)) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli", cli], message: `${cli} 必须是 0-1000 的整数` });
    }
  }
});

// roles.enabled：hub 可下发角色清单（name 数组；null = 恢复默认=全部内置）
const SettingsPatchBody = z.object({
  rules: RulesPatch.optional(),
  roles: z.object({ enabled: z.array(z.string()).nullable() }).optional(),
});
const GlobalSettingsPatchBody = z.object({ rules: RulesPatch });

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

const RuntimeImageImportBody = z.object({
  image_key: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(""),
  publisher: z.string().trim().min(1).max(120),
  source_url: z.string().url().optional(),
  image_ref: z.string().trim().min(3).max(500),
  version: z.string().trim().min(1).max(100).optional(),
  registry_credential_id: z.string().uuid().optional(),
});
const RuntimeImageStatusBody = z.object({
  status: z.enum(["trusted", "rejected", "disabled", "revoked"]),
  reason: z.string().trim().min(1).max(2_000).optional(),
});
/** 官方 catalog 条目登记不可变 digest 为 trusted（等价启动时 bootstrapOfficialRuntimeImages） */
const OfficialRuntimeImageDigestBody = z.object({
  image_ref: z.string().trim().min(3).max(500),
  version: z.string().trim().min(1).max(100).optional(),
  source: z.enum(["registry", "local-build"]).default("registry"),
});
const LocalRuntimeImageInspectBody = z.object({
  image_ref: z.string().trim().min(1).max(500),
});
const LocalRuntimeImageAdoptBody = LocalRuntimeImageInspectBody.extend({
  expected_image_id: z.string().trim().regex(/^sha256:[0-9a-f]{64}$/i),
  version: z.string().trim().min(1).max(100).optional(),
});

class RevokedRuntimeImageVersionError extends Error {
  constructor(public readonly versionId: string) {
    super("runtime image version is revoked and cannot be adopted");
    this.name = "RevokedRuntimeImageVersionError";
  }
}

const ManualRuntimeImageDigestBody = RuntimeImageImportBody.omit({ registry_credential_id: true }).extend({
  image_ref: z.string().trim().min(3).max(500),
});
const ProjectRuntimeImageBody = z.object({
  enabled: z.boolean().default(true),
  version_id: z.string().uuid().nullish(),
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

/** 取消画布上全部活动 job（归档/删除前兜底）。 */
async function cancelActiveJobsOnCanvas(canvasId: string): Promise<number> {
  const active = await sql`
    SELECT id, sandbox_id, type FROM jobs
    WHERE canvas_id = ${canvasId}
      AND status IN ('pending','claimed','provisioning','running','waiting_human')`;
  if (active.length === 0) return 0;
  const { revokeJobTokens } = await import("./gateway.js");
  const { recoverVerifyJobTerminal } = await import("./core.js");
  for (const job of active) {
    const id = job.id as string;
    await sql`
      UPDATE jobs SET status = 'cancelled', finished_at = now(),
        error = COALESCE(error, 'task archived/deleted')
      WHERE id = ${id}
        AND status IN ('pending','claimed','provisioning','running','waiting_human')`;
    if (job.sandbox_id) {
      await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
    }
    await revokeJobTokens(id, "cancelled").catch(() => {});
    await sql`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent", "report"]})`;
    if (job.type === "verify_finding") {
      await recoverVerifyJobTerminal(id, "cancelled", "task archived/deleted").catch(() => {});
    }
  }
  return active.length;
}

export function registerRoutes(app: FastifyInstance) {
  // 平台 API Token 鉴权（SEC-01）：DEEPSONAR_AUTH_REQUIRED=true 时生效；/health 与 /webhooks/plane 豁免
  app.addHook("onRequest", authHook);

  // Model Gateway（§6.3）：自身用 DEEPSONAR_JOB_TOKEN 鉴权（authHook 豁免 /gateway/*）
  registerGateway(app);

  // ---------- 用户认证（人机登录；与 api_tokens 服务账号分离） ----------
  app.get("/auth/status", async () => {
    const n = await countUsers();
    return {
      auth_required: config.auth.required,
      has_users: n > 0,
      bootstrap_available: n === 0,
      session_ttl_days: 7,
    };
  });

  app.post("/auth/bootstrap", async (req, reply) => {
    const n = await countUsers();
    if (n > 0) return reply.code(409).send({ error: "已有用户，无法 bootstrap", error_code: "ALREADY_BOOTSTRAPPED" });
    const body = z
      .object({
        username: z.string().min(2).max(64),
        password: z.string().min(8).max(200),
        display_name: z.string().max(100).optional(),
      })
      .parse(req.body);
    try {
      const user = await createUser({
        username: body.username,
        password: body.password,
        display_name: body.display_name,
        role: "admin",
        created_by: "bootstrap",
      });
      const session = await loginUser(body.username, body.password, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await audit(req, {
        action: "auth.bootstrap",
        resourceType: "user",
        resourceId: user.id,
        after: { username: user.username, role: user.role },
      });
      return reply.code(201).send({
        user: session.user,
        token: session.token,
        expires_at: session.expires_at,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "BOOTSTRAP_FAILED";
      return reply.code(400).send({ error: msg, error_code: code });
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const body = z
      .object({
        username: z.string().min(1).max(64),
        password: z.string().min(1).max(200),
      })
      .parse(req.body);
    try {
      const session = await loginUser(body.username, body.password, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      await audit(req, {
        action: "auth.login",
        resourceType: "user",
        resourceId: session.user.id,
        after: { username: session.user.username },
      });
      return session;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "LOGIN_FAILED";
      await audit(req, {
        action: "auth.login_failed",
        resourceType: "user",
        resourceId: body.username,
        result: "denied",
        errorCode: code,
      });
      return reply.code(401).send({ error: msg, error_code: code });
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token.startsWith("deepsonar_user_")) {
      await revokeSession(token);
    }
    await audit(req, {
      action: "auth.logout",
      resourceType: "user",
      resourceId: req.actor?.id ?? null,
    });
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const actor = req.actor;
    if (!actor || actor.type === "internal") {
      return {
        auth_required: config.auth.required,
        authenticated: !config.auth.required,
        actor: actor
          ? { type: actor.type, name: actor.name, role: actor.role ?? null, scopes: actor.scopes }
          : null,
        user: null,
      };
    }
    if (actor.type === "user" && actor.id) {
      const [row] = await sql`SELECT * FROM users WHERE id = ${actor.id}`;
      return {
        auth_required: config.auth.required,
        authenticated: true,
        actor: { type: actor.type, name: actor.name, role: actor.role ?? null, scopes: actor.scopes },
        user: row ? toPublicUser(row as Record<string, unknown>) : null,
      };
    }
    return {
      auth_required: config.auth.required,
      authenticated: true,
      actor: { type: actor.type, name: actor.name, role: null, scopes: actor.scopes },
      user: null,
    };
  });

  app.post("/auth/change-password", async (req, reply) => {
    if (req.actor?.type !== "user" || !req.actor.id) {
      return reply.code(403).send({ error: "仅登录用户可修改自己的密码" });
    }
    const body = z
      .object({
        current_password: z.string().min(1),
        new_password: z.string().min(8).max(200),
      })
      .parse(req.body);
    const [row] = await sql`SELECT * FROM users WHERE id = ${req.actor.id}`;
    if (!row) return reply.code(404).send({ error: "user not found" });
    const { verifyPassword } = await import("./users.js");
    if (!verifyPassword(body.current_password, row.password_salt as string, row.password_hash as string)) {
      return reply.code(401).send({ error: "当前密码错误" });
    }
    await setUserPassword(req.actor.id, body.new_password);
    // 重新登录
    const session = await loginUser(row.username as string, body.new_password, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    await audit(req, {
      action: "auth.change_password",
      resourceType: "user",
      resourceId: req.actor.id,
    });
    return { ok: true, token: session.token, expires_at: session.expires_at, user: session.user };
  });

  app.get("/users", async () => listUsers());

  app.post("/users", async (req, reply) => {
    const body = z
      .object({
        username: z.string().min(2).max(64),
        password: z.string().min(8).max(200),
        display_name: z.string().max(100).optional(),
        role: z.enum(["admin", "operator", "viewer"]).default("operator"),
      })
      .parse(req.body);
    try {
      const user = await createUser({
        username: body.username,
        password: body.password,
        display_name: body.display_name,
        role: body.role as UserRole,
        created_by: req.actor?.name ?? null,
      });
      await audit(req, {
        action: "user.create",
        resourceType: "user",
        resourceId: user.id,
        after: { username: user.username, role: user.role },
      });
      return reply.code(201).send(user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "CREATE_FAILED";
      return reply.code(400).send({ error: msg, error_code: code });
    }
  });

  app.patch("/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        display_name: z.string().max(100).optional(),
        role: z.enum(["admin", "operator", "viewer"]).optional(),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body ?? {});
    const user = await updateUser(id, body);
    if (!user) return reply.code(404).send({ error: "not found" });
    await audit(req, {
      action: "user.update",
      resourceType: "user",
      resourceId: id,
      after: body,
    });
    return user;
  });

  app.post("/users/:id/password", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ password: z.string().min(8).max(200) }).parse(req.body);
    const [row] = await sql`SELECT id FROM users WHERE id = ${id}`;
    if (!row) return reply.code(404).send({ error: "not found" });
    await setUserPassword(id, body.password);
    await audit(req, {
      action: "user.reset_password",
      resourceType: "user",
      resourceId: id,
    });
    return { ok: true };
  });

  // ---------- Agent 实时流（WS /ws?job_id=...） ----------
  // 连接后先补发环形缓冲（晚加入也能看到上下文），随后实时推送
  app.get("/ws", { websocket: true }, (socket, req) => {
    const jobId = (req.query as { job_id?: string }).job_id;
    if (!jobId) {
      socket.close(4000, "missing job_id");
      return;
    }
    for (const item of streamBuffer(jobId)) socket.send(JSON.stringify(item));
    const unsub = subscribeStream(jobId, (item) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(item));
    });
    socket.on("close", unsub);
    socket.on("error", unsub);
  });

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

  app.get("/projects", async () => sql`SELECT * FROM projects ORDER BY created_at DESC`);

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

    const canvasId = await ensureCanvasForTask({
      projectId: id,
      title: body.title,
      target: {
        title: body.title,
        content: body.content,
        goal: body.content,
        ...(body.allow_egress !== undefined
          ? { network_policy: { allow_egress: body.allow_egress } }
          : {}),
      },
    });
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
      const row = await transitionJob(resumable.id as string, "pending", {
        error: null,
        lease_expires_at: null,
        claimed_at: null,
        started_at: null,
        finished_at: null,
        heartbeat_at: null,
      });
      if (row) {
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
          priority: 0,
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

    const job = await sql.begin(async (tx) => {
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
      const snapshot = await resolveAgentSnapshotForJob(sql, projectId, "hub_reason");
      const [hubJob] = await tx`
        INSERT INTO jobs ${tx({
          project_id: projectId,
          canvas_id: canvasId,
          plane_issue_id: (canvas.plane_issue_id as string) ?? null,
          agent_snapshot_json: snapshot as never,
          type: "hub_reason",
          priority: 0,
          payload_json: payload as never,
          timeout_sec: config.timeouts.auditSec,
          followup_depth: 0,
        })}
        RETURNING *`;

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
      return hubJob;
    });

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

  // ---------- Git 模块源（§8.2） ----------
  app.get("/skill-sources", async () =>
    sql`SELECT id, name, repo_url, branch, synced_at, created_at,
               trust_status, enabled, last_commit_sha, last_content_hash, synced_by,
               jsonb_array_length(catalog_json) AS module_count
        FROM skill_sources ORDER BY created_at DESC`);

  // 目录详情（模块列表；文件内容不下发，太大了）
  app.get("/skill-sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [src] = await sql`SELECT * FROM skill_sources WHERE id = ${id}`;
    if (!src) return reply.code(404).send({ error: "source not found" });
    const catalog = ((src.catalog_json as { files?: Record<string, string> }[]) ?? []).map(
      ({ files, ...rest }) => ({ ...rest, file_count: Object.keys(files ?? {}).length }),
    );
    return { ...src, catalog_json: catalog };
  });

  app.post("/skill-sources", async (req, reply) => {
    const body = SkillSourceBody.parse(req.body);
    // §5.1：新源 URL 必须先过安全校验（https + host 白名单 + 无内嵌凭据）
    try {
      validateSourceUrl(body.repo_url);
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
    try {
      // 新源默认 quarantined + disabled（0013 迁移默认值），审批后才下发
      const [row] = await sql`
        INSERT INTO skill_sources ${sql({ name: body.name, repo_url: body.repo_url, branch: body.branch })}
        RETURNING id, name, repo_url, branch, synced_at, created_at, trust_status, enabled`;
      await audit(req, {
        action: "skill_source.create",
        resourceType: "skill_source",
        resourceId: row.id as string,
        after: { name: row.name, repo_url: row.repo_url, branch: row.branch },
      });
      return reply.code(201).send(row);
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "同名模块源已存在" });
      }
      throw e;
    }
  });

  // 同步：浅克隆 → 扫描 SKILL.md/commands → catalog 落库（内容缓存，运行不再访问 Git）
  app.post("/skill-sources/:id/sync", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await syncSkillSource(id, req.actor?.name ?? null);
      await audit(req, { action: "skill_source.sync", resourceType: "skill_source", resourceId: id, after: r });
      return { ok: true, ...r };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // §5.1 信任审批：quarantined → trusted（可下发）/ disabled（禁用同步与下发）
  app.post("/skill-sources/:id/trust", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      trust_status: z.enum(["quarantined", "trusted", "disabled"]),
      enabled: z.boolean().optional(),
    }).parse(req.body);
    const enabled = body.enabled ?? body.trust_status === "trusted";
    const [row] = await sql`
      UPDATE skill_sources SET trust_status = ${body.trust_status}, enabled = ${enabled}
      WHERE id = ${id}
      RETURNING id, name, trust_status, enabled, last_commit_sha, last_content_hash`;
    if (!row) return reply.code(404).send({ error: "source not found" });
    await audit(req, {
      action: "skill_source.trust",
      resourceType: "skill_source",
      resourceId: id,
      after: { name: row.name, trust_status: row.trust_status, enabled: row.enabled, commit: row.last_commit_sha },
    });
    return row;
  });

  app.delete("/skill-sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM skill_sources WHERE id = ${id} RETURNING id, name`;
    if (!row) return reply.code(404).send({ error: "source not found" });
    await audit(req, {
      action: "skill_source.delete",
      resourceType: "skill_source",
      resourceId: id,
      before: { name: row.name },
    });
    return { ok: true };
  });

  // ---------- 可信运行时镜像目录 / 市场（P1-P3） ----------

  app.get("/runtime-images", async (req, reply) => {
    const query = req.query as { project_id?: string; search?: string };
    if (req.actor?.projectId && query.project_id && query.project_id !== req.actor.projectId) {
      return reply.code(403).send({ error: `token 仅限项目 ${req.actor.projectId}` });
    }
    const projectId = query.project_id ?? null;
    const search = query.search?.trim() ? `%${query.search.trim()}%` : null;
    return sql`
      SELECT ri.id, ri.image_key, ri.name, ri.description, ri.publisher, ri.source_url,
             ri.source_kind, ri.official, ri.project_opt_in, ri.enabled, ri.created_at, ri.updated_at,
             pri.enabled AS project_enabled, pri.selected_version_id,
             latest.id AS latest_version_id, latest.version AS latest_version,
             latest.digest, latest.resolved_ref, latest.platforms_json, latest.tools_json,
             latest.tools_manifest_sha256, latest.trust_status, latest.scan_summary_json,
             latest.size_bytes, latest.scanned_at, latest.approved_at, latest.promoted_at
      FROM runtime_images ri
      LEFT JOIN project_runtime_images pri
        ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
      LEFT JOIN LATERAL (
        SELECT v.* FROM runtime_image_versions v
        WHERE v.runtime_image_id = ri.id
        ORDER BY CASE v.trust_status WHEN 'trusted' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
                 v.promoted_at DESC NULLS LAST, v.approved_at DESC NULLS LAST, v.created_at DESC
        LIMIT 1
      ) latest ON true
      WHERE (${search}::text IS NULL OR ri.name ILIKE ${search} OR ri.image_key ILIKE ${search}
             OR ri.publisher ILIKE ${search})
      ORDER BY ri.official DESC, ri.name`;
  });

  app.get("/runtime-images/registry", async () => runtimeImageRegistryWithOverrides());

  app.post("/runtime-images/registry/sync", async (req, reply) => {
    try {
      const result = await syncOfficialRuntimeCatalog();
      await audit(req, {
        action: "runtime_image.registry_sync",
        resourceType: "runtime_image_catalog",
        after: { product_count: result.product_count, version_count: result.version_count, synced_at: result.synced_at },
      });
      return reply.code(200).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "读取或同步运行时镜像注册表失败" });
    }
  });

  app.post("/runtime-images/registry/pull", async (req, reply) => {
    try {
      const task = await startRuntimeImagePull();
      await audit(req, {
        action: "runtime_image.registry_pull",
        resourceType: "runtime_image_pull",
        resourceId: task.task_id,
        after: { task_id: task.task_id, total: task.total },
      });
      return reply.code(202).send({ task });
    } catch (error) {
      const message = error instanceof Error ? error.message : "启动镜像拉取失败";
      return reply.code(message.includes("已有运行中") || message.includes("没有可拉取") ? 409 : 503).send({ error: message, task: runtimeImagePullStatus() });
    }
  });

  app.get("/runtime-images/registry/pull-status", async (_req, reply) => {
    return reply.send(runtimeImagePullStatus() ?? {
      task_id: null,
      status: "idle",
      started_at: null,
      finished_at: null,
      total: 0,
      completed: 0,
      items: [],
    });
  });

  const inspectLocalRuntimeImageForProduct = async (productId: string, imageRef: string) => {
    const [image] = await sql`SELECT id, image_key, official, enabled FROM runtime_images WHERE id = ${productId}`;
    if (!image) return { image: null, inspection: null } as const;
    const refs = await sql`
      SELECT image_ref, resolved_ref FROM runtime_image_versions
      WHERE runtime_image_id = ${productId}`;
    const knownRefs = refs.flatMap((row) => [row.image_ref, row.resolved_ref])
      .filter((value): value is string => typeof value === "string");
    return {
      image,
      inspection: await inspectLocalRuntimeImage(imageRef, image.image_key as string, knownRefs),
    } as const;
  };
  const localInspectionResponse = (inspection: Awaited<ReturnType<typeof inspectLocalRuntimeImage>>) => ({
    ...inspection,
    architecture: inspection.arch,
    contract_valid: inspection.contract_matches,
    product_match: inspection.matches_product,
    adoptable: inspection.can_adopt,
    tool_manifest_valid: inspection.tool_manifest_matches,
    labels: {
      ...(inspection.labels.contract ? { "io.deepsonar.contract": inspection.labels.contract } : {}),
      ...(inspection.labels.image_key ? { "io.deepsonar.image-key": inspection.labels.image_key } : {}),
      ...(inspection.labels.toolset ? { "io.deepsonar.toolset": inspection.labels.toolset } : {}),
      ...(inspection.labels.tool_manifest && inspection.labels.tool_manifest_label
        ? { [inspection.labels.tool_manifest_label]: inspection.labels.tool_manifest } : {}),
    },
  });

  /**
   * Read-only local image check. A mutable tag is accepted as an inspect input,
   * but it is never trusted or persisted by this endpoint.
   */
  app.post("/runtime-images/:id([0-9a-fA-F-]{36})/detect-local", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = LocalRuntimeImageInspectBody.parse(req.body);
    const result = await inspectLocalRuntimeImageForProduct(id, body.image_ref);
    if (!result.image) return reply.code(404).send({ error: "runtime image not found" });
    return reply.send({
      product_id: id,
      product_key: result.image.image_key,
      ...localInspectionResponse(result.inspection!),
    });
  });

  /**
   * Explicit administrator adoption of a locally inspected image. The image is
   * inspected again here (TOCTOU guard), and expected_image_id must match the
   * fresh Docker ID before a trusted local-only version is written.
   */
  app.post("/runtime-images/:id([0-9a-fA-F-]{36})/adopt-local", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = LocalRuntimeImageAdoptBody.parse(req.body);
    if (config.runtime.provider !== "local-docker") {
      return reply.code(400).send({ error: "adopt-local 仅支持 SANDBOX_PROVIDER=local-docker" });
    }
    const result = await inspectLocalRuntimeImageForProduct(id, body.image_ref);
    if (!result.image) return reply.code(404).send({ error: "runtime image not found" });
    if (!result.image.official) {
      return reply.code(400).send({
        error: "本地直接采用仅适用于官方产品；第三方镜像仍须经过导入、准入扫描与管理员批准",
      });
    }
    const inspection = result.inspection!;
    if (!inspection.exists && inspection.reasons.includes("docker_inspect_failed")) {
      return reply.code(503).send({ error: inspection.error || "无法验证本地 Docker 镜像", inspection: localInspectionResponse(inspection) });
    }
    if (inspection.image_id?.toLowerCase() !== body.expected_image_id.toLowerCase()) {
      return reply.code(409).send({
        error: "本地镜像 image ID 已变化，请重新检测后再采用",
        expected_image_id: body.expected_image_id,
        actual_image_id: inspection.image_id,
        inspection: localInspectionResponse(inspection),
      });
    }
    if (!inspection.can_adopt || !inspection.immutable_ref) {
      return reply.code(409).send({ error: "本地镜像未通过运行时契约门禁", inspection: localInspectionResponse(inspection) });
    }
    const digest = immutableDigest(inspection.immutable_ref) ?? localImageDigest(inspection.immutable_ref);
    if (!digest) return reply.code(409).send({ error: "本地镜像没有可用的不可变引用", inspection: localInspectionResponse(inspection) });
    const now = new Date();
    const actor = req.actor?.name ?? "internal";
    let version: Record<string, unknown>;
    try {
      version = await sql.begin(async (tx) => {
        // Lock an existing digest before deciding whether it may be adopted.
        // If a concurrent transaction inserts the digest after this check, the
        // guarded ON CONFLICT below waits for it and applies the same rule.
        const [existing] = await tx`
          SELECT id, trust_status FROM runtime_image_versions
          WHERE runtime_image_id = ${id} AND digest = ${digest}
          FOR UPDATE`;
        if (existing?.trust_status === "revoked") {
          throw new RevokedRuntimeImageVersionError(existing.id as string);
        }

        const [saved] = await tx`
          INSERT INTO runtime_image_versions ${tx({
            runtime_image_id: id,
            version: body.version ?? `local-${digest.slice(7, 19)}`,
            image_ref: inspection.immutable_ref,
            resolved_ref: inspection.immutable_ref,
            digest,
            contract_version: "deepsonar.runtime.contract/v1",
            platforms_json: (inspection.os && inspection.arch ? [`${inspection.os}/${inspection.arch}`] : []) as never,
            scan_summary_json: {
              source: "local-adopt",
              risk: "local-only",
              contract: inspection.labels.contract,
              image_key: result.image.image_key,
              tool_manifest_label: inspection.labels.tool_manifest_label,
              registered_by: actor,
            } as never,
            trust_status: "trusted",
            imported_by: actor,
            approved_by: actor,
            scanned_at: now,
            approved_at: now,
            promoted_at: now,
          } as never)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
            image_ref = EXCLUDED.image_ref,
            resolved_ref = EXCLUDED.resolved_ref,
            trust_status = 'trusted',
            contract_version = EXCLUDED.contract_version,
            platforms_json = EXCLUDED.platforms_json,
            scan_summary_json = EXCLUDED.scan_summary_json,
            imported_by = EXCLUDED.imported_by,
            approved_by = EXCLUDED.approved_by,
            approved_at = EXCLUDED.approved_at,
            promoted_at = EXCLUDED.promoted_at,
            status_reason = NULL,
            updated_at = now()
          WHERE runtime_image_versions.trust_status <> 'revoked'
          RETURNING *`;
        if (saved) return saved as Record<string, unknown>;

        // A concurrent insert may have won the unique-index race with a
        // revoked row. Re-read it under the transaction lock so the caller
        // gets a deterministic 409 instead of silently reviving the version.
        const [current] = await tx`
          SELECT id, trust_status FROM runtime_image_versions
          WHERE runtime_image_id = ${id} AND digest = ${digest}
          FOR UPDATE`;
        if (current?.trust_status === "revoked") {
          throw new RevokedRuntimeImageVersionError(current.id as string);
        }
        throw new Error("runtime image adoption conflict; please retry");
      });
    } catch (error) {
      if (error instanceof RevokedRuntimeImageVersionError) {
        return reply.code(409).send({
          error: "runtime image version is revoked and cannot be adopted",
          runtime_image_version_id: error.versionId,
        });
      }
      throw error;
    }
    await audit(req, {
      action: "runtime_image.adopt_local",
      resourceType: "runtime_image_version",
      resourceId: version.id as string,
      after: {
        image_key: result.image.image_key,
        immutable_ref: inspection.immutable_ref,
        digest,
        trust_status: "trusted",
        local_only: true,
      },
    });
    return reply.code(201).send({
      adopted: true,
      local_only: true,
      product_id: id,
      product_key: result.image.image_key,
      immutable_ref: inspection.immutable_ref,
      image: result.image,
      version,
      inspection: localInspectionResponse(inspection),
    });
  });

  /**
   * 注意：`:id` 必须带 uuid 约束，否则会吞掉同层静态路由 `/runtime-images/registry`
   * （Fastify find-my-way 在本版本未把静态路由优先于参数路由）。
   * registry / manual-digest / import / official-digest 等静态段必须不受 :id 干扰。
   */
  app.get("/runtime-images/:id([0-9a-fA-F-]{36})", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [image] = await sql`SELECT * FROM runtime_images WHERE id = ${id}`;
    if (!image) return reply.code(404).send({ error: "runtime image not found" });
    const versions = await sql`
      SELECT v.*,
             COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC)
                       FROM runtime_image_scans s WHERE s.runtime_image_version_id = v.id), '[]'::jsonb) AS scans
      FROM runtime_image_versions v WHERE v.runtime_image_id = ${id}
      ORDER BY v.promoted_at DESC NULLS LAST, v.created_at DESC`;
    return { image, versions };
  });

  /**
   * 官方镜像登记可信 digest。
   * 官方条目不能走第三方 import；本地/运维常缺 DEEPSONAR_OFFICIAL_*_IMAGE，
   * 此接口与启动 bootstrap 相同：只接受 @sha256 不可变引用，直接 trusted。
   */
  app.post("/runtime-images/:id/official-digest", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = OfficialRuntimeImageDigestBody.parse(req.body);
    const [image] = await sql`SELECT * FROM runtime_images WHERE id = ${id}`;
    if (!image) return reply.code(404).send({ error: "runtime image not found" });
    if (!image.official) {
      return reply.code(400).send({ error: "仅官方镜像可通过此接口登记 digest；第三方请走导入 + 准入扫描 + 批准" });
    }
    const local = body.source === "local-build";
    let digest = local ? localImageDigest(body.image_ref) : immutableDigest(body.image_ref);
    let localImmutableRef = body.image_ref;
    let localInspection: Awaited<ReturnType<typeof inspectLocalRuntimeImage>> | null = null;
    if (!digest) return reply.code(400).send({
      error: local ? "local-build 必须使用完整本地 image ID：sha256:64hex" : "必须使用不可变引用 name@sha256:…；可移动 tag 不会被信任",
    });
    if (local && config.runtime.provider !== "local-docker") {
      return reply.code(400).send({ error: "local-build 仅支持 SANDBOX_PROVIDER=local-docker" });
    }
    if (!local && !config.images.isRegistryAllowed(body.image_ref)) {
      return reply.code(400).send({ error: `registry 不在允许列表: ${body.image_ref.split("/")[0]}` });
    }
    if (local) {
      const localResult = await inspectLocalRuntimeImageForProduct(id, body.image_ref);
      localInspection = localResult.inspection;
      if (!localInspection?.exists) {
        return reply.code(503).send({ error: localInspection?.error || "无法验证本地 Docker 镜像；请确认 Docker 可用且该 image ID 已存在", inspection: localInspection ? localInspectionResponse(localInspection) : null });
      }
      if (localInspection.image_id?.toLowerCase() !== body.image_ref.toLowerCase()) {
        return reply.code(400).send({ error: "Docker 镜像存在，但 image ID 校验不匹配", inspection: localInspectionResponse(localInspection) });
      }
      if (!localInspection.can_adopt || !localInspection.immutable_ref) {
        return reply.code(400).send({ error: "本地镜像未通过运行时契约门禁", inspection: localInspectionResponse(localInspection) });
      }
      localImmutableRef = localInspection.immutable_ref;
      digest = immutableDigest(localImmutableRef) ?? localImageDigest(localImmutableRef);
      if (!digest) return reply.code(400).send({ error: "本地镜像没有可用的不可变引用", inspection: localInspectionResponse(localInspection) });
    }
    const versionName = body.version ?? `${local ? "local" : "configured"}-${digest.slice(7, 19)}`;
    const platforms = local
      ? (localInspection?.os && localInspection.arch ? [`${localInspection.os}/${localInspection.arch}`]
        : process.arch === "x64" ? ["linux/amd64"] : process.arch === "arm64" ? ["linux/arm64"] : [])
      : ["linux/amd64", "linux/arm64"];
    const now = new Date();
    const [version] = await sql`
      INSERT INTO runtime_image_versions ${sql({
        runtime_image_id: image.id,
        version: versionName,
        image_ref: local ? localImmutableRef : body.image_ref,
        resolved_ref: local ? localImmutableRef : digest,
        digest,
        contract_version: "deepsonar.runtime.contract/v1",
        platforms_json: platforms as never,
        scan_summary_json: {
          source: local ? "operator-registered-official-local" : "operator-registered-official",
          risk: local ? "local-only" : undefined,
          contract: local ? localInspection?.labels.contract : "declared",
          image_key: local ? localInspection?.labels.image_key ?? localInspection?.labels.toolset : undefined,
          tool_manifest_label: local ? localInspection?.labels.tool_manifest_label : undefined,
          registered_by: req.actor?.name ?? "internal",
        } as never,
        trust_status: "trusted",
        approved_by: req.actor?.name ?? "internal",
        scanned_at: now,
        approved_at: now,
        promoted_at: now,
      } as never)}
      ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
        image_ref = EXCLUDED.image_ref,
        resolved_ref = EXCLUDED.resolved_ref,
        trust_status = 'trusted',
        approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at,
        promoted_at = EXCLUDED.promoted_at,
        status_reason = NULL,
        updated_at = now()
      RETURNING *`;
    await audit(req, {
      action: "runtime_image.official_digest",
      resourceType: "runtime_image_version",
      resourceId: version.id as string,
      after: {
        image_key: image.image_key,
        image_ref: body.image_ref,
        digest,
        trust_status: "trusted",
      },
    });
    return reply.code(201).send({ image, version });
  });

  app.post("/runtime-images/manual-digest", async (req, reply) => {
    const body = ManualRuntimeImageDigestBody.parse(req.body);
    const digest = immutableDigest(body.image_ref);
    if (!digest) return reply.code(400).send({ error: "必须使用不可变引用 name@sha256:64hex" });
    if (!config.images.isRegistryAllowed(body.image_ref)) {
      return reply.code(400).send({ error: `registry 不在允许列表: ${body.image_ref.split("/")[0]}` });
    }
    let image: Record<string, unknown>;
    let version: Record<string, unknown>;
    try {
      ({ image, version } = await sql.begin(async (tx) => {
        const [existing] = await tx`SELECT official FROM runtime_images WHERE image_key = ${body.image_key}`;
        if (existing?.official) throw new Error("官方产品不能通过手动登记绕过官方约束");
        const [savedImage] = await tx`
          INSERT INTO runtime_images ${tx({ image_key: body.image_key, name: body.name, description: body.description,
            publisher: body.publisher, source_url: body.source_url ?? null, source_kind: "third_party", official: false,
            project_opt_in: true } as never)}
          ON CONFLICT (image_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
            publisher = EXCLUDED.publisher, source_url = EXCLUDED.source_url, project_opt_in = true, enabled = true, updated_at = now()
          RETURNING *`;
        const now = new Date();
        const [savedVersion] = await tx`
          INSERT INTO runtime_image_versions ${tx({ runtime_image_id: savedImage.id, version: body.version ?? `manual-${digest.slice(7, 19)}`,
            image_ref: body.image_ref, resolved_ref: body.image_ref, digest, contract_version: "deepsonar.runtime.contract/v1",
            platforms_json: ["linux/amd64", "linux/arm64"] as never,
            scan_summary_json: { source: "manual-operator", risk: "bypasses-admission-scan" } as never,
            trust_status: "trusted", imported_by: req.actor?.name ?? "operator", approved_by: req.actor?.name ?? "operator",
            approved_at: now, promoted_at: now } as never)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET image_ref = EXCLUDED.image_ref,
            resolved_ref = EXCLUDED.resolved_ref, trust_status = 'trusted', imported_by = EXCLUDED.imported_by,
            approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, promoted_at = EXCLUDED.promoted_at,
            status_reason = NULL, updated_at = now()
          RETURNING *`;
        return { image: savedImage as Record<string, unknown>, version: savedVersion as Record<string, unknown> };
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "官方产品不能通过手动登记绕过官方约束") {
        return reply.code(400).send({ error: error.message });
      }
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "同一镜像产品的版本名称已存在且对应不同 digest，请更换 version 名称" });
      }
      throw error;
    }
    await audit(req, { action: "runtime_image.manual_digest", resourceType: "runtime_image_version", resourceId: version.id as string,
      after: { image_key: image.image_key, image_ref: body.image_ref, digest, trust_status: "trusted", source: "manual-operator" } });
    return reply.code(201).send({ image, version });
  });

  app.post("/runtime-images/import", async (req, reply) => {
    const body = RuntimeImageImportBody.parse(req.body);
    if (!config.images.isRegistryAllowed(body.image_ref)) {
      return reply.code(400).send({ error: `registry 不在允许列表: ${body.image_ref.split("/")[0]}` });
    }
    if (body.registry_credential_id) {
      const [credential] = await sql`
        SELECT id FROM credentials WHERE id = ${body.registry_credential_id}
          AND kind = 'oci_registry' AND status = 'active'`;
      if (!credential) return reply.code(400).send({ error: "registry Credential 不存在或不可用" });
    }
    const digest = immutableDigest(body.image_ref);
    const versionName = body.version ?? (digest ? digest.slice(7, 19) : body.image_ref.split(":").at(-1) ?? "imported");
    try {
      const result = await sql.begin(async (tx) => {
        const [existing] = await tx`SELECT id, official FROM runtime_images WHERE image_key = ${body.image_key}`;
        if (existing?.official) throw new Error("不能通过第三方导入 API 覆盖官方镜像");
        const [image] = existing
          ? await tx`
              UPDATE runtime_images SET name = ${body.name}, description = ${body.description},
                publisher = ${body.publisher}, source_url = ${body.source_url ?? null}, updated_at = now()
              WHERE id = ${existing.id as string} RETURNING *`
          : await tx`
              INSERT INTO runtime_images ${tx({
                image_key: body.image_key,
                name: body.name,
                description: body.description,
                publisher: body.publisher,
                source_url: body.source_url ?? null,
                source_kind: "third_party",
                official: false,
                enabled: true,
              })} RETURNING *`;
        const [version] = await tx`
          INSERT INTO runtime_image_versions ${tx({
            runtime_image_id: image.id,
            version: versionName,
            image_ref: body.image_ref,
            resolved_ref: digest ? body.image_ref : null,
            digest,
            trust_status: "quarantined",
            imported_by: req.actor?.name ?? "internal",
          } as never)} RETURNING *`;
        const [scan] = await tx`
          INSERT INTO runtime_image_scans ${tx({
            runtime_image_version_id: version.id,
            result_json: body.registry_credential_id
              ? { registry_credential_id: body.registry_credential_id } as never
              : {} as never,
          } as never)} RETURNING *`;
        return { image, version, scan };
      });
      await audit(req, {
        action: "runtime_image.import",
        resourceType: "runtime_image_version",
        resourceId: result.version.id as string,
        after: { image_key: body.image_key, image_ref: body.image_ref, trust_status: "quarantined" },
      });
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "该镜像版本或 digest 已导入" });
      }
      throw error;
    }
  });

  app.post("/runtime-image-versions/:id/rescan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [version] = await sql`
      UPDATE runtime_image_versions SET
        trust_status = CASE WHEN trust_status = 'trusted' THEN 'trusted' ELSE 'quarantined' END,
        status_reason = NULL, updated_at = now()
      WHERE id = ${id} AND trust_status <> 'revoked' RETURNING id`;
    if (!version) return reply.code(404).send({ error: "version not found or revoked" });
    const [scan] = await sql`
      INSERT INTO runtime_image_scans (runtime_image_version_id) VALUES (${id}) RETURNING *`;
    await audit(req, { action: "runtime_image.rescan", resourceType: "runtime_image_version", resourceId: id });
    return reply.code(202).send(scan);
  });

  app.post("/runtime-image-versions/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = RuntimeImageStatusBody.parse(req.body);
    if ((body.status === "rejected" || body.status === "revoked") && !body.reason) {
      return reply.code(400).send({ error: `${body.status} 必须填写 reason` });
    }
    const [before] = await sql`
      SELECT v.*, ri.image_key FROM runtime_image_versions v
      JOIN runtime_images ri ON ri.id = v.runtime_image_id WHERE v.id = ${id}`;
    if (!before) return reply.code(404).send({ error: "version not found" });
    if (body.status === "trusted") {
      const [scan] = await sql`
        SELECT id, status FROM runtime_image_scans WHERE runtime_image_version_id = ${id}
        ORDER BY created_at DESC LIMIT 1`;
      if (!scan || scan.status !== "succeeded" || !before.resolved_ref || !before.digest) {
        return reply.code(409).send({ error: "版本最新一次准入扫描未通过或未固定 digest" });
      }
    }
    const now = new Date();
    const [version] = await sql`
      UPDATE runtime_image_versions SET
        trust_status = ${body.status}, status_reason = ${body.reason ?? null}, updated_at = now(),
        approved_by = ${body.status === "trusted" ? req.actor?.name ?? "internal" : before.approved_by},
        approved_at = ${body.status === "trusted" ? now : before.approved_at},
        promoted_at = ${body.status === "trusted" ? now : before.promoted_at},
        revoked_at = ${body.status === "revoked" ? now : before.revoked_at}
      WHERE id = ${id} RETURNING *`;

    if (body.status === "revoked") {
      const affected = await sql`
        UPDATE jobs SET status = 'cancelled', finished_at = now(), error = ${`runtime image revoked: ${body.reason}`}
        WHERE agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${id}
          AND status IN ('pending','claimed','provisioning','running','waiting_human')
        RETURNING id, sandbox_id`;
      for (const job of affected) {
        if (job.sandbox_id) await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
      }
    }
    await audit(req, {
      action: `runtime_image.${body.status}`,
      resourceType: "runtime_image_version",
      resourceId: id,
      before: { trust_status: before.trust_status },
      after: { trust_status: body.status, reason: body.reason ?? null },
    });
    return version;
  });

  app.get("/runtime-image-versions/:id/usage", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [version] = await sql`SELECT id FROM runtime_image_versions WHERE id = ${id}`;
    if (!version) return reply.code(404).send({ error: "version not found" });
    const jobs = await sql`
      SELECT j.id, j.project_id, p.name AS project_name, j.canvas_id, c.title AS canvas_title,
             j.type, j.status, j.created_at, j.finished_at,
             (SELECT count(*)::int FROM findings f WHERE f.job_id = j.id) AS finding_count
      FROM jobs j
      JOIN projects p ON p.id = j.project_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      WHERE j.agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${id}
      ORDER BY j.created_at DESC LIMIT 1000`;
    const projects = await sql`
      SELECT DISTINCT p.id, p.name
      FROM jobs j JOIN projects p ON p.id = j.project_id
      WHERE j.agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${id}
      ORDER BY p.name`;
    const findings = await sql`
      SELECT f.id, f.project_id, j.canvas_id, f.job_id, f.title, f.severity, f.verify_status, f.created_at
      FROM findings f JOIN jobs j ON j.id = f.job_id
      WHERE j.agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' = ${id}
      ORDER BY f.created_at DESC LIMIT 1000`;
    return { version_id: id, projects, jobs, findings };
  });

  app.put("/projects/:id/runtime-images/:imageId", async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    const body = ProjectRuntimeImageBody.parse(req.body);
    const [image] = await sql`SELECT id, enabled FROM runtime_images WHERE id = ${imageId}`;
    if (!image?.enabled) return reply.code(404).send({ error: "runtime image not found or disabled" });
    const [version] = body.version_id
      ? await sql`SELECT id FROM runtime_image_versions WHERE id = ${body.version_id} AND runtime_image_id = ${imageId} AND trust_status = 'trusted'`
      : await sql`SELECT id FROM runtime_image_versions WHERE runtime_image_id = ${imageId} AND trust_status = 'trusted' LIMIT 1`;
    if (body.enabled && !version) return reply.code(409).send({ error: "镜像没有可启用的可信版本" });
    const [row] = await sql`
      INSERT INTO project_runtime_images ${sql({
        project_id: id,
        runtime_image_id: imageId,
        selected_version_id: body.version_id ?? null,
        enabled: body.enabled,
      } as never)}
      ON CONFLICT (project_id, runtime_image_id) DO UPDATE SET
        selected_version_id = EXCLUDED.selected_version_id,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING *`;
    await audit(req, {
      action: "runtime_image.project_binding",
      resourceType: "runtime_image",
      resourceId: imageId,
      projectId: id,
      after: { enabled: body.enabled, selected_version_id: body.version_id ?? null },
    });
    return row;
  });

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
  ): Promise<string | null> {
    const envErr = validateEnvVars(body.env_vars);
    if (envErr) return envErr;
    for (const key of body.env_keys) {
      if (!config.runtime.isEnvKeyAllowed(key)) return `env_key 不在白名单: ${key}`;
    }
    if (body.runtime_image_key) {
      const [image] = await sql`
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
      const [cred] = await sql`SELECT id, project_id, status, public_metadata_json FROM credentials WHERE id = ${c.credential_id}`;
      if (!cred) return `Credential 不存在: ${c.credential_id}`;
      if (projectId && cred.project_id && cred.project_id !== projectId) {
        return `Credential ${c.credential_id} 属于其他项目，不能绑定`;
      }
      if (!projectId && cred.project_id) return `全局 RoleConfig 只能绑定全局 Credential`;
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

  async function upsertRoleConfig(
    roleId: string,
    projectId: string | null,
    body: z.infer<typeof RoleConfigPutBody>,
  ) {
    return sql.begin(async (tx) => {
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
    });
  }

  async function roleConfigView(configId: string): Promise<Record<string, unknown> | null> {
    const [cfg] = await sql`SELECT * FROM role_configs WHERE id = ${configId}`;
    if (!cfg) return null;
    const creds = await sql`
      SELECT rc.credential_id, rc.purpose, c.name, c.provider, c.status, c.project_id
      FROM role_credentials rc JOIN credentials c ON c.id = rc.credential_id
      WHERE rc.role_config_id = ${configId}`;
    const files = await sql`
      SELECT path, content, content_sha256 FROM role_config_files
      WHERE role_config_id = ${configId} ORDER BY path`;
    return { ...(cfg as Record<string, unknown>), credentials: creds, config_files: files };
  }

  app.get("/role-configs/global", async () => {
    const rows = await sql`
      SELECT rc.id, r.name AS role_name, r.title AS role_title, r.kind AS role_kind
      FROM role_configs rc JOIN agent_roles r ON r.id = rc.role_id
      WHERE rc.project_id IS NULL ORDER BY r.name`;
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const view = await roleConfigView(row.id as string);
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

  app.put("/role-configs/global/:roleId", async (req, reply) => {
    const { roleId } = req.params as { roleId: string };
    const body = RoleConfigPutBody.parse(req.body);
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${roleId}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    const err = await validateRoleConfigBody(body, null, {
      name: role.name as string,
      kind: role.kind as "role" | "hub" | "system",
    });
    if (err) return reply.code(400).send({ error: err });
    const configId = await upsertRoleConfig(roleId, null, body);
    await audit(req, {
      action: "role_config.upsert",
      resourceType: "role_config",
      resourceId: configId,
      after: { role: role.name, scope: "global", credentials: body.credentials.length, files: body.config_files.length },
    });
    return roleConfigView(configId);
  });

  app.get("/projects/:id/role-configs", async (req, reply) => {
    const { id } = req.params as { id: string };
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
        ? await roleConfigView(row.project_config_id as string)
        : null,
    })));
  });

  app.put("/projects/:id/role-configs/:roleId", async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const body = RoleConfigPutBody.parse(req.body);
    const [p] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const [role] = await sql`SELECT id, name, kind FROM agent_roles WHERE id = ${roleId}`;
    if (!role) return reply.code(404).send({ error: "role not found" });
    if (role.kind === "role") {
      const enabled = await rolesForProject(sql, id);
      if (!enabled.some((r) => r.name === role.name)) {
        return reply.code(409).send({ error: `角色 ${role.name} 未在本项目启用` });
      }
    }
    const err = await validateRoleConfigBody(body, id, {
      name: role.name as string,
      kind: role.kind as "role" | "hub" | "system",
    });
    if (err) return reply.code(400).send({ error: err });
    const configId = await upsertRoleConfig(roleId, id, body);
    await audit(req, {
      action: "role_config.upsert",
      resourceType: "role_config",
      resourceId: configId,
      projectId: id,
      after: { role: role.name, scope: "project", credentials: body.credentials.length, files: body.config_files.length },
    });
    return roleConfigView(configId);
  });

  app.delete("/projects/:id/role-configs/:roleId", async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
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
    sql`SELECT id, name, title, description, builtin, kind, created_at, updated_at
        FROM agent_roles ORDER BY kind DESC, builtin DESC, name`,
  );

  app.post("/agent-roles", async (req, reply) => {
    const body = RoleBody.parse(req.body);
    try {
      const [row] = await sql`
        INSERT INTO agent_roles ${sql({ ...body, builtin: false, kind: "role" })}
        RETURNING id, name, title, description, builtin, kind`;
      await audit(req, {
        action: "role.create",
        resourceType: "agent_role",
        resourceId: row.id as string,
        after: { name: row.name, title: row.title },
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
    const body = RolePatchBody.parse(req.body);
    const [row] = await sql`
      UPDATE agent_roles SET ${sql(body)}, updated_at = now()
      WHERE id = ${id}
      RETURNING id, name, title, description, builtin, kind`;
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
      SELECT id, name, title, description, builtin, kind FROM agent_roles
      WHERE kind = 'role' ORDER BY builtin DESC, name`;
    const set = enabled == null ? null : new Set(enabled);
    return (all as unknown as { name: string; builtin: boolean }[]).map((r) => ({
      ...r,
      enabled: set == null ? r.builtin : set.has(r.name),
      default_enabled: enabled == null,
    }));
  });

  // ---------- 全局设置（§8.1 所有配置落库：规则默认值 → global_settings 单例行） ----------
  const aggregateActive = (rows: Record<string, unknown>[], key: "agent_cli" | "provider") => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const name = String(row[key] ?? "");
      if (name) out[name] = (out[name] ?? 0) + Number(row.count);
    }
    return out;
  };

  app.get("/global-settings", async () => {
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules: ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>,
      effective_rules: await globalRules(sql),
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
    const merged = { ...(((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>), ...body.rules };
    await sql`UPDATE global_settings SET rules_json = ${sql.json(merged as never)}, updated_at = now() WHERE id = 'global'`;
    // Wake a LISTEN-driven dispatcher so a newly available slot/CLI cap is
    // observed without waiting for an optional polling interval or restart.
    await sql`SELECT pg_notify('deepsonar_jobs', 'global-settings-updated')`;
    // 全局规则修改是「全局规则修改」必记项
    await audit(req, {
      action: "settings.global_update",
      resourceType: "global_settings",
      resourceId: "global",
      after: { changed_keys: Object.keys(body.rules) },
    });
    const activeRows = await sql`
      SELECT COALESCE(agent_snapshot_json->>'agent_cli', ${PLATFORM_DEFAULT_AGENT_CLI}) AS agent_cli,
             agent_snapshot_json->>'credential_provider' AS provider,
             COUNT(*)::int AS count
      FROM jobs WHERE status IN ('claimed','provisioning','running') GROUP BY 1, 2`;
    return {
      rules: merged,
      effective_rules: await globalRules(sql),
      active_by_agent_cli: aggregateActive(activeRows, "agent_cli"),
      active_by_provider: aggregateActive(activeRows, "provider"),
    };
  });

  // ---------- 项目设置：运行规则 + 角色启停 ----------
  app.get("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    return {
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
      roles: (cfg.roles ?? { enabled: null }) as Record<string, unknown>,
      effective_rules: await rulesForProject(sql, id),
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
         END FROM jobs j WHERE j.canvas_id = c.id) AS ended_at
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
            priority: 0,
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
          priority: 0,
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
    // 一任务一画布：有 issue 复用（重试），无 issue 每次新建 ad-hoc 画布
    const canvasId = await ensureCanvasForTask({
      projectId: body.project_id,
      planeIssueId: body.plane_issue_id,
      title: body.title ?? `${body.type} 任务`,
      target: { type: body.type, ...body.payload },
    });
    const { job, duplicated } = await createJob({
      projectId: body.project_id,
      canvasId,
      planeIssueId: body.plane_issue_id,
      type: body.type,
      payload: body.payload,
      priority: body.priority,
      timeoutSec: body.timeout_sec,
    });
    if (duplicated) return reply.code(409).send({ error: "同一 issue 已有活动 job" });
    return reply.code(201).send(job);
  });

  app.get("/jobs", async (req) => {
    const q = req.query as { project_id?: string; status?: string };
    // 联表项目名 / 画布标题；从冻结快照抽出 CLI / 模型 / 角色，列表实时展示
    // agent_snapshot_json 在 createJob 时冻结，列表侧不二次解析 RoleConfig
    const projectId = q.project_id?.trim() || null;
    const status = q.status?.trim() || null;
    return sql`
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
      ORDER BY j.created_at DESC
      LIMIT 200`;
  });

  // ---------- Findings 清单（可按项目 / 画布 / severity / 验证状态筛选） ----------
  // canvas_id：只看「本次任务」产出，不混入同项目其它任务
  app.get("/findings", async (req) => {
    const q = req.query as {
      project_id?: string;
      severity?: string;
      verify_status?: string;
      disposition?: string;
      canvas_id?: string;
    };
    const projectId = q.project_id || null;
    const severity = q.severity || null;
    const verifyStatus = q.verify_status || null;
    const canvasId = q.canvas_id || null;
    const disposition = q.disposition || null;
    return sql`
      SELECT f.id, f.project_id, f.job_id, f.node_id, f.fingerprint, f.title, f.severity,
             f.location, f.summary, f.verify_status, f.disposition, f.disposition_note,
             f.disposition_by, f.disposition_at, f.created_at, f.updated_at,
             p.name AS project_name, j.canvas_id
      FROM findings f
      JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id
      WHERE (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)
        AND (${severity}::text IS NULL OR f.severity = ${severity})
        AND (${verifyStatus}::text IS NULL OR f.verify_status = ${verifyStatus})
        AND (${disposition}::text IS NULL OR f.disposition = ${disposition})
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId})
      ORDER BY f.created_at DESC
      LIMIT 500`;
  });

  const DISPOSITIONS = ["open", "accepted", "confirmed_vuln", "rejected_fp", "resolved", "archived"] as const;

  app.get("/findings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [finding] = await sql`
      SELECT f.*, p.name AS project_name, j.canvas_id, j.type AS source_job_type,
             j.status AS source_job_status, c.title AS canvas_title
      FROM findings f
      JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      WHERE f.id = ${id}`;
    if (!finding) return reply.code(404).send({ error: "finding not found" });
    const [verification_jobs, source_events, comments, links, verification_rounds] = await Promise.all([
      sql`SELECT id, type, status, error, started_at, finished_at, created_at, payload_json
          FROM jobs WHERE finding_id = ${id} ORDER BY created_at`,
      sql`SELECT id, job_seq, type, payload_json, created_at
          FROM events WHERE job_id = ${finding.job_id as string} ORDER BY id LIMIT 1000`,
      sql`SELECT id, finding_id, body, author_type, author_id, author_name, created_at
          FROM finding_comments WHERE finding_id = ${id} ORDER BY created_at`,
      sql`SELECT id, finding_id, url, title, link_type, created_by, created_at
          FROM finding_links WHERE finding_id = ${id} ORDER BY created_at`,
      sql`SELECT id, attempt, verify_job_id, status, proposed_verdict, final_outcome,
                 requirements_json, evidence_snapshot_json, summary, error, created_at, finished_at
          FROM finding_verification_rounds WHERE finding_id = ${id} ORDER BY attempt`,
    ]);
    return { finding, verification_jobs, source_events, comments, links, verification_rounds };
  });

  // ---------- 任务报告（Hub complete → analysis_complete → Report） ----------
  app.get("/canvases/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { getTaskReport } = await import("./report.js");
    const report = await getTaskReport(id);
    if (!report) return reply.code(404).send({ error: "report not found" });
    return report;
  });

  app.get("/reports/:id/markdown", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { getTaskReportById, readReportBlob } = await import("./report.js");
    const report = await getTaskReportById(id);
    if (!report) return reply.code(404).send({ error: "report not found" });
    if (report.status !== "succeeded" || !report.markdown_uri) {
      return reply.code(409).send({ error: "report not ready", status: report.status });
    }
    try {
      const buf = await readReportBlob(report.markdown_uri as string);
      return reply.type("text/markdown; charset=utf-8").send(buf.toString("utf8"));
    } catch {
      return reply.code(404).send({ error: "markdown blob missing" });
    }
  });

  app.get("/reports/:id/sarif", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { getTaskReportById, readReportBlob } = await import("./report.js");
    const report = await getTaskReportById(id);
    if (!report) return reply.code(404).send({ error: "report not found" });
    if (report.status !== "succeeded" || !report.sarif_uri) {
      return reply.code(409).send({ error: "report not ready", status: report.status });
    }
    try {
      const buf = await readReportBlob(report.sarif_uri as string);
      return reply.type("application/json").send(JSON.parse(buf.toString("utf8")));
    } catch {
      return reply.code(404).send({ error: "sarif blob missing" });
    }
  });

  app.post("/canvases/:id/report/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const { retryReport } = await import("./report.js");
    const result = await retryReport(id);
    await audit(req, {
      action: "report.retry",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
      after: result,
    });
    if (!result.ok) return reply.code(409).send(result);
    // 唤醒 dispatcher
    await sql`SELECT pg_notify('deepsonar_jobs', 'report_retry')`;
    return result;
  });

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
      sql`SELECT id, job_seq, type, payload_json, created_at FROM events WHERE job_id = ${id} ORDER BY id LIMIT 1000`,
      sql`SELECT id, fingerprint, title, severity, location, verify_status FROM findings WHERE job_id = ${id}`,
    ]);
    return { job, events, findings };
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
    const [job] = await sql`SELECT id FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "job not found" });
    return { events: await readNormalizedStream(id) };
  });

  // 只有 pending 可调整优先级（运行中/终态改优先级无意义）
  app.patch("/jobs/:id/priority", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PriorityBody.parse(req.body);
    const [job] = await sql`
      UPDATE jobs SET priority = ${body.priority}
      WHERE id = ${id} AND status = 'pending'
      RETURNING id, status, priority`;
    if (!job) return reply.code(409).send({ error: "只有 pending 状态的 job 可调整优先级" });
    await audit(req, { action: "job.priority", resourceType: "job", resourceId: id, after: { priority: body.priority } });
    return job;
  });

  // 取消 / 强制退出（§8.3）：置 cancel 终态 + 立即停容器 + 画布节点同步；迟到 done 由 finalizeJob 守卫忽略
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
    const [job] = await sql`
      UPDATE jobs SET status = 'cancelled', finished_at = now(),
        error = ${reason},
        lease_expires_at = NULL,
        heartbeat_at = NULL
      WHERE id = ${id} AND status IN ('pending','claimed','provisioning','running','waiting_human')
      RETURNING id, status, sandbox_id, project_id, type, canvas_id`;
    if (!job) return reply.code(409).send({ error: "job 不在可取消状态" });
    if (job.sandbox_id) {
      await runner.destroy({ sandboxId: job.sandbox_id as string }).catch((e) => {
        console.error(`[cancel] 沙箱回收失败 ${job.sandbox_id}:`, e);
      });
    }
    // §6.3：取消即吊销短期模型 Token
    const { revokeJobTokens } = await import("./gateway.js");
    await revokeJobTokens(id, "cancelled").catch(() => {});
    await sql`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent", "report"]})`;
    if (job.type === "verify_finding") {
      const { recoverVerifyJobTerminal } = await import("./core.js");
      await recoverVerifyJobTerminal(id, "cancelled", reason).catch((e) =>
        console.error(`[cancel] verify recovery failed:`, e),
      );
    }
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
    const active = await sql`
      SELECT id, sandbox_id, type FROM jobs
      WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human')`;
    const { revokeJobTokens } = await import("./gateway.js");
    const { recoverVerifyJobTerminal } = await import("./core.js");
    let cancelled = 0;
    for (const job of active) {
      const jobId = job.id as string;
      const [row] = await sql`
        UPDATE jobs SET status = 'cancelled', finished_at = now(),
          error = ${reason}, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE id = ${jobId}
          AND status IN ('pending','claimed','provisioning','running','waiting_human')
        RETURNING id`;
      if (!row) continue;
      cancelled += 1;
      if (job.sandbox_id) {
        await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
      }
      await revokeJobTokens(jobId, "cancelled").catch(() => {});
      await sql`
        UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
        WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;
      if (job.type === "verify_finding") {
        await recoverVerifyJobTerminal(jobId, "cancelled", reason).catch(() => {});
      }
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
    const row = await transitionJob(id, "pending", {
      error: null,
      lease_expires_at: null,
      claimed_at: null,
      started_at: null,
      finished_at: null,
      heartbeat_at: null,
    });
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

  // ---------- 平台 API Token 管理（§6.1/§6.4：tokens:manage） ----------
  // 与 Provider Credential（LLM/Plane/Git 密钥）严格分离；明文仅创建/轮换时返回一次
  const TOKEN_SAFE_FIELDS = sql`id, name, subject_type, subject_id, project_id, token_prefix, scopes,
                                expires_at, last_used_at, last_ip, revoked_at, created_at, created_by`;

  const CreateTokenBody = z.object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.enum(ALL_SCOPES)).min(1),
    project_id: z.string().uuid().nullable().optional(),
    expires_in_days: z.number().int().positive().max(365).optional(),
  });

  app.get("/tokens", async () =>
    sql`SELECT ${TOKEN_SAFE_FIELDS} FROM api_tokens ORDER BY created_at DESC`);

  app.post("/tokens", async (req, reply) => {
    const body = CreateTokenBody.parse(req.body);
    const { plaintext, prefix, hash } = generateToken();
    const [row] = await sql`
      INSERT INTO api_tokens ${sql({
        name: body.name,
        project_id: body.project_id ?? null,
        token_prefix: prefix,
        token_hash: hash,
        scopes: body.scopes as unknown as never,
        expires_at: body.expires_in_days
          ? new Date(Date.now() + body.expires_in_days * 86400_000)
          : null,
        created_by: req.actor?.name ?? null,
      })}
      RETURNING id, name, token_prefix, scopes, project_id, expires_at, created_at`;
    // 明文只在这里出现一次（§6.1）；不落日志、不进审计
    await audit(req, {
      action: "token.create",
      resourceType: "api_token",
      resourceId: row.id as string,
      projectId: (row.project_id as string) ?? null,
      after: { name: row.name, scopes: row.scopes, expires_at: row.expires_at },
    });
    return reply.code(201).send({ ...row, token: plaintext });
  });

  app.post("/tokens/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`
      UPDATE api_tokens SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL
      RETURNING id, name, token_prefix, revoked_at`;
    if (!row) return reply.code(404).send({ error: "token 不存在或已吊销" });
    await audit(req, { action: "token.revoke", resourceType: "api_token", resourceId: id, after: { name: row.name } });
    return row;
  });

  app.post("/tokens/:id/rotate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [old] = await sql`SELECT * FROM api_tokens WHERE id = ${id} AND revoked_at IS NULL`;
    if (!old) return reply.code(404).send({ error: "token 不存在或已吊销" });
    const { plaintext, prefix, hash } = generateToken();
    const [row] = await sql`
      INSERT INTO api_tokens ${sql({
        name: old.name as string,
        subject_type: old.subject_type as string,
        subject_id: old.subject_id as string | null,
        project_id: old.project_id as string | null,
        token_prefix: prefix,
        token_hash: hash,
        scopes: old.scopes as unknown as never,
        expires_at: old.expires_at as Date | null,
        created_by: req.actor?.name ?? null,
      })}
      RETURNING id, name, token_prefix, scopes, project_id, expires_at, created_at`;
    await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${id}`;
    await audit(req, {
      action: "token.rotate",
      resourceType: "api_token",
      resourceId: row.id as string,
      before: { id, name: old.name },
      after: { name: row.name, scopes: row.scopes },
    });
    return reply.code(201).send({ ...row, token: plaintext, rotated_from: id });
  });

  // ---------- Provider Credential（§6.2/§6.4：加密存储，与 API Token 严格分离） ----------
  // 列表/详情永不返回密文；明文只在创建/轮换请求体里进、运行时解密用
  const CRED_SAFE = sql`id, name, kind, provider, project_id, key_version, public_metadata_json,
                        fingerprint, last4, status, last_used_at, rotated_at, created_at, created_by`;

  const CredentialBody = z.object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["llm_provider", "plane", "git", "oci_registry"]).default("llm_provider"),
    provider: z.string().trim().min(1).max(50),
    secret: z.string().min(1).max(4096),
    project_id: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  });

  app.get("/credentials", async () => {
    const [rows, usage] = await Promise.all([
      sql`SELECT ${CRED_SAFE} FROM credentials ORDER BY created_at DESC`,
      sql`SELECT agent_snapshot_json->>'credential_id' AS credential_id,
                 agent_snapshot_json->>'model' AS model,
                 COUNT(*)::int AS count
          FROM jobs
          WHERE status IN ('claimed','provisioning','running')
            AND agent_snapshot_json->>'credential_id' IS NOT NULL
          GROUP BY 1, 2`,
    ]);
    return rows.map((row) => {
      const own = usage.filter((item) => item.credential_id === row.id);
      return {
        ...row,
        active_count: own.reduce((total, item) => total + Number(item.count), 0),
        active_by_model: Object.fromEntries(own.filter((item) => item.model).map((item) => [String(item.model), Number(item.count)])),
      };
    });
  });

  /** 规范化 public metadata：base_url 去尾斜杠，空串删除 key */
  function normalizeCredentialMeta(raw: Record<string, unknown>): Record<string, unknown> {
    const meta = { ...raw };
    if (typeof meta.base_url === "string") {
      const u = meta.base_url.trim().replace(/\/+$/, "");
      if (u) meta.base_url = u;
      else delete meta.base_url;
    }
    if (meta.allowed_model_ids !== undefined) {
      const parsed = z.array(z.string().trim().min(1).max(200)).max(200).parse(meta.allowed_model_ids);
      meta.allowed_model_ids = [...new Set(parsed)];
    }
    if (meta.max_concurrent !== undefined && meta.max_concurrent !== null && meta.max_concurrent !== "") {
      meta.max_concurrent = z.coerce.number().int().min(0).max(1000).parse(meta.max_concurrent);
    } else {
      delete meta.max_concurrent;
    }
    const allowed = allowedModelIds(meta);
    if (allowed.length > 0) {
      const rawLimits = meta.model_concurrency && typeof meta.model_concurrency === "object" && !Array.isArray(meta.model_concurrency)
        ? meta.model_concurrency as Record<string, unknown>
        : {};
      meta.model_concurrency = Object.fromEntries(allowed.map((model) => [
        model,
        z.coerce.number().int().min(0).max(1000).parse(rawLimits[model] ?? 1),
      ]));
    } else {
      delete meta.model_concurrency;
    }
    return meta;
  }

  app.post("/credentials", async (req, reply) => {
    const body = CredentialBody.parse(req.body);
    if (body.kind !== "oci_registry" && !isProviderKnown(body.provider)) {
      return reply.code(400).send({ error: `未知 provider: ${body.provider}（固定映射表外的 provider 不允许登记）` });
    }
    if (body.kind !== "llm_provider" && (allowedModelIds(body.metadata).length > 0 || credentialConcurrencyPolicy(body.metadata).maxConcurrent !== null)) {
      return reply.code(400).send({ error: "只有 llm_provider Credential 可设置模型或运行并发" });
    }
    if (body.kind === "oci_registry") {
      const registry = typeof body.metadata.registry === "string" ? body.metadata.registry.trim().toLowerCase() : "";
      const username = typeof body.metadata.username === "string" ? body.metadata.username.trim() : "";
      if (!registry || !username || !config.images.isRegistryAllowed(`${registry}/probe`)) {
        return reply.code(400).send({ error: "OCI Registry Credential 必须提供允许列表内的 metadata.registry 与 metadata.username" });
      }
    }
    let enc: Encrypted;
    try {
      enc = encryptSecret(body.secret);
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : String(e) });
    }
    const [row] = await sql`
      INSERT INTO credentials ${sql({
        name: body.name,
        kind: body.kind,
        provider: body.provider,
        project_id: body.project_id ?? null,
        ciphertext: enc.ciphertext,
        nonce: enc.nonce,
        auth_tag: enc.auth_tag,
        public_metadata_json: normalizeCredentialMeta(body.metadata) as never,
        fingerprint: fingerprintOf(body.secret),
        last4: last4Of(body.secret),
        created_by: req.actor?.name ?? null,
      })}
      RETURNING ${CRED_SAFE}`;
    // §7.2 红线：只记指纹/last4/元数据，密文与明文都不进审计
    await audit(req, {
      action: "credential.create",
      resourceType: "credential",
      resourceId: row.id as string,
      projectId: body.project_id ?? null,
      after: { name: row.name, provider: row.provider, fingerprint: row.fingerprint, last4: row.last4 },
    });
    return reply.code(201).send(row);
  });

  // 非敏感字段可改：名称 / 项目归属 / public metadata（如 base_url）
  // 密钥仍只能走 rotate；provider/kind 创建后不可改（避免绑定语义漂移）
  app.patch("/credentials/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        project_id: z.string().uuid().nullable().optional(),
        /** 整体替换 public_metadata_json（非密钥：base_url 等）；传 {} 可清空 */
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .refine((b) => b.name !== undefined || b.project_id !== undefined || b.metadata !== undefined, {
        message: "至少提供 name / project_id / metadata 之一",
      })
      .parse(req.body);

    const sets: Record<string, unknown> = {};
    if (body.name !== undefined) sets.name = body.name;
    if (body.project_id !== undefined) sets.project_id = body.project_id;
    if (body.metadata !== undefined) {
      const [existing] = await sql`SELECT kind FROM credentials WHERE id = ${id}`;
      if (!existing) return reply.code(404).send({ error: "credential not found" });
      const normalized = normalizeCredentialMeta(body.metadata);
      if (existing.kind !== "llm_provider" && (allowedModelIds(normalized).length > 0 || credentialConcurrencyPolicy(normalized).maxConcurrent !== null)) {
        return reply.code(400).send({ error: "只有 llm_provider Credential 可设置模型或运行并发" });
      }
      sets.public_metadata_json = normalized;
    }
    if (Object.keys(sets).length === 0) {
      return reply.code(400).send({ error: "没有可更新的字段" });
    }

    const [row] = await sql`
      UPDATE credentials SET ${sql(sets as never)} WHERE id = ${id} RETURNING ${CRED_SAFE}`;
    if (!row) return reply.code(404).send({ error: "credential not found" });
    return row;
  });

  app.post("/credentials/:id/rotate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ secret: z.string().min(1).max(4096) }).parse(req.body);
    let enc: Encrypted;
    try {
      enc = encryptSecret(body.secret);
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : String(e) });
    }
    const [row] = await sql`
      UPDATE credentials SET
        ciphertext = ${enc.ciphertext}, nonce = ${enc.nonce}, auth_tag = ${enc.auth_tag},
        fingerprint = ${fingerprintOf(body.secret)}, last4 = ${last4Of(body.secret)},
        rotated_at = now(), status = 'active', key_version = key_version + 1
      WHERE id = ${id}
      RETURNING ${CRED_SAFE}`;
    if (!row) return reply.code(404).send({ error: "credential not found" });
    await audit(req, {
      action: "credential.rotate",
      resourceType: "credential",
      resourceId: id,
      after: { name: row.name, provider: row.provider, key_version: row.key_version, fingerprint: row.fingerprint },
    });
    return row;
  });

  app.post("/credentials/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ status: z.enum(["active", "disabled", "rotation_required"]) }).parse(req.body);
    const [row] = await sql`
      UPDATE credentials SET status = ${body.status} WHERE id = ${id} RETURNING ${CRED_SAFE}`;
    if (!row) return reply.code(404).send({ error: "credential not found" });
    await audit(req, {
      action: "credential.status",
      resourceType: "credential",
      resourceId: id,
      after: { name: row.name, status: row.status },
    });
    return row;
  });

  // 连接测试：用解密后的凭据对 provider 做一次轻量调用（明文不出进程）
  app.post("/credentials/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [cred] = await sql`SELECT * FROM credentials WHERE id = ${id}`;
    if (!cred) return reply.code(404).send({ error: "credential not found" });
    const result = await testCredential(cred as never);
    await audit(req, {
      action: "credential.test",
      resourceType: "credential",
      resourceId: id,
      result: result.ok ? "ok" : "error",
      after: { ok: result.ok },
    });
    return result;
  });

  app.post("/credentials/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [cred] = await sql`SELECT * FROM credentials WHERE id = ${id}`;
    if (!cred) return reply.code(404).send({ error: "credential not found" });
    if (cred.kind !== "llm_provider") return reply.code(400).send({ error: "该 Credential 不是 LLM Provider" });
    try {
      const result = await listCredentialModels(cred as never);
      await audit(req, {
        action: "credential.models_discover",
        resourceType: "credential",
        resourceId: id,
        result: "ok",
        after: { model_count: result.models.length },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await audit(req, {
        action: "credential.models_discover",
        resourceType: "credential",
        resourceId: id,
        result: "error",
        errorCode: "MODEL_DISCOVERY_FAILED",
      });
      return reply.code(502).send({ error: message });
    }
  });

  // ---------- 审计日志（§7.2：只读查询；写入由各管理动作触发，append-only） ----------
  app.get("/audit-logs", async (req) => {
    const q = req.query as { project_id?: string; action?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return sql`
      SELECT id, at, actor_type, actor_id, action, project_id, resource_type, resource_id,
             request_id, ip, result, error_code, before_json, after_json
      FROM audit_logs
      WHERE (${q.project_id ?? null}::uuid IS NULL OR project_id = ${q.project_id ?? null}::uuid)
        AND (${q.action ?? null}::text IS NULL OR action = ${q.action ?? null})
      ORDER BY at DESC, id DESC
      LIMIT ${limit}`;
  });

  // ---------- 指标（§13.1：Prometheus 文本；内部网络抓取，走普通认证） ----------
  app.get("/metrics", async (_req, reply) =>
    reply.type("text/plain; version=0.0.4").send(await renderMetrics()));

  // ---------- 项目数据包导入导出（.deepsonarpack） ----------
  {
    app.addContentTypeParser(
      ["application/zip", "application/octet-stream", "application/x-deepsonarpack"],
      { parseAs: "buffer", bodyLimit: 256 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );

    app.post("/projects/:id/exports", async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          preset: z.enum(["configuration", "project_full", "evidence_archive", "custom"]).default("configuration"),
          modules: z.array(z.string()).optional(),
          include_blobs: z.boolean().optional(),
          allow_active_jobs: z.boolean().optional(),
          credentials: z.object({ mode: z.enum(["excluded", "metadata"]).optional() }).optional(),
        })
        .parse(req.body ?? {});
      const [project] = await sql`SELECT id, name FROM projects WHERE id = ${id}`;
      if (!project) return reply.code(404).send({ error: "project not found" });
      const { modules } = resolveModules(body.preset, body.modules);
      const [row] = await sql`
        INSERT INTO data_exports ${sql({
          project_id: id,
          scope: "project",
          preset: body.preset,
          modules_json: modules as never,
          options_json: body as never,
          status: "pending",
          created_by: req.actor?.name ?? null,
        })}
        RETURNING *`;
      await audit(req, {
        action: "export.create",
        resourceType: "data_export",
        resourceId: row.id as string,
        projectId: id,
        after: { preset: body.preset, modules, scope: "project" },
      });
      setImmediate(() => {
        void processExportRow(row.id as string, "project");
      });
      return reply.code(201).send(row);
    });

    app.get("/projects/:id/exports", async (req, reply) => {
      const { id } = req.params as { id: string };
      return sql`
        SELECT id, project_id, scope, preset, modules_json, status, artifact_sha256, artifact_size,
               expires_at, error_code, error, created_by, created_at, started_at, finished_at
        FROM data_exports WHERE project_id = ${id} AND scope = 'project' ORDER BY created_at DESC LIMIT 50`;
    });

    // ---------- 平台配置导出 ----------
    app.post("/platform/exports", async (req, reply) => {
      const body = z
        .object({
          preset: z.enum(["platform_full", "custom"]).default("platform_full"),
          modules: z.array(z.string()).optional(),
          credentials: z.object({ mode: z.enum(["excluded", "metadata"]).optional() }).optional(),
        })
        .parse(req.body ?? {});
      const modules = resolvePlatformModules(body.preset, body.modules);
      const [row] = await sql`
        INSERT INTO data_exports ${sql({
          project_id: null,
          scope: "platform",
          preset: body.preset,
          modules_json: modules as never,
          options_json: body as never,
          status: "pending",
          created_by: req.actor?.name ?? null,
        })}
        RETURNING *`;
      await audit(req, {
        action: "export.platform_create",
        resourceType: "data_export",
        resourceId: row.id as string,
        after: { preset: body.preset, modules, scope: "platform" },
      });
      setImmediate(() => {
        void processExportRow(row.id as string, "platform");
      });
      return reply.code(201).send(row);
    });

    app.get("/platform/exports", async () => {
      return sql`
        SELECT id, project_id, scope, preset, modules_json, status, artifact_sha256, artifact_size,
               expires_at, error_code, error, created_by, created_at, started_at, finished_at
        FROM data_exports WHERE scope = 'platform' ORDER BY created_at DESC LIMIT 50`;
    });

    app.get("/exports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`SELECT * FROM data_exports WHERE id = ${id}`;
      if (!row) return reply.code(404).send({ error: "not found" });
      return row;
    });

    app.get("/exports/:id/download", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`SELECT * FROM data_exports WHERE id = ${id}`;
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.status !== "succeeded" || !row.artifact_uri) {
        return reply.code(409).send({ error: "export not ready" });
      }
      if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
        return reply.code(410).send({ error: "export expired" });
      }
      const buf = await loadPackFile(row.artifact_uri as string);
      await audit(req, {
        action: "export.download",
        resourceType: "data_export",
        resourceId: id,
        projectId: row.project_id as string,
        after: { sha256: row.artifact_sha256, size: row.artifact_size },
      });
      return reply
        .header("content-type", "application/x-deepsonarpack")
        .header("content-disposition", `attachment; filename="project-${row.project_id}.deepsonarpack"`)
        .header("x-content-sha256", String(row.artifact_sha256 ?? ""))
        .send(buf);
    });

    app.post("/exports/:id/cancel", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE data_exports SET status = 'cancelled', finished_at = now()
        WHERE id = ${id} AND status IN ('pending','collecting','packaging')
        RETURNING *`;
      if (!row) return reply.code(409).send({ error: "cannot cancel" });
      return row;
    });

    app.delete("/exports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`DELETE FROM data_exports WHERE id = ${id} RETURNING *`;
      if (!row) return reply.code(404).send({ error: "not found" });
      await removeFileSafe(row.artifact_uri as string | null);
      return { ok: true };
    });

    app.post("/imports", async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({
          error: "expected raw package body (Content-Type: application/zip or application/x-deepsonarpack)",
        });
      }
      const id = crypto.randomUUID();
      const sha = sha256Hex(body);
      const uri = await saveImportUpload(id, body);
      // 嗅探包类型
      let scope: "project" | "platform" = "project";
      try {
        const pack = await openDeepsonarPack(body);
        if (pack.manifest.format === PLATFORM_FORMAT) scope = "platform";
      } catch {
        /* preview 阶段再报错 */
      }
      const [row] = await sql`
        INSERT INTO data_imports ${sql({
          id,
          source_artifact_uri: uri,
          source_sha256: sha,
          scope,
          status: "uploaded",
          created_by: req.actor?.name ?? null,
        })}
        RETURNING *`;
      await audit(req, {
        action: "import.upload",
        resourceType: "data_import",
        resourceId: id,
        after: { sha256: sha, size: body.length, scope },
      });
      return reply.code(201).send(row);
    });

    app.get("/imports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`SELECT * FROM data_imports WHERE id = ${id}`;
      if (!row) return reply.code(404).send({ error: "not found" });
      return row;
    });

    app.post("/imports/:id/preview", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const [row] = await sql`SELECT scope, source_artifact_uri FROM data_imports WHERE id = ${id}`;
        if (!row) return reply.code(404).send({ error: "not found" });
        let scope = row.scope as string;
        if (scope !== "platform") {
          try {
            const buf = await loadPackFile(row.source_artifact_uri as string);
            const pack = await openDeepsonarPack(buf);
            if (pack.manifest.format === PLATFORM_FORMAT) scope = "platform";
          } catch {
            /* fall through */
          }
        }
        const preview =
          scope === "platform" ? await buildPlatformPreview(id) : await buildPreview(id);
        await audit(req, {
          action: "import.preview",
          resourceType: "data_import",
          resourceId: id,
          after: {
            scope,
            modules: (preview as { selected_modules?: string[] }).selected_modules,
          },
        });
        return preview;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "PREVIEW_FAILED";
        await sql`UPDATE data_imports SET status = 'failed', error = ${msg}, error_code = ${code} WHERE id = ${id}`;
        return reply.code(400).send({ error: msg, error_code: code });
      }
    });

    app.post("/imports/:id/apply", async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          mode: z.enum(["create_new", "merge_configuration", "merge_platform"]).optional(),
          project_name: z.string().optional(),
          target_project_id: z.string().uuid().optional(),
          modules: z.array(z.string()).optional(),
          conflict_policy: z.enum(["rename", "keep_target", "use_source"]).optional(),
          credential_mappings: z.record(z.string(), z.string()).optional(),
        })
        .parse(req.body ?? {});
      try {
        const [row] = await sql`SELECT scope, source_artifact_uri FROM data_imports WHERE id = ${id}`;
        if (!row) return reply.code(404).send({ error: "not found" });
        let scope = row.scope as string;
        try {
          const buf = await loadPackFile(row.source_artifact_uri as string);
          const pack = await openDeepsonarPack(buf);
          if (pack.manifest.format === PLATFORM_FORMAT) scope = "platform";
        } catch {
          /* use stored scope */
        }

        if (scope === "platform" || body.mode === "merge_platform") {
          const result = await applyPlatformImport(id, {
            conflict_policy: body.conflict_policy === "keep_target" ? "keep_target" : "use_source",
            credential_mappings: body.credential_mappings,
          });
          await audit(req, {
            action: "import.platform_apply",
            resourceType: "data_import",
            resourceId: id,
            after: { summary: result.summary },
          });
          return result;
        }

        const mode = body.mode === "merge_configuration" ? "merge_configuration" : "create_new";
        const result = await applyImport(id, {
          mode,
          project_name: body.project_name,
          target_project_id: body.target_project_id,
          modules: body.modules as never,
          conflict_policy: body.conflict_policy,
          credential_mappings: body.credential_mappings,
        });
        await audit(req, {
          action: "import.apply",
          resourceType: "data_import",
          resourceId: id,
          projectId: result.project_id,
          after: { mode, project_id: result.project_id },
        });
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ error: msg });
      }
    });

    app.post("/imports/:id/cancel", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`
        UPDATE data_imports SET status = 'cancelled', finished_at = now()
        WHERE id = ${id} AND status IN ('uploaded','validating','preview_ready')
        RETURNING *`;
      if (!row) return reply.code(409).send({ error: "cannot cancel" });
      return row;
    });

    app.delete("/imports/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await sql`DELETE FROM data_imports WHERE id = ${id} RETURNING *`;
      if (!row) return reply.code(404).send({ error: "not found" });
      await removeFileSafe(row.source_artifact_uri as string | null);
      return { ok: true };
    });
  }

  // ---------- API Schema 文档（豁免鉴权，供前端/Skill/外部工具发现契约） ----------
  // GET /openapi.json —— OpenAPI 3.0 JSON（标准机器可读）
  // GET /schema       —— ?format=openapi|summary|markdown（默认 openapi）
  // GET /schema.md    —— Markdown 契约（优先读 skills/.../api.md）
  app.get("/openapi.json", async (_req, reply) =>
    reply.type("application/json; charset=utf-8").send(buildOpenApiDocument()));

  app.get("/schema", async (req, reply) => {
    const format = String((req.query as { format?: string }).format ?? "openapi").toLowerCase();
    if (format === "summary") {
      return reply.type("application/json; charset=utf-8").send(buildSchemaSummary());
    }
    if (format === "markdown" || format === "md") {
      const md = loadApiMarkdown();
      if (md) return reply.type("text/markdown; charset=utf-8").send(md);
      // 无仓库 md 时回落为摘要 JSON 的简易文本
      const summary = buildSchemaSummary() as { title: string; endpoints: { method: string; path: string; summary: string; scope: string }[] };
      const lines = [
        `# ${summary.title}`,
        "",
        "（未找到 skills/.../api.md，以下为运行时生成的端点摘要）",
        "",
        ...summary.endpoints.map((e) => `- \`${e.method} ${e.path}\` — ${e.summary} _(scope: ${e.scope})_`),
        "",
      ];
      return reply.type("text/markdown; charset=utf-8").send(lines.join("\n"));
    }
    // 默认：完整 OpenAPI
    return reply.type("application/json; charset=utf-8").send(buildOpenApiDocument());
  });

  app.get("/schema.md", async (_req, reply) => {
    const md = loadApiMarkdown();
    if (md) return reply.type("text/markdown; charset=utf-8").send(md);
    return reply.code(404).send({ error: "api.md not found in workspace" });
  });

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
}
