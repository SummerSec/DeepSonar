import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import { projectScopeAllows } from "../../project-scope.js";
import { validationHttpError } from "../../http-validation-error.js";
import { KnowledgeOperationError, type KnowledgeDb } from "./types.js";
import { requestCloseoutEvaluation } from "./closeout-evaluation.js";
import { inspectAutomaticKnowledgeJob } from "./automatic.js";
import { readTaskKnowledgeCloseout } from "./closeout-preview.js";

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
      const jobs = await db`SELECT id,type,status,finished_at,
        closeout.root_ref AS closeout_root_ref, COALESCE(closeout.state,'legacy_preview') AS closeout_status FROM jobs
        LEFT JOIN LATERAL (SELECT n.body_json->>'root_node_id' AS root_ref,n.body_json->>'state' AS state
          FROM canvas_nodes n JOIN canvas_nodes root ON root.canvas_id=n.canvas_id AND root.node_type='root'
            AND root.id::text=n.body_json->>'root_node_id'
          WHERE n.canvas_id=jobs.canvas_id AND n.node_type='knowledge_closeout' LIMIT 1) closeout ON true
        WHERE project_id=${projectId}
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
