import type { FastifyInstance } from "fastify";
import { sql } from "../../db.js";
import { isUuid } from "../../project-scope.js";

export function registerFindingResearchRoutes(app: FastifyInstance): void {
  app.get("/canvases/:id/finding-research", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) {
      return reply.code(400).send({ error: "invalid canvas id", error_code: "INVALID_ID" });
    }
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${id}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found", error_code: "NOT_FOUND" });
    const [runs, clusters] = await Promise.all([
      sql`
        SELECT id, kind, status, batch_limit, model, prompt_revision, input_json, result_json,
               error, created_at, finished_at
        FROM finding_research_runs
        WHERE canvas_id = ${id}
        ORDER BY created_at DESC
        LIMIT 50`,
      sql`
        SELECT c.id, c.canonical_finding_id, c.created_at, c.updated_at,
               f.title AS canonical_title, f.verify_status, f.severity
        FROM finding_dedupe_clusters c
        JOIN findings f ON f.id = c.canonical_finding_id
        WHERE c.canvas_id = ${id}
        ORDER BY c.updated_at DESC`,
    ]);
    const members = clusters.length === 0
      ? []
      : await sql`
          SELECT r.finding_id, r.dedupe_cluster_id, r.canonical_finding_id, r.is_canonical,
                 r.dedupe_reason, r.priority_score, r.priority_reason, r.priority_model,
                 r.priority_prompt_revision, r.last_run_id, f.title, f.verify_status, f.severity
          FROM finding_research r
          JOIN findings f ON f.id = r.finding_id
          WHERE r.canvas_id = ${id}
          ORDER BY r.is_canonical DESC, r.priority_score DESC NULLS LAST, f.created_at`;
    return {
      canvas_id: id,
      project_id: canvas.project_id,
      runs,
      clusters,
      members,
    };
  });
}
