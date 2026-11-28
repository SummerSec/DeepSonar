import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import type { KnowledgeDb } from "./types.js";
import { projectScopeAllows } from "../../project-scope.js";
import { validationHttpError } from "../../http-validation-error.js";
import {
  SOURCE_COLLECTED_ACTION,
  SOURCE_REGISTERED_ACTION,
  SOURCE_SKIPPED_ACTION,
} from "./knowledge-actions.js";

const Id = z.string().uuid();
const Page = z.object({ limit: z.coerce.number().int().min(1).max(20).default(10),
  offset: z.coerce.number().int().min(0).default(0) }).strict();

/**
 * 历史任务沉淀的只读入口（#1219 第四阶段第 3 步后仍保留）。
 *
 * 批量整理链已下线，但「某个任务曾经沉淀了什么」是历史事实，用户仍需要查到：
 * 这里只读 audit_logs 里的来源登记/采集/跳过记录与 closeout 投影状态，
 * **不判定资格、不触发任何整理、不写任何数据**。
 */
export function registerKnowledgeHistoryRoutes(app: FastifyInstance, deps: { db?: KnowledgeDb } = {}): void {
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
      const jobs = await db`SELECT jobs.id AS job_id, jobs.canvas_id, jobs.status, jobs.finished_at,
        closeout.root_ref AS closeout_root_ref, COALESCE(closeout.state,'legacy_preview') AS closeout_status,
        registered.at AS registered_at, collected.at AS collected_at,
        skipped.at AS skipped_at, skipped.reason AS skip_reason
        FROM jobs
        LEFT JOIN LATERAL (SELECT n.body_json->>'root_node_id' AS root_ref,n.body_json->>'state' AS state
          FROM canvas_nodes n JOIN canvas_nodes root ON root.canvas_id=n.canvas_id AND root.node_type='root'
            AND root.id::text=n.body_json->>'root_node_id'
          WHERE n.canvas_id=jobs.canvas_id AND n.node_type='knowledge_closeout' LIMIT 1) closeout ON true
        LEFT JOIN LATERAL (SELECT a.at FROM audit_logs a
          WHERE a.project_id=${projectId} AND a.resource_id=jobs.id::text AND a.action=${SOURCE_REGISTERED_ACTION}
          ORDER BY a.at DESC, a.id DESC LIMIT 1) registered ON true
        LEFT JOIN LATERAL (SELECT a.at FROM audit_logs a
          WHERE a.project_id=${projectId} AND a.resource_id=jobs.id::text AND a.action=${SOURCE_COLLECTED_ACTION}
          ORDER BY a.at DESC, a.id DESC LIMIT 1) collected ON true
        LEFT JOIN LATERAL (SELECT a.at, a.after_json->>'reason' AS reason FROM audit_logs a
          WHERE a.project_id=${projectId} AND a.resource_id=jobs.id::text AND a.action=${SOURCE_SKIPPED_ACTION}
          ORDER BY a.at DESC, a.id DESC LIMIT 1) skipped ON true
        WHERE jobs.project_id=${projectId}
        AND jobs.status IN ('succeeded','failed','timeout','cancelled','orphan','waiting_human')
        AND jobs.type NOT IN ('hub_reason','report')
        AND NOT EXISTS(SELECT 1 FROM project_knowledge_job_assignments a WHERE a.job_id=jobs.id)
        ORDER BY jobs.created_at DESC,jobs.id DESC LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
      const items = jobs.slice(0, page.limit).map((job) => {
        const registered = job.registered_at !== null;
        const reason = typeof job.skip_reason === "string" ? job.skip_reason : registered ? undefined : "no_sources";
        return {
          job_id: String(job.job_id), canvas_id: job.canvas_id, job_status: String(job.status),
          finished_at: job.finished_at, status: registered ? "eligible" : "skipped", reason,
          closeout_status: job.closeout_status, closeout_root_ref: job.closeout_root_ref,
          history: {
            registered_at: job.registered_at, collected_at: job.collected_at, skipped_at: job.skipped_at,
            collection: job.collected_at ? "collected" : job.skipped_at ? "skipped" : registered ? "registered" : "none",
          },
        };
      });
      return { items, next_offset: jobs.length > page.limit ? page.offset + page.limit : null };
    } catch (error) {
      const validation = validationHttpError(error);
      return validation ? reply.code(validation.statusCode).send(validation.body)
        : reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "历史沉淀查询失败" });
    }
  });
}
