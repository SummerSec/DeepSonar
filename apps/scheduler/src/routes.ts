import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { createJob } from "./core.js";
import { sql } from "./db.js";
import { planePollOnce } from "./plane-sync.js";

const SyncProjectBody = z.object({
  plane_project_id: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

const CreateJobBody = z.object({
  project_id: z.string().uuid(),
  plane_issue_id: z.string().optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().default(0),
  timeout_sec: z.number().int().positive().optional(),
});

export function registerRoutes(app: FastifyInstance) {
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

  // ---------- 画布（§7 GET /projects/{id}/canvas；§6.4 列表不含大字段） ----------
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
    const { job, duplicated } = await createJob({
      projectId: body.project_id,
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
    const conditions = [
      q.project_id ? sql`project_id = ${q.project_id}` : null,
      q.status ? sql`status = ${q.status}` : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    const where =
      conditions.length === 0
        ? sql``
        : sql`WHERE ${conditions.reduce((acc, c) => sql`${acc} AND ${c}`)}`;
    return sql`
      SELECT id, project_id, plane_issue_id, type, status, priority, error,
             started_at, finished_at, created_at
      FROM jobs ${where}
      ORDER BY created_at DESC LIMIT 200`;
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
