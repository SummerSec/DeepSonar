import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { createJob, ensureCanvasForTask, rulesForProject } from "./core.js";
import { sql } from "./db.js";
import { planePollOnce } from "./plane-sync.js";
import { syncSkillSource } from "./skill-sources.js";
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
const ProfileBody = z.object({
  name: z.string().min(1),
  agent_cli: z.enum(["claude-code", "open-code", "codex"]).default("claude-code"),
  model: z.string().nullish(),
  env_keys: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]), // Git 模块源勾选（["<source_id>:<module_id>"]）
  skills: z.array(z.record(z.string(), z.unknown())).default([]),
  commands: z.array(z.record(z.string(), z.unknown())).default([]),
  mcps: z.array(z.record(z.string(), z.unknown())).default([]),
  subagents: z.array(z.record(z.string(), z.unknown())).default([]),
  prompt_suffix: z.string().nullish(),
});
const ProfilePatchBody = ProfileBody.partial();

// Git 模块源（§8.2）
const SkillSourceBody = z.object({
  name: z.string().min(1),
  repo_url: z.string().min(1),
  branch: z.string().default("main"),
});

// 项目设置：profiles 绑定（job 类型 → profile id）+ rules 覆盖（§8.1 决策层）
const SettingsPatchBody = z.object({
  profiles: z.record(z.string(), z.string().nullable()).optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
});

export function registerRoutes(app: FastifyInstance) {
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

  // ---------- Git 模块源（§8.2） ----------
  app.get("/skill-sources", async () =>
    sql`SELECT id, name, repo_url, branch, synced_at, created_at,
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
    try {
      const [row] = await sql`
        INSERT INTO skill_sources ${sql({ name: body.name, repo_url: body.repo_url, branch: body.branch })}
        RETURNING id, name, repo_url, branch, synced_at, created_at`;
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
      const r = await syncSkillSource(id);
      return { ok: true, ...r };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/skill-sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM skill_sources WHERE id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: "source not found" });
    return { ok: true };
  });

  // ---------- Agent profiles（§8.1 存储层 CRUD） ----------
  app.get("/agent-profiles", async () =>
    sql`SELECT * FROM agent_profiles ORDER BY created_at DESC`);

  app.post("/agent-profiles", async (req, reply) => {
    const body = ProfileBody.parse(req.body);
    try {
      const [row] = await sql`
        INSERT INTO agent_profiles ${sql({
          name: body.name,
          agent_cli: body.agent_cli,
          model: body.model ?? null,
          env_keys: body.env_keys as never,
          modules_json: body.modules as never,
          skills_json: body.skills as never,
          commands_json: body.commands as never,
          mcps_json: body.mcps as never,
          subagents_json: body.subagents as never,
          prompt_suffix: body.prompt_suffix ?? null,
        })}
        RETURNING *`;
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
    return row;
  });

  app.delete("/agent-profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM agent_profiles WHERE id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: "profile not found" });
    return { ok: true };
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
    await sql`UPDATE projects SET config_json = ${sql.json(cfg as never)} WHERE id = ${id}`;
    return {
      profiles: (cfg.profiles ?? {}) as Record<string, string>,
      rules: (cfg.rules ?? {}) as Record<string, unknown>,
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
        (SELECT COUNT(*)::int FROM canvas_nodes n WHERE n.canvas_id = c.id AND n.node_type = 'finding' AND n.status = 'confirmed') AS confirmed_count
      FROM canvases c WHERE c.project_id = ${id}
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

  app.post("/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await sql`
      UPDATE jobs SET status = 'cancelled', finished_at = now()
      WHERE id = ${id} AND status IN ('pending','claimed','provisioning','running','waiting_human')
      RETURNING id, status`;
    if (!job) return reply.code(409).send({ error: "job 不在可取消状态" });
    return job;
  });

  // 人工处理后恢复（§4.4）：waiting_human → pending 重入队
  app.post("/jobs/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await sql`
      UPDATE jobs SET status = 'pending', error = NULL, lease_expires_at = NULL
      WHERE id = ${id} AND status IN ('waiting_human','orphan','failed','timeout')
      RETURNING id, status`;
    if (!job) return reply.code(409).send({ error: "job 不在可恢复状态" });
    return job;
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

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
}
