import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import { projectScopeAllows } from "../../project-scope.js";
import { validationHttpError } from "../../http-validation-error.js";
import { KnowledgeOperationError, type KnowledgeDb } from "./types.js";
import { requestCloseoutEvaluation } from "./closeout-evaluation.js";
import { readTaskKnowledgeCloseout } from "./closeout-preview.js";

const Id = z.string().uuid();
const Page = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10),
  offset: z.coerce.number().int().min(0).default(0) }).strict();

/** #1219 P4 第一步：任务沉淀的两个路由从旧采集模块搬出来，采集链退役时不会被误删。 */
export function registerTaskKnowledgeCloseoutRoutes(app: FastifyInstance, deps: { db?: KnowledgeDb } = {}): void {
  const db = deps.db ?? sql;
  app.post("/projects/:id/knowledge/closeout/:rootId/evaluate", async (req, reply) => {
    try {
      const { id, rootId } = req.params as { id: string; rootId: string };
      const projectId = Id.parse(id).toLowerCase();
      if (!req.actor || req.actor.role === "viewer" || !projectScopeAllows(req.actor.projectId, projectId)
        || !actorHasScope(req.actor, "projects:write") || !actorHasScope(req.actor, "projects:read")
        || !actorHasScope(req.actor, "tasks:read"))
        return reply.code(403).send({ error_code: "KNOWLEDGE_SCOPE_DENIED" });
      const body = z.object({ candidate_ref: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
      const result = await requestCloseoutEvaluation(db, req, projectId, Id.parse(rootId).toLowerCase(), body.candidate_ref);
      return reply.code(202).send(result);
    } catch (error) {
      const validation = validationHttpError(error);
      if (validation) return reply.code(validation.statusCode).send(validation.body);
      if (error instanceof KnowledgeOperationError) return reply.code(409).send({ error_code: error.error_code });
      return reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "知识候选送评失败" });
    }
  });
  app.get("/projects/:id/knowledge/closeout/:rootId", async (req, reply) => {
    try {
      const { id, rootId } = req.params as { id: string; rootId: string };
      const projectId = Id.parse(id);
      if (!req.actor || !projectScopeAllows(req.actor.projectId, projectId) || !actorHasScope(req.actor, "projects:read"))
        return reply.code(403).send({ error_code: "KNOWLEDGE_SCOPE_DENIED" });
      const closeout = await readTaskKnowledgeCloseout(db, projectId, Id.parse(rootId).toLowerCase(), {
        sources: actorHasScope(req.actor, "tasks:read"),
        evaluate: req.actor.role !== "viewer" && actorHasScope(req.actor, "projects:write"),
      }, Page.parse(req.query));
      return closeout ?? reply.code(404).send({ error_code: "KNOWLEDGE_CLOSEOUT_NOT_FOUND" });
    } catch (error) {
      const validation = validationHttpError(error);
      return validation ? reply.code(validation.statusCode).send(validation.body)
        : reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "知识沉淀详情读取失败" });
    }
  });
}
