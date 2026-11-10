import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import { projectScopeAllows } from "../../project-scope.js";
import { validationHttpError } from "../../http-validation-error.js";
import type { KnowledgeDb } from "./types.js";
import { inspectAutomaticKnowledgeJob } from "./automatic.js";

const Id = z.string().uuid();
const Page = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10),
  offset: z.coerce.number().int().min(0).default(0) }).strict();

export function registerAutomaticKnowledgeRoutes(app: FastifyInstance, deps: { db?: KnowledgeDb } = {}): void {
  const db = deps.db ?? sql;
  app.get("/projects/:id/knowledge/backfill", async (req, reply) => {
    try {
      const projectId = Id.parse((req.params as { id: string }).id);
      if (!req.actor || !projectScopeAllows(req.actor.projectId, projectId)
        || !actorHasScope(req.actor, "projects:read")) {
        return reply.code(403).send({ error_code: "KNOWLEDGE_SCOPE_DENIED" });
      }
      const page = Page.parse(req.query);
      const [project] = await db`SELECT id FROM projects WHERE id=${projectId}`;
      if (!project) return reply.code(404).send({ error_code: "KNOWLEDGE_PROJECT_NOT_FOUND" });
      const jobs = await db`SELECT id,type,status,finished_at FROM jobs WHERE project_id=${projectId}
        AND status IN ('succeeded','failed','timeout','cancelled','orphan','waiting_human')
        AND type NOT IN ('hub_reason','report')
        AND NOT EXISTS(SELECT 1 FROM project_knowledge_job_assignments a WHERE a.job_id=jobs.id)
        ORDER BY created_at DESC,id DESC LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
      const items = [];
      for (const job of jobs.slice(0, page.limit)) items.push({ ...job, job_status: job.status,
        ...await inspectAutomaticKnowledgeJob(db, projectId, String(job.id)) });
      return { items, next_offset: jobs.length > page.limit ? page.offset + page.limit : null };
    } catch (error) {
      const validation = validationHttpError(error);
      return validation ? reply.code(validation.statusCode).send(validation.body)
        : reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "知识补做预览失败" });
    }
  });
}
