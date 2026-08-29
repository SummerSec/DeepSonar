import type { FastifyInstance } from "fastify";
import { loadDashboardOverview } from "./overview.js";
import { loadDashboardUsage, resolveUsageWindow } from "./usage.js";

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get("/dashboard/overview", async (req) =>
    loadDashboardOverview(req.actor?.projectId ?? null));

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
      return reply.code(403).send({
        error: "token 仅限项目 " + actorProjectId,
        error_code: "PROJECT_MISMATCH",
      });
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
}
