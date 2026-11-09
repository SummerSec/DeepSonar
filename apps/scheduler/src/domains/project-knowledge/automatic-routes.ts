import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "../../audit.js";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import { projectScopeAllows } from "../../project-scope.js";
import { validationHttpError } from "../../http-validation-error.js";
import { inspectAutomaticKnowledgeJob, queueAutomaticKnowledgeWork } from "./automatic.js";
import { PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./platform-skills.js";
import type { KnowledgeDb } from "./types.js";

const Id = z.string().uuid();
const Page = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10),
  offset: z.coerce.number().int().min(0).default(0) }).strict();
const Request = z.object({
  job_ids: z.array(Id).min(1).max(5).refine((ids) => new Set(ids).size === ids.length, "Job IDs must be unique"),
  reason: z.string().trim().min(1).max(2000),
}).strict();

function access(req: FastifyRequest, reply: FastifyReply, projectId: string, write: boolean): boolean {
  if (!req.actor || !projectScopeAllows(req.actor.projectId, projectId)
    || !actorHasScope(req.actor, write ? "projects:write" : "projects:read")
    || (write && req.actor.role === "viewer")) {
    reply.code(403).send({ error_code: "KNOWLEDGE_SCOPE_DENIED", error: "项目知识访问被拒绝" });
    return false;
  }
  return true;
}

function failure(reply: FastifyReply, error: unknown): FastifyReply {
  const validation = validationHttpError(error);
  return validation ? reply.code(validation.statusCode).send(validation.body)
    : reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "知识补做请求失败" });
}

export function registerAutomaticKnowledgeRoutes(app: FastifyInstance,
  deps: { db?: KnowledgeDb; recordAudit?: typeof audit } = {}): void {
  const db = deps.db ?? sql;
  const recordAudit = deps.recordAudit ?? audit;
  app.get("/projects/:id/knowledge/backfill", async (req, reply) => {
    try {
      const projectId = Id.parse((req.params as { id: string }).id);
      if (!access(req, reply, projectId, false)) return;
      const page = Page.parse(req.query);
      const [project] = await db`SELECT id FROM projects WHERE id=${projectId}`;
      if (!project) return reply.code(404).send({ error_code: "KNOWLEDGE_PROJECT_NOT_FOUND" });
      const jobs = await db`SELECT id,type,status,finished_at FROM jobs WHERE project_id=${projectId}
        AND status IN ('succeeded','failed','timeout','cancelled','orphan','waiting_human')
        AND type NOT IN ('hub_reason','report')
        AND NOT EXISTS(SELECT 1 FROM project_knowledge_job_assignments a WHERE a.job_id=jobs.id)
        ORDER BY created_at DESC,id DESC LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
      const items = [];
      for (const job of jobs.slice(0, page.limit)) {
        const inspection = await inspectAutomaticKnowledgeJob(db, projectId, String(job.id));
        const [work] = inspection.work_ref ? await db`SELECT id,state,stage,reason,job_count,updated_at
          FROM project_knowledge_work WHERE id=${inspection.work_ref} AND project_id=${projectId}` : [];
        items.push({ ...job, job_status: job.status, ...inspection, ...(work ? { work } : {}) });
      }
      return { items, next_offset: jobs.length > page.limit ? page.offset + page.limit : null };
    } catch (error) { return failure(reply, error); }
  });

  app.post("/projects/:id/knowledge/backfill", async (req, reply) => {
    try {
      const projectId = Id.parse((req.params as { id: string }).id);
      if (!access(req, reply, projectId, true)) return;
      const body = Request.parse(req.body);
      const result = await db.begin(async (raw) => {
        const tx = raw as unknown as KnowledgeDb;
        const jobs = await tx`SELECT id,canvas_id FROM jobs
          WHERE project_id=${projectId} AND id IN ${tx(body.job_ids)} ORDER BY id`;
        if (jobs.length !== body.job_ids.length) return null;
        // Lock every Canvas first, then every Job, before touching any work.
        const canvases = [...new Set(jobs.map((job) => job.canvas_id).filter(Boolean).map(String))].sort();
        for (const canvasId of canvases) await tx`SELECT id FROM canvases WHERE id=${canvasId} FOR UPDATE`;
        for (const job of jobs) {
          const [current] = await tx`SELECT canvas_id FROM jobs WHERE id=${String(job.id)} FOR UPDATE`;
          if (!current || current.canvas_id !== job.canvas_id) throw new Error("source_canvas_changed");
        }
        const items = [];
        for (const job of jobs) items.push(await queueAutomaticKnowledgeWork(tx, projectId,
          String(job.id), PROJECT_KNOWLEDGE_GOVERNANCE_HASH));
        return items;
      });
      if (!result) {
        await recordAudit(req, { action: "project_knowledge.backfill", projectId,
          resourceType: "project", resourceId: projectId, result: "denied",
          errorCode: "KNOWLEDGE_SOURCE_NOT_FOUND", after: { requested_count: body.job_ids.length } });
        return reply.code(404).send({ error_code: "KNOWLEDGE_SOURCE_NOT_FOUND" });
      }
      await recordAudit(req, { action: "project_knowledge.backfill", projectId,
        resourceType: "project", resourceId: projectId,
        after: { jobs: result, reason_sha256: createHash("sha256").update(body.reason).digest("hex") } });
      return { items: result };
    } catch (error) { return failure(reply, error); }
  });
}
