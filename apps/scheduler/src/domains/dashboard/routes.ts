import type { FastifyInstance } from "fastify";
import { loadDashboardOverview } from "./overview.js";

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get("/dashboard/overview", async (req) =>
    loadDashboardOverview(req.actor?.projectId ?? null));
}
