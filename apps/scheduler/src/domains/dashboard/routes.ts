import type { FastifyInstance, FastifyReply } from "fastify";
import { sql } from "../../db.js";
import { projectScopeAllows } from "../../project-scope.js";
import { loadDashboardOps } from "./ops.js";
import { loadDashboardOverview } from "./overview.js";
import { buildQualityReport, loadQualityContext, type QualityScope } from "./quality.js";
import { buildReplayBaseline, parseReplayLimit } from "./replay.js";
import { loadDashboardUsage, resolveUsageWindow } from "./usage.js";

function projectMismatch(reply: FastifyReply, actorProjectId: string) {
  return reply.code(403).send({
    error: "token 仅限项目 " + actorProjectId,
    error_code: "PROJECT_MISMATCH",
  });
}

function dashboardScope(
  actorProjectId: string | null,
  query: { project_id?: string; canvas_id?: string },
): QualityScope {
  const projectId = actorProjectId ?? query.project_id ?? null;
  const canvasId = query.canvas_id ?? null;
  return {
    kind: canvasId ? "task" : projectId ? "project" : "global",
    project_id: projectId,
    canvas_id: canvasId,
  };
}

async function sendQuality(scope: QualityScope) {
  const context = await loadQualityContext(scope);
  return buildQualityReport(context);
}

async function sendReplay(scope: QualityScope, limit: unknown) {
  const context = await loadQualityContext(scope);
  return buildReplayBaseline(context, parseReplayLimit(limit));
}

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get("/dashboard/overview", async (req) =>
    loadDashboardOverview(req.actor?.projectId ?? null));

  app.get("/dashboard/ops", async (req) =>
    loadDashboardOps(req.actor?.projectId ?? null));

  app.get("/dashboard/usage", async (req, reply) => {
    const query = (req.query ?? {}) as {
      period?: string;
      from?: string;
      to?: string;
      project_id?: string;
      canvas_id?: string;
    };
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && query.project_id && actorProjectId !== query.project_id) {
      return projectMismatch(reply, actorProjectId);
    }
    const window = resolveUsageWindow({ period: query.period, from: query.from, to: query.to });
    if ("error_code" in window) {
      return reply.code(400).send({ error: window.error, error_code: window.error_code });
    }
    return loadDashboardUsage({
      window,
      projectId: actorProjectId ?? query.project_id ?? null,
      canvasId: query.canvas_id ?? null,
    });
  });

  app.get("/dashboard/quality", async (req, reply) => {
    const query = (req.query ?? {}) as { project_id?: string; canvas_id?: string };
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && query.project_id && actorProjectId !== query.project_id) {
      return projectMismatch(reply, actorProjectId);
    }
    return sendQuality(dashboardScope(actorProjectId, query));
  });

  app.get("/dashboard/quality/replay", async (req, reply) => {
    const query = (req.query ?? {}) as { project_id?: string; canvas_id?: string; limit?: string };
    const actorProjectId = req.actor?.projectId ?? null;
    if (actorProjectId && query.project_id && actorProjectId !== query.project_id) {
      return projectMismatch(reply, actorProjectId);
    }
    return sendReplay(dashboardScope(actorProjectId, query), query.limit);
  });

  app.get("/projects/:id/quality", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    if (!projectScopeAllows(actorProjectId, id)) return projectMismatch(reply, actorProjectId!);
    const [project] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found", error_code: "NOT_FOUND" });
    return sendQuality({ kind: "project", project_id: id, canvas_id: null });
  });

  app.get("/projects/:id/quality/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const actorProjectId = req.actor?.projectId ?? null;
    if (!projectScopeAllows(actorProjectId, id)) return projectMismatch(reply, actorProjectId!);
    const query = (req.query ?? {}) as { limit?: string };
    const [project] = await sql`SELECT id FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found", error_code: "NOT_FOUND" });
    return sendReplay({ kind: "project", project_id: id, canvas_id: null }, query.limit);
  });

  app.get("/canvases/:id/quality", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found", error_code: "NOT_FOUND" });
    return sendQuality({ kind: "task", project_id: String(canvas.project_id), canvas_id: id });
  });

  app.get("/canvases/:id/quality/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = (req.query ?? {}) as { limit?: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found", error_code: "NOT_FOUND" });
    return sendReplay({ kind: "task", project_id: String(canvas.project_id), canvas_id: id }, query.limit);
  });
}
