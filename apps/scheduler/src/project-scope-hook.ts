import type { FastifyReply, FastifyRequest } from "fastify";
import { sql } from "./db.js";
import {
  canvasScopeDecision,
  isProjectScopedActor,
  isUuid,
  PROJECT_MISMATCH,
  PROJECT_SCOPE_FORBIDDEN,
  projectScopeAllows,
} from "./project-scope.js";

/** Central ownership guard for project-scoped tokens. Resource UUIDs are not
 * authorization: resolve their project_id server-side before any handler
 * reads or mutates a canvas/job/export/import, and constrain list queries. */
export async function projectScopeHook(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
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
  if (routeUrl.startsWith("/exports/:id") && !isUuid(params.id)) {
    return reply.code(400).send({ error: "invalid export id", error_code: "INVALID_ID" });
  }
  if (routeUrl.startsWith("/imports/:id") && !isUuid(params.id)) {
    return reply.code(400).send({ error: "invalid import id", error_code: "INVALID_ID" });
  }
  if (routeUrl.startsWith("/canvases/:id/nodes/:nodeId") && !isUuid(params.nodeId)) {
    return reply.code(400).send({ error: "invalid canvas node id", error_code: "INVALID_ID" });
  }
  if (routeUrl.startsWith("/canvases/:id/facts/:nodeId") && !isUuid(params.nodeId)) {
    return reply.code(400).send({ error: "invalid Fact node id", error_code: "INVALID_ID" });
  }
  const query = (req.query ?? {}) as { project_id?: string; canvas_id?: string };
  if ((routeUrl === "/jobs" || routeUrl === "/findings" || routeUrl === "/dashboard/usage" || routeUrl === "/dashboard/quality" || routeUrl === "/dashboard/quality/replay") && query.project_id && !isUuid(query.project_id)) {
    return reply.code(400).send({ error: "invalid project id", error_code: "INVALID_ID" });
  }
  if ((routeUrl === "/jobs" || routeUrl === "/findings" || routeUrl === "/dashboard/usage" || routeUrl === "/dashboard/quality" || routeUrl === "/dashboard/quality/replay") && query.canvas_id && !isUuid(query.canvas_id)) {
    return reply.code(400).send({ error: "invalid canvas id", error_code: "INVALID_ID" });
  }
  const actorProjectId = req.actor?.projectId;
  if (routeUrl === "/jobs" && req.method === "POST" && actorProjectId) {
    const bodyProjectId = (req.body as { project_id?: string } | undefined)?.project_id;
    if (bodyProjectId && bodyProjectId !== actorProjectId) {
      return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: PROJECT_MISMATCH });
    }
  }
  if (isProjectScopedActor(actorProjectId) && routeUrl.startsWith("/platform/exports")) {
    return reply.code(403).send({
      error: "project-scoped actors may not access platform transfer jobs",
      error_code: PROJECT_SCOPE_FORBIDDEN,
    });
  }
  if ((routeUrl === "/jobs" || routeUrl === "/findings" || routeUrl === "/dashboard/usage" || routeUrl === "/dashboard/quality" || routeUrl === "/dashboard/quality/replay") && query.canvas_id) {
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
  if (routeUrl.startsWith("/projects/:id")) {
    const projectId = params.id;
    if (projectId && !projectScopeAllows(actorProjectId, projectId)) {
      return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: PROJECT_MISMATCH });
    }
    return;
  }
  if (routeUrl.startsWith("/exports/:id")) {
    const exportId = params.id;
    if (!exportId) return;
    const [exp] = await sql`SELECT project_id, scope FROM data_exports WHERE id = ${exportId}`;
    if (!exp) return;
    if (exp.scope === "platform" || !projectScopeAllows(actorProjectId, exp.project_id as string | null)) {
      return reply.code(403).send({
        error: exp.scope === "platform"
          ? "project-scoped actors may not access platform exports"
          : "token 仅限项目 " + actorProjectId,
        error_code: exp.scope === "platform" ? PROJECT_SCOPE_FORBIDDEN : PROJECT_MISMATCH,
      });
    }
    return;
  }
  if (routeUrl.startsWith("/imports/:id")) {
    const importId = params.id;
    if (!importId) return;
    const [imp] = await sql`SELECT target_project_id, scope FROM data_imports WHERE id = ${importId}`;
    if (!imp) return;
    if (imp.scope === "platform" || !projectScopeAllows(actorProjectId, imp.target_project_id as string | null)) {
      return reply.code(403).send({
        error: imp.scope === "platform"
          ? "project-scoped actors may not access platform imports"
          : "token 仅限项目 " + actorProjectId,
        error_code: imp.scope === "platform" ? PROJECT_SCOPE_FORBIDDEN : PROJECT_MISMATCH,
      });
    }
    return;
  }
  if (routeUrl.startsWith("/reports/:id/")) {
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
  if ((routeUrl === "/jobs" || routeUrl === "/findings") && query.project_id && query.project_id !== actorProjectId) {
    return reply.code(403).send({ error: "token 仅限项目 " + actorProjectId, error_code: "PROJECT_MISMATCH" });
  }
}
