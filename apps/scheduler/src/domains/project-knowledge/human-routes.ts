import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { actorHasScope } from "../../auth.js";
import { validationHttpError } from "../../http-validation-error.js";
import { projectScopeAllows } from "../../project-scope.js";
import { KnowledgeCandidate } from "@deepsonar/shared-types";
import {
  archiveHumanKnowledgeItem, createHumanKnowledgeItem, restoreHumanKnowledgeItem, reviseHumanKnowledgeItem,
  type KnowledgeAuthor, type KnowledgeRevisionInput,
} from "./human-knowledge.js";
import { KnowledgeOperationError, type KnowledgeDb } from "./types.js";

const Id = z.string().uuid();
const Keywords = z.array(z.string().trim().min(1).max(80)).max(20).optional();
const CreateBody = z.object({
  kind: z.enum(["memory", "skill"]),
  logical_key: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
  title: z.string().trim().min(1).max(200),
  keywords: Keywords,
  content: z.string().optional(),
  files: z.unknown().optional(),
}).strict();
const ReviseBody = z.object({
  expected_version: z.coerce.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  keywords: Keywords,
  content: z.string().optional(),
  files: z.unknown().optional(),
}).strict();

function access(req: FastifyRequest, reply: FastifyReply, projectId: string): boolean {
  if (!projectScopeAllows(req.actor?.projectId ?? null, projectId)
    || !req.actor || !actorHasScope(req.actor, "projects:write") || req.actor.role === "viewer") {
    reply.code(403).send({ error_code: "KNOWLEDGE_SCOPE_DENIED", error: "项目知识访问被拒绝" });
    return false;
  }
  return true;
}

function reply_(reply: FastifyReply, error: unknown): FastifyReply {
  const validation = validationHttpError(error);
  if (validation) return reply.code(validation.statusCode).send(validation.body);
  if (error instanceof KnowledgeOperationError) {
    const statusCode = error.error_code === "KNOWLEDGE_ITEM_NOT_FOUND" ? 404 : 409;
    return reply.code(statusCode).send({ error_code: error.error_code, error: error.message, next_action: error.next_action });
  }
  return reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "知识管理请求失败" });
}

function authorOf(req: FastifyRequest, projectId: string): KnowledgeAuthor {
  const name = req.actor?.name ?? "unknown";
  return { projectId, id: req.actor?.id ?? name, name };
}

/** #1256：人类在项目内维护知识的四个入口；全部要求 projects:write 且非 viewer。 */
export function registerHumanKnowledgeRoutes(
  app: FastifyInstance,
  deps: { db: KnowledgeDb; recordAudit?: typeof audit } = {} as never,
): void {
  const db = deps.db;
  const recordAudit = deps.recordAudit ?? audit;

  app.post("/projects/:id/knowledge", async (req, reply) => {
    const projectId = Id.parse((req.params as { id: string }).id);
    if (!access(req, reply, projectId)) return reply;
    try {
      const body = CreateBody.parse(req.body ?? {});
      const candidate = KnowledgeCandidate.parse({ ...body, keywords: body.keywords ?? [] });
      const result = await createHumanKnowledgeItem(db, authorOf(req, projectId), candidate);
      await recordAudit(req, { action: "project_knowledge.create", projectId, resourceType: "project_knowledge_item",
        resourceId: result.item_ref, after: { version: result.version, kind: body.kind, logical_key: body.logical_key } });
      return reply.code(201).send(result);
    } catch (error) { return reply_(reply, error); }
  });

  app.post("/projects/:id/knowledge/:itemId/versions", async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const projectId = Id.parse(id);
    const parsedItem = Id.parse(itemId);
    if (!access(req, reply, projectId)) return reply;
    try {
      const body = ReviseBody.parse(req.body ?? {});
      const [item] = await db`SELECT id FROM project_knowledge_items WHERE project_id=${projectId} AND id=${parsedItem}`;
      if (!item) return reply.code(404).send({ error_code: "KNOWLEDGE_ITEM_NOT_FOUND" });
      // 关键词不传＝沿用基准版本；只有显式 keywords: [] 才清空。
      const revision: KnowledgeRevisionInput = {
        title: body.title,
        ...(body.keywords === undefined ? {} : { keywords: body.keywords }),
        ...(body.content === undefined ? {} : { content: body.content }),
        ...(body.files === undefined ? {} : { files: body.files }),
      };
      const result = await reviseHumanKnowledgeItem(db, authorOf(req, projectId), parsedItem, body.expected_version, revision);
      await recordAudit(req, { action: "project_knowledge.revise", projectId, resourceType: "project_knowledge_item",
        resourceId: parsedItem, after: { version: result.version, expected_version: body.expected_version } });
      return reply.code(201).send(result);
    } catch (error) { return reply_(reply, error); }
  });

  app.post("/projects/:id/knowledge/:itemId/archive", async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const projectId = Id.parse(id);
    const parsedItem = Id.parse(itemId);
    if (!access(req, reply, projectId)) return reply;
    try {
      const result = await archiveHumanKnowledgeItem(db, authorOf(req, projectId), parsedItem);
      await recordAudit(req, { action: "project_knowledge.archive", projectId, resourceType: "project_knowledge_item",
        resourceId: parsedItem, after: { status: result.status } });
      return result;
    } catch (error) { return reply_(reply, error); }
  });

  app.post("/projects/:id/knowledge/:itemId/restore", async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const projectId = Id.parse(id);
    const parsedItem = Id.parse(itemId);
    if (!access(req, reply, projectId)) return reply;
    try {
      const result = await restoreHumanKnowledgeItem(db, authorOf(req, projectId), parsedItem);
      await recordAudit(req, { action: "project_knowledge.restore", projectId, resourceType: "project_knowledge_item",
        resourceId: parsedItem, after: { status: result.status } });
      return result;
    } catch (error) { return reply_(reply, error); }
  });
}
