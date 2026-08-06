import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import {
  drainNonGateVerifies,
  fixedPriorityForJob,
  maybeTriggerHub,
  parseCanvasConvergence,
  patchCanvasConvergence,
  readCanvasConvergence,
  resolveHubWaitSeverities,
  rulesForProject,
} from "../../core.js";
import { sql } from "../../db.js";
import { cursorForRow, decodeCursor, page, pageLimit } from "../../pagination.js";
import { buildCanvasDelta, cursorGap, parseCanvasRevision } from "../../canvas-delta.js";

const ACTIVE_JOB_STATUSES = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);

export function registerCanvasRoutes(app: FastifyInstance): void {
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
}
