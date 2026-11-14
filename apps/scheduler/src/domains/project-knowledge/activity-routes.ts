import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import { validationHttpError } from "../../http-validation-error.js";
import { projectScopeAllows } from "../../project-scope.js";
import { readKnowledgeActivity } from "./activity.js";
import type { KnowledgeDb } from "./types.js";

const Id = z.string().uuid();
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
}).strict();

/** Local authorization remains mandatory in addition to the central route scope. */
export function registerKnowledgeActivityRoutes(app: FastifyInstance, deps: { db?: KnowledgeDb } = {}): void {
  const db = deps.db ?? sql;
  app.get("/projects/:id/knowledge/activity", async (req, reply) => {
    try {
      const projectId = Id.parse((req.params as { id: string }).id);
      if (!req.actor || !projectScopeAllows(req.actor.projectId, projectId) || !actorHasScope(req.actor, "projects:read")) {
        return reply.code(403).send({ error_code: "KNOWLEDGE_SCOPE_DENIED", error: "项目知识访问被拒绝" });
      }
      const page = Page.parse(req.query);
      const [project] = await db`SELECT id FROM projects WHERE id=${projectId}`;
      if (!project) return reply.code(404).send({ error_code: "KNOWLEDGE_PROJECT_NOT_FOUND" });
      return await readKnowledgeActivity(db, projectId, page);
    } catch (error) {
      const validation = validationHttpError(error);
      return validation ? reply.code(validation.statusCode).send(validation.body)
        : reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "知识积累与复用进展读取失败" });
    }
  });
}
