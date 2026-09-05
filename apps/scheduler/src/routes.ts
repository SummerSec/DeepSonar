import type { FastifyInstance } from "fastify";
import { authHook } from "./auth.js";
import { sql } from "./db.js";
import { registerGateway } from "./gateway.js";
import { canvasScopeDecision, isUuid, projectScopeAllows } from "./project-scope.js";
import { registerApiTokenRoutes } from "./domains/api-token/routes.js";
import { registerAuditRoutes } from "./domains/audit/routes.js";
import { registerAuthRoutes } from "./domains/auth/routes.js";
import { registerCanvasRoutes } from "./domains/canvas/routes.js";
import { registerDashboardRoutes } from "./domains/dashboard/routes.js";
import { registerCredentialRoutes } from "./domains/credential/routes.js";
import { registerFindingVerificationRoutes } from "./domains/finding-verification/routes.js";
import { registerJobControlRoutes } from "./domains/job-control/routes.js";
import { registerProjectTaskRoutes } from "./domains/project-task/routes.js";
import { registerReportRoutes } from "./domains/report-convergence/routes.js";
import { registerRoleConfigRoutes } from "./domains/role-config/routes.js";
import { registerRuntimeImageRoutes } from "./domains/runtime-image/routes.js";
import { registerSettingsRoutes } from "./domains/settings/routes.js";
import { registerSharedAssetRoutes } from "./domains/shared-assets/routes.js";
import { registerSkillSourceRoutes } from "./domains/skill-source/routes.js";
import { registerStreamRoutes } from "./domains/stream/routes.js";
import { registerSystemRoutes } from "./domains/system/routes.js";
import { registerTransferRoutes } from "./domains/transfer/routes.js";
import { registerPlatformControlRoutes } from "./domains/platform-api/routes.js";
import { runtimeImageHttpError } from "./runtime-images.js";

export { parseConcurrencyRulesPatch } from "./domains/settings/routes.js";
export { RuntimeImageRegistryChannelBody } from "./domains/runtime-image/routes.js";

export function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((error, _req, reply) => {
    const mapped = runtimeImageHttpError(error);
    if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
    return reply.send(error);
  });
  // 平台 API Token 鉴权（SEC-01）：DEEPSONAR_AUTH_REQUIRED=true 时生效；/health 豁免
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
    if (routeUrl.startsWith("/canvases/:id/facts/:nodeId") && !isUuid(params.nodeId)) {
      return reply.code(400).send({ error: "invalid Fact node id", error_code: "INVALID_ID" });
    }
    const query = (req.query ?? {}) as { project_id?: string; canvas_id?: string };
    if ((routeUrl === "/jobs" || routeUrl === "/findings" || routeUrl === "/dashboard/usage") && query.project_id && !isUuid(query.project_id)) {
      return reply.code(400).send({ error: "invalid project id", error_code: "INVALID_ID" });
    }
    if ((routeUrl === "/jobs" || routeUrl === "/findings" || routeUrl === "/dashboard/usage") && query.canvas_id && !isUuid(query.canvas_id)) {
      return reply.code(400).send({ error: "invalid canvas id", error_code: "INVALID_ID" });
    }
    const actorProjectId = req.actor?.projectId;
    if ((routeUrl === "/jobs" || routeUrl === "/findings" || routeUrl === "/dashboard/usage") && query.canvas_id) {
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

  // Job-scoped Platform Tool API. Its routes are exempt from the platform
  // authHook because they perform their own independent capability-token
  // authentication and never accept a management API token.
  registerPlatformControlRoutes(app);

  registerAuthRoutes(app);

  registerStreamRoutes(app);

  registerProjectTaskRoutes(app);
  registerDashboardRoutes(app);
  registerSkillSourceRoutes(app);
  registerRuntimeImageRoutes(app);

  registerRoleConfigRoutes(app);

  registerSettingsRoutes(app);

  registerCanvasRoutes(app);

  registerJobControlRoutes(app);

  registerApiTokenRoutes(app);

  registerCredentialRoutes(app);

  registerAuditRoutes(app);
  registerTransferRoutes(app);
  registerSystemRoutes(app);
}
