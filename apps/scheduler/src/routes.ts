import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "./audit.js";
import { ALL_SCOPES, authHook, generateToken } from "./auth.js";
import { renderMetrics } from "./metrics.js";
import { config } from "./config.js";
import {
  encryptSecret,
  fingerprintOf,
  isProviderKnown,
  last4Of,
  type Encrypted,
} from "./credentials.js";
import { testCredential } from "./credential-test.js";
import { createJob, ensureCanvasForTask, globalRules, rulesForProject, transitionJob } from "./core.js";
import { sql } from "./db.js";
import { planePollOnce, planePollProject, planeWriteback } from "./plane-sync.js";
import { registerGateway } from "./gateway.js";
import { runner } from "./runtime.js";
import { syncSkillSource, validateSourceUrl } from "./skill-sources.js";
import { streamBuffer, subscribeStream } from "./stream-bus.js";

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

// Agent profile（§8.1）：env_keys 只存变量名引用，密钥永不落库
const ReasoningEffort = z.enum(["low", "medium", "high", "xhigh"]);
const ProfileBody = z.object({
  name: z.string().min(1),
  agent_cli: z.enum(["claude-code", "open-code", "codex"]).default("claude-code"),
  model: z.string().nullish(),
  /** 思考强度（agentbox reasoning）；null/省略 = provider 默认 */
  reasoning: ReasoningEffort.nullish(),
  env_keys: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]), // Git 模块源勾选（["<source_id>:<module_id>"]）
  skills: z.array(z.record(z.string(), z.unknown())).default([]),
  commands: z.array(z.record(z.string(), z.unknown())).default([]),
  mcps: z.array(z.record(z.string(), z.unknown())).default([]),
  subagents: z.array(z.record(z.string(), z.unknown())).default([]),
  prompt_suffix: z.string().nullish(),
  /** §6.2：绑定的 Provider Credential（与 env_keys 二选一；优先 Credential） */
  credential_id: z.string().uuid().nullish(),
});
const ProfilePatchBody = ProfileBody.partial();

// Git 模块源（§8.2）
const SkillSourceBody = z.object({
  name: z.string().min(1),
  repo_url: z.string().min(1),
  branch: z.string().default("main"),
});

// 项目设置：profiles 绑定（job 类型 → profile id）+ rules 覆盖（§8.1 决策层）
// roles.enabled：hub 可下发角色清单（name 数组；null = 恢复默认=全部内置）
const SettingsPatchBody = z.object({
  profiles: z.record(z.string(), z.string().nullable()).optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
  roles: z.object({ enabled: z.array(z.string()).nullable() }).optional(),
});

// 角色注册表（§8.3 Phase ②）：name 即 job.type；prompt_template 用 {{graph}} {{intent}} {{role}} 占位
const RoleBody = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, "小写字母开头的标识符"),
  title: z.string().default(""),
  description: z.string().default(""),
  prompt_template: z.string().min(10),
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
  // 代码来源（§10.1）：二选一，随画布 target_json 存档，执行时摄入进沙箱
  repo_url: z.string().trim().max(500).optional(),
  repo_path: z.string().trim().max(500).optional(),
  ref: z.string().trim().max(200).optional(),
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

/** Profile ↔ Credential 绑定（§6.2；purpose='llm'） */
async function bindCredential(profileId: string, credentialId: string) {
  const [cred] = await sql`SELECT id, status FROM credentials WHERE id = ${credentialId}`;
  if (!cred) throw new Error("credential not found");
  await sql`
    INSERT INTO profile_credentials ${sql({ profile_id: profileId, credential_id: credentialId, purpose: "llm" })}
    ON CONFLICT (profile_id, credential_id, purpose) DO NOTHING`;
}

export function registerRoutes(app: FastifyInstance) {
  // 平台 API Token 鉴权（SEC-01）：DFH_AUTH_REQUIRED=true 时生效；/health 与 /webhooks/plane 豁免
  app.addHook("onRequest", authHook);

  // Model Gateway（§6.3）：自身用 DFH_JOB_TOKEN 鉴权（authHook 豁免 /gateway/*）
  registerGateway(app);

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
        ...(body.repo_url ? { repo_url: body.repo_url } : {}),
        ...(body.repo_path ? { repo_path: body.repo_path } : {}),
        ...(body.ref ? { ref: body.ref } : {}),
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
      after: { title: body.title, canvas_id: canvasId, repo_url: body.repo_url ?? null, repo_path: body.repo_path ?? null },
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

  // 重试：新建 job 复用原画布（历史 job 保留；终态 job 永不被改回 pending）
  app.post("/tasks/:canvasId/retry", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const active = await sql`
      SELECT 1 FROM jobs WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
    if (active.length > 0) return reply.code(409).send({ error: "该任务仍有活动 job，不能重试" });
    const [source] = await sql`
      SELECT * FROM jobs WHERE canvas_id = ${canvasId} ORDER BY created_at ASC LIMIT 1`;
    if (!source) return reply.code(409).send({ error: "该任务还没有执行记录" });
    const { job, duplicated } = await createJob({
      projectId: canvas.project_id as string,
      canvasId,
      planeIssueId: (canvas.plane_issue_id as string) ?? undefined,
      type: source.type as string,
      payload: source.payload_json as Record<string, unknown>,
      priority: source.priority as number,
      timeoutSec: source.timeout_sec as number,
    });
    if (duplicated || !job) return reply.code(409).send({ error: "已有活动 job，不能重试" });
    await audit(req, {
      action: "job.retry",
      resourceType: "job",
      resourceId: job.id as string,
      projectId: canvas.project_id as string,
      after: { canvas_id: canvasId, retried_from: source.id },
    });
    return reply.code(201).send(job);
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

  // ---------- Agent profiles（§8.1 存储层 CRUD） ----------
  app.get("/agent-profiles", async () =>
    sql`SELECT p.*, pc.credential_id, c.provider AS credential_provider
        FROM agent_profiles p
        LEFT JOIN profile_credentials pc ON pc.profile_id = p.id AND pc.purpose = 'llm'
        LEFT JOIN credentials c ON c.id = pc.credential_id
        ORDER BY p.created_at DESC`);

  app.post("/agent-profiles", async (req, reply) => {
    const body = ProfileBody.parse(req.body);
    try {
      const [row] = await sql`
        INSERT INTO agent_profiles ${sql({
          name: body.name,
          agent_cli: body.agent_cli,
          model: body.model ?? null,
          reasoning: body.reasoning ?? null,
          env_keys: body.env_keys as never,
          modules_json: body.modules as never,
          skills_json: body.skills as never,
          commands_json: body.commands as never,
          mcps_json: body.mcps as never,
          subagents_json: body.subagents as never,
          prompt_suffix: body.prompt_suffix ?? null,
        })}
        RETURNING *`;
      if (body.credential_id) {
        await bindCredential(row.id as string, body.credential_id);
      }
      await audit(req, {
        action: "profile.create",
        resourceType: "agent_profile",
        resourceId: row.id as string,
        after: { name: row.name, agent_cli: row.agent_cli, credential_id: body.credential_id ?? null },
      });
      return reply.code(201).send(row);
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "同名 profile 已存在" });
      }
      throw e;
    }
  });

  app.patch("/agent-profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ProfilePatchBody.parse(req.body);
    const sets: Record<string, unknown> = { updated_at: sql`now()` };
    if (body.name !== undefined) sets.name = body.name;
    if (body.agent_cli !== undefined) sets.agent_cli = body.agent_cli;
    if (body.model !== undefined) sets.model = body.model;
    if (body.reasoning !== undefined) sets.reasoning = body.reasoning;
    if (body.env_keys !== undefined) sets.env_keys = body.env_keys;
    if (body.modules !== undefined) sets.modules_json = body.modules;
    if (body.skills !== undefined) sets.skills_json = body.skills;
    if (body.commands !== undefined) sets.commands_json = body.commands;
    if (body.mcps !== undefined) sets.mcps_json = body.mcps;
    if (body.subagents !== undefined) sets.subagents_json = body.subagents;
    if (body.prompt_suffix !== undefined) sets.prompt_suffix = body.prompt_suffix;
    const [row] = await sql`
      UPDATE agent_profiles SET ${sql(sets as never)} WHERE id = ${id} RETURNING *`;
    if (!row) return reply.code(404).send({ error: "profile not found" });
    if (body.credential_id !== undefined) {
      await sql`DELETE FROM profile_credentials WHERE profile_id = ${id} AND purpose = 'llm'`;
      if (body.credential_id) await bindCredential(id, body.credential_id);
      // Credential 绑定/解绑单独记一条（§7.2 必须记录项）
      await audit(req, {
        action: body.credential_id ? "credential.bind" : "credential.unbind",
        resourceType: "agent_profile",
        resourceId: id,
        after: { credential_id: body.credential_id ?? null },
      });
    }
    await audit(req, {
      action: "profile.update",
      resourceType: "agent_profile",
      resourceId: id,
      after: { changed: Object.keys(body).filter((k) => k !== "credential_id") },
    });
    return row;
  });

  app.delete("/agent-profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM agent_profiles WHERE id = ${id} RETURNING id, name`;
    if (!row) return reply.code(404).send({ error: "profile not found" });
    await audit(req, {
      action: "profile.delete",
      resourceType: "agent_profile",
      resourceId: id,
      before: { name: row.name },
    });
    return { ok: true };
  });

  // ---------- 角色注册表（§8.3：hub 可下发的 agent 类型，全局注册 + 项目级启用） ----------
  // kind='role'：hub 可下发角色；kind='system'：hub/audit/verify 系统 prompt 模板（也在这里改）
  app.get("/agent-roles", async () =>
    sql`SELECT id, name, title, description, prompt_template, builtin, kind, created_at, updated_at
        FROM agent_roles ORDER BY kind DESC, builtin DESC, name`,
  );

  app.post("/agent-roles", async (req, reply) => {
    const body = RoleBody.parse(req.body);
    try {
      const [row] = await sql`
        INSERT INTO agent_roles ${sql({ ...body, builtin: false, kind: "role" })}
        RETURNING id, name, title, description, prompt_template, builtin, kind`;
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
      RETURNING id, name, title, description, prompt_template, builtin, kind`;
    if (!row) return reply.code(404).send({ error: "role not found" });
    // Prompt 模板属「规则/Prompt 修改」必记项；模板内容长，只记哈希
    await audit(req, {
      action: "role.update",
      resourceType: "agent_role",
      resourceId: id,
      after: {
        name: row.name,
        changed: Object.keys(body),
        ...(body.prompt_template ? { prompt_sha256: createHash("sha256").update(body.prompt_template).digest("hex") } : {}),
      },
    });
    return row;
  });

  app.delete("/agent-roles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM agent_roles WHERE id = ${id} AND NOT builtin RETURNING id, name`;
    if (!row) return reply.code(409).send({ error: "内置角色不可删除（可编辑模板/描述）或角色不存在" });
    await audit(req, {
      action: "role.delete",
      resourceType: "agent_role",
      resourceId: id,
      before: { name: row.name },
    });
    return { ok: true };
  });

  // 项目视角的角色清单：全部角色 + 本项目启用状态 + 绑定的 profile
  app.get("/projects/:id/roles", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    const enabled = ((cfg.roles as Record<string, unknown> | undefined)?.enabled ?? null) as string[] | null;
    const bindings = (cfg.profiles ?? {}) as Record<string, string>;
    const all = await sql`
      SELECT id, name, title, description, prompt_template, builtin FROM agent_roles
      WHERE kind = 'role' ORDER BY builtin DESC, name`;
    const set = enabled == null ? null : new Set(enabled);
    return (all as unknown as { name: string; builtin: boolean }[]).map((r) => ({
      ...r,
      enabled: set == null ? r.builtin : set.has(r.name),
      default_enabled: enabled == null,
      profile_id: bindings[r.name] ?? null,
    }));
  });

  // ---------- 全局设置（§8.1 所有配置落库：规则默认值 → global_settings 单例行） ----------
  app.get("/global-settings", async () => {
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    return {
      rules: ((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>,
      effective_rules: await globalRules(sql),
    };
  });

  app.patch("/global-settings", async (req) => {
    const body = z.object({ rules: z.record(z.string(), z.unknown()) }).parse(req.body);
    const [g] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const merged = { ...(((g?.rules_json ?? {}) ?? {}) as Record<string, unknown>), ...body.rules };
    await sql`UPDATE global_settings SET rules_json = ${sql.json(merged as never)}, updated_at = now() WHERE id = 'global'`;
    // 全局规则修改是「全局规则修改」必记项
    await audit(req, {
      action: "settings.global_update",
      resourceType: "global_settings",
      resourceId: "global",
      after: { changed_keys: Object.keys(body.rules) },
    });
    return { rules: merged, effective_rules: await globalRules(sql) };
  });

  // ---------- 项目设置（§8.1 决策层：profiles 绑定 + rules 覆盖） ----------
  app.get("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    return {
      profiles: (cfg.profiles ?? {}) as Record<string, string>,
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
      roles: (cfg.roles ?? { enabled: null }) as Record<string, unknown>,
      effective_rules: await rulesForProject(sql, id),
    };
  });

  app.patch("/projects/:id/settings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = SettingsPatchBody.parse(req.body);
    const [p] = await sql`SELECT config_json FROM projects WHERE id = ${id}`;
    if (!p) return reply.code(404).send({ error: "project not found" });
    const cfg = (p.config_json ?? {}) as Record<string, unknown>;
    if (body.profiles) {
      const bindings = { ...((cfg.profiles as Record<string, unknown>) ?? {}) };
      for (const [k, v] of Object.entries(body.profiles)) {
        if (v === null) delete bindings[k]; // null = 解除绑定
        else bindings[k] = v;
      }
      cfg.profiles = bindings;
    }
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
    // 项目级 profiles 绑定 / rules 覆盖 / roles 启停都属配置修改
    await audit(req, {
      action: "settings.project_update",
      resourceType: "project",
      resourceId: id,
      projectId: id,
      after: { changed: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined) },
    });
    return {
      profiles: (cfg.profiles ?? {}) as Record<string, string>,
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
      roles: (cfg.roles ?? { enabled: null }) as Record<string, unknown>,
      effective_rules: await rulesForProject(sql, id),
    };
  });

  // ---------- 任务画布（§3.2：一任务一画布） ----------
  // 列表：项目下所有任务画布 + rollup 计数
  app.get("/projects/:id/canvases", async (req) => {
    const { id } = req.params as { id: string };
    return sql`
      SELECT c.id, c.title, c.plane_issue_id, c.target_json, c.created_at,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id) AS job_count,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id
           AND j.status IN ('claimed','provisioning','running','waiting_human')) AS active_count,
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
      ORDER BY c.created_at DESC`;
  });

  // 详情：单任务画布的节点与边
  app.get("/canvases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const [nodes, edges] = await Promise.all([
      sql`
        SELECT id, node_type, title, body_json, x, y, w, h, status, job_id, updated_at
        FROM canvas_nodes WHERE canvas_id = ${id} ORDER BY created_at`,
      sql`
        SELECT id, from_node_id, to_node_id, edge_type
        FROM canvas_edges WHERE canvas_id = ${id} ORDER BY created_at`,
    ]);
    return { canvas, canvas_id: id, nodes, edges };
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
    // 联表项目名 / 画布标题，前端列表页直接展示
    if (q.project_id && q.status) {
      return sql`
        SELECT j.id, j.project_id, j.canvas_id, j.plane_issue_id, j.type, j.status, j.priority, j.error,
               j.started_at, j.finished_at, j.created_at,
               p.name AS project_name, c.title AS canvas_title
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        LEFT JOIN canvases c ON c.id = j.canvas_id
        WHERE j.project_id = ${q.project_id} AND j.status = ${q.status}
        ORDER BY j.created_at DESC LIMIT 200`;
    }
    if (q.project_id) {
      return sql`
        SELECT j.id, j.project_id, j.canvas_id, j.plane_issue_id, j.type, j.status, j.priority, j.error,
               j.started_at, j.finished_at, j.created_at,
               p.name AS project_name, c.title AS canvas_title
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        LEFT JOIN canvases c ON c.id = j.canvas_id
        WHERE j.project_id = ${q.project_id}
        ORDER BY j.created_at DESC LIMIT 200`;
    }
    if (q.status) {
      return sql`
        SELECT j.id, j.project_id, j.canvas_id, j.plane_issue_id, j.type, j.status, j.priority, j.error,
               j.started_at, j.finished_at, j.created_at,
               p.name AS project_name, c.title AS canvas_title
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        LEFT JOIN canvases c ON c.id = j.canvas_id
        WHERE j.status = ${q.status}
        ORDER BY j.created_at DESC LIMIT 200`;
    }
    return sql`
      SELECT j.id, j.project_id, j.canvas_id, j.plane_issue_id, j.type, j.status, j.priority, j.error,
             j.started_at, j.finished_at, j.created_at,
             p.name AS project_name, c.title AS canvas_title
      FROM jobs j
      JOIN projects p ON p.id = j.project_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      ORDER BY j.created_at DESC LIMIT 200`;
  });

  // ---------- Findings 清单（可按项目 / 画布 / severity / 验证状态筛选） ----------
  // canvas_id：只看「本次任务」产出，不混入同项目其它任务
  app.get("/findings", async (req) => {
    const q = req.query as {
      project_id?: string;
      severity?: string;
      verify_status?: string;
      canvas_id?: string;
    };
    const projectId = q.project_id || null;
    const severity = q.severity || null;
    const verifyStatus = q.verify_status || null;
    const canvasId = q.canvas_id || null;
    return sql`
      SELECT f.id, f.project_id, f.job_id, f.node_id, f.fingerprint, f.title, f.severity,
             f.location, f.summary, f.verify_status, f.created_at,
             p.name AS project_name, j.canvas_id
      FROM findings f
      JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id
      WHERE (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)
        AND (${severity}::text IS NULL OR f.severity = ${severity})
        AND (${verifyStatus}::text IS NULL OR f.verify_status = ${verifyStatus})
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId})
      ORDER BY f.created_at DESC
      LIMIT 500`;
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

  // 取消（§8.3）：置 cancel 终态 + 立即停容器 + 画布节点同步；迟到 done 由 finalizeJob 守卫忽略
  app.post("/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await sql`
      UPDATE jobs SET status = 'cancelled', finished_at = now()
      WHERE id = ${id} AND status IN ('pending','claimed','provisioning','running','waiting_human')
      RETURNING id, status, sandbox_id, project_id`;
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
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent"]})`;
    await planeWriteback(id).catch(() => {});
    await audit(req, {
      action: "job.cancel",
      resourceType: "job",
      resourceId: id,
      projectId: (job.project_id as string) ?? null,
    });
    return { id: job.id, status: job.status };
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
    kind: z.enum(["llm_provider", "plane", "git"]).default("llm_provider"),
    provider: z.string().trim().min(1).max(50),
    secret: z.string().min(1).max(4096),
    project_id: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  });

  app.get("/credentials", async () =>
    sql`SELECT ${CRED_SAFE} FROM credentials ORDER BY created_at DESC`);

  /** 规范化 public metadata：base_url 去尾斜杠，空串删除 key */
  function normalizeCredentialMeta(raw: Record<string, unknown>): Record<string, unknown> {
    const meta = { ...raw };
    if (typeof meta.base_url === "string") {
      const u = meta.base_url.trim().replace(/\/+$/, "");
      if (u) meta.base_url = u;
      else delete meta.base_url;
    }
    return meta;
  }

  app.post("/credentials", async (req, reply) => {
    const body = CredentialBody.parse(req.body);
    if (!isProviderKnown(body.provider)) {
      return reply.code(400).send({ error: `未知 provider: ${body.provider}（固定映射表外的 provider 不允许登记）` });
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
      sets.public_metadata_json = normalizeCredentialMeta(body.metadata);
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

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
}
