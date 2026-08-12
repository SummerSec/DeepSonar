import type { FastifyInstance } from "fastify";
import { audit } from "../../audit.js";
import { sql } from "../../db.js";
import {
  createFindingReport,
  getFindingReport,
  getFindingReportById,
  getTaskReport,
  getTaskReportAvailability,
  getTaskReportById,
  listTaskReports,
  readReportBlob,
  refreshTaskReport,
  retryReport,
} from "../../report.js";

function reportDownloadFilename(reportId: string, extension: "md" | "sarif"): string {
  const safeId = reportId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
  return `report-${safeId}.${extension}`;
}

/** Report route adapter; shared auth/ownership hooks remain on the parent app. */
export function registerReportRoutes(app: FastifyInstance): void {
  app.get("/canvases/:id/reports", async (req) => {
    const { id } = req.params as { id: string };
    return listTaskReports(id);
  });

  app.get("/canvases/:id/report/availability", async (req) => {
    const { id } = req.params as { id: string };
    return getTaskReportAvailability(id);
  });

  app.get("/canvases/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await getTaskReport(id);
    if (!report) {
      const availability = await getTaskReportAvailability(id);
      return reply.code(404).send({ error: "report not found", ...availability });
    }
    return report;
  });

  app.get("/findings/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await getFindingReport(id);
    if (!report) return reply.code(404).send({ error: "finding report not found" });
    return report;
  });

  app.post("/findings/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [finding] = await sql`SELECT id, project_id, verify_status FROM findings WHERE id = ${id}`;
    if (!finding) return reply.code(404).send({ error: "finding not found" });
    if (finding.verify_status !== "confirmed") {
      return reply.code(409).send({ error: "finding_not_confirmed", verify_status: finding.verify_status });
    }
    const result = await createFindingReport(id, true);
    await audit(req, {
      action: "finding.report.create",
      resourceType: "finding",
      resourceId: id,
      projectId: finding.project_id as string,
      after: result,
    });
    if (!result.dispatched && !["report_in_flight", "already_succeeded"].includes(result.reason ?? "")) {
      return reply.code(409).send(result);
    }
    return result;
  });

  app.get("/reports/:id/markdown", async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await getTaskReportById(id) ?? await getFindingReportById(id);
    if (!report) return reply.code(404).send({ error: "report not found" });
    if (report.status !== "succeeded" || !report.markdown_uri) {
      return reply.code(409).send({ error: "report not ready", status: report.status });
    }
    try {
      const buf = await readReportBlob(report.markdown_uri as string);
      return reply
        .type("text/markdown; charset=utf-8")
        .header("content-disposition", `attachment; filename="${reportDownloadFilename(id, "md")}"`)
        .send(buf);
    } catch {
      return reply.code(404).send({ error: "markdown blob missing" });
    }
  });

  app.get("/reports/:id/sarif", async (req, reply) => {
    const { id } = req.params as { id: string };
    const report = await getTaskReportById(id);
    if (!report) return reply.code(404).send({ error: "report not found" });
    if (report.status !== "succeeded" || !report.sarif_uri) {
      return reply.code(409).send({ error: "report not ready", status: report.status });
    }
    try {
      const buf = await readReportBlob(report.sarif_uri as string);
      JSON.parse(buf.toString("utf8"));
      return reply
        .type("application/sarif+json; charset=utf-8")
        .header("content-disposition", `attachment; filename="${reportDownloadFilename(id, "sarif")}"`)
        .send(buf);
    } catch {
      return reply.code(404).send({ error: "sarif blob missing" });
    }
  });

  app.post("/canvases/:id/report/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const result = await retryReport(id);
    await audit(req, {
      action: "report.retry",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
      after: result,
    });
    if (!result.ok) return reply.code(409).send(result);
    await sql`SELECT pg_notify('deepsonar_jobs', 'report_retry')`;
    return result;
  });

  app.post("/canvases/:id/report/refresh", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const result = await refreshTaskReport(id);
    await audit(req, {
      action: "report.refresh",
      resourceType: "canvas",
      resourceId: id,
      projectId: canvas.project_id as string,
      after: result,
    });
    if (!result.ok) return reply.code(409).send(result);
    if (result.report_id) await sql`SELECT pg_notify('deepsonar_jobs', 'report_refresh')`;
    return result;
  });
}
