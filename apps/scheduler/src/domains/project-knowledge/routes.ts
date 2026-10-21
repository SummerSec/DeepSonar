import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { actorHasScope } from "../../auth.js";
import { sql } from "../../db.js";
import { validationHttpError } from "../../http-validation-error.js";
import { projectScopeAllows } from "../../project-scope.js";
import { readKnowledgeBlob } from "./blobs.js";
import type { KnowledgeDb } from "./types.js";
import { approvedKnowledgeVersion } from "./grant-policy.js";

const Id = z.string().uuid();
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
const List = Page.extend({
  kind: z.enum(["memory", "skill"]).optional(),
  status: z.enum(["draft", "active", "stale", "retired", "revoked"]).optional(),
  query: z.string().trim().max(200).optional(),
});
const GrantBody = z.object({ grantee_project_id: Id }).strict();
const RevokeBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
const ReceiptList = Page.extend({ job_id: Id });

type Db = KnowledgeDb;
type Row = Record<string, unknown>;

function errorReply(reply: FastifyReply, error: unknown): FastifyReply {
  const validation = validationHttpError(error);
  if (validation) return reply.code(validation.statusCode).send(validation.body);
  // Never expose a database error or a referenced Evidence body to the client.
  return reply.code(500).send({ error_code: "KNOWLEDGE_MANAGEMENT_ERROR", error: "知识管理请求失败" });
}

function access(req: FastifyRequest, reply: FastifyReply, projectId: string, write = false): boolean {
  if (!projectScopeAllows(req.actor?.projectId ?? null, projectId)
    || !req.actor || !actorHasScope(req.actor, write ? "projects:write" : "projects:read")
    || (write && req.actor.role === "viewer")) {
    reply.code(403).send({ error_code: "KNOWLEDGE_SCOPE_DENIED", error: "项目知识访问被拒绝" });
    return false;
  }
  return true;
}

async function itemFor(db: Db, projectId: string, itemId: string): Promise<Row | undefined> {
  const [item] = await db`SELECT * FROM project_knowledge_items WHERE project_id=${projectId} AND id=${itemId}`;
  return item as Row | undefined;
}

async function versionFor(db: Db, projectId: string, itemId: string, versionId: string): Promise<Row | undefined> {
  const [version] = await db`SELECT * FROM project_knowledge_versions
    WHERE project_id=${projectId} AND item_id=${itemId} AND id=${versionId}`;
  return version as Row | undefined;
}

async function itemDetail(db: Db, projectId: string, itemId: string) {
  const item = await itemFor(db, projectId, itemId);
  if (!item) return null;
  const versions = await db`SELECT id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,
      governance_hash,revoked_at,revoked_reason,created_at
    FROM project_knowledge_versions WHERE project_id=${projectId} AND item_id=${itemId}
    ORDER BY version DESC LIMIT 51`;
  const proposals = await db`SELECT p.id,p.work_id,p.action,p.state,p.revision,p.parent_proposal_id,
      p.candidate_version_id,p.maker_job_id,p.base_refs_json,p.evaluation_plan_json,p.reason,p.created_at
    FROM project_knowledge_proposals p
    WHERE p.project_id=${projectId} AND
      (p.candidate_version_id IN (SELECT id FROM project_knowledge_versions WHERE project_id=${projectId} AND item_id=${itemId})
       OR p.base_refs_json @> ${db.json([{ item_ref: itemId }])})
    ORDER BY p.created_at DESC LIMIT 50`;
  const proposalIds = proposals.map((row) => row.id as string);
  const evaluations = proposalIds.length
    ? await db`SELECT id,proposal_id,proposal_revision,kind,actor_job_id,input_digest,result_json,created_at
        FROM project_knowledge_evaluations WHERE project_id=${projectId} AND proposal_id IN ${db(proposalIds)}
        ORDER BY created_at DESC LIMIT 100`
    : [];
  const usages = await db`SELECT id,job_id,attempt_id,selector,content_sha256,version_id,feedback_json,created_at
    FROM project_knowledge_usages WHERE project_id=${projectId} AND owner_project_id=${projectId}
      AND version_id IN (SELECT id FROM project_knowledge_versions WHERE project_id=${projectId} AND item_id=${itemId})
    ORDER BY created_at DESC LIMIT 100`;
  return { ...item, versions: versions.slice(0, 50), versions_next_offset: versions.length > 50 ? 50 : null,
    proposals, evaluations, usages };
}

/** Routes are locally scoped too; auth.ts must additionally register their route scopes. */
export function registerProjectKnowledgeRoutes(
  app: FastifyInstance,
  deps: { db?: Db; recordAudit?: typeof audit } = {},
): void {
  const db = deps.db ?? sql;
  const recordAudit = deps.recordAudit ?? audit;
  app.get("/projects/:id/knowledge", async (req, reply) => {
    try {
      const projectId = Id.parse((req.params as { id: string }).id);
      if (!access(req, reply, projectId)) return;
      const input = List.parse(req.query);
      const pattern = input.query ? `%${input.query.replace(/[\\%_]/g, "\\$&")}%` : null;
      const rows = await db`SELECT i.id,i.project_id,i.kind,i.logical_key,i.title,i.keywords_json,
          i.status,i.active_version_id,i.generation,i.created_at,i.updated_at,
          v.version,v.content_sha256
        FROM project_knowledge_items i
        LEFT JOIN project_knowledge_versions v ON v.id=i.active_version_id AND v.project_id=i.project_id
        WHERE i.project_id=${projectId}
          AND (${input.kind ?? null}::text IS NULL OR i.kind=${input.kind ?? null})
          AND (${input.status ?? null}::text IS NULL OR i.status=${input.status ?? null})
          AND (${pattern}::text IS NULL OR i.title ILIKE ${pattern} ESCAPE '\\' OR i.logical_key ILIKE ${pattern} ESCAPE '\\')
        ORDER BY i.updated_at DESC,i.id DESC LIMIT ${input.limit + 1} OFFSET ${input.offset}`;
      return { items: rows.slice(0, input.limit), next_offset: rows.length > input.limit ? input.offset + input.limit : null };
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/receipts", async (req, reply) => {
    try {
      const projectId = Id.parse((req.params as { id: string }).id);
      if (!access(req, reply, projectId)) return;
      const input = ReceiptList.parse(req.query);
      const rows = await db`SELECT r.id,r.job_id,r.attempt_id,r.operation,r.idempotency_key,r.input_digest,
          r.state,r.result_json,r.event_id,r.created_at,r.settled_at
        FROM project_knowledge_receipts r JOIN jobs j ON j.id=r.job_id AND j.project_id=r.project_id
        WHERE r.project_id=${projectId} AND r.job_id=${input.job_id}
        ORDER BY r.created_at DESC,r.id DESC LIMIT ${input.limit + 1} OFFSET ${input.offset}`;
      return { items: rows.slice(0, input.limit), next_offset: rows.length > input.limit ? input.offset + input.limit : null };
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/receipts/:receiptId", async (req, reply) => {
    try {
      const { id, receiptId } = req.params as { id: string; receiptId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      const [row] = await db`SELECT r.id,r.job_id,r.attempt_id,r.operation,r.idempotency_key,r.input_digest,
          r.state,r.result_json,r.event_id,r.created_at,r.settled_at
        FROM project_knowledge_receipts r JOIN jobs j ON j.id=r.job_id AND j.project_id=r.project_id
        WHERE r.project_id=${projectId} AND r.id=${Id.parse(receiptId)}`;
      return row ?? reply.code(404).send({ error_code: "KNOWLEDGE_RECEIPT_NOT_FOUND" });
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/:itemId", async (req, reply) => {
    try {
      const { id, itemId } = req.params as { id: string; itemId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      return await itemDetail(db, projectId, Id.parse(itemId))
        ?? reply.code(404).send({ error_code: "KNOWLEDGE_ITEM_NOT_FOUND" });
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/:itemId/versions", async (req, reply) => {
    try {
      const { id, itemId } = req.params as { id: string; itemId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      const item = await itemFor(db, projectId, Id.parse(itemId));
      if (!item) return reply.code(404).send({ error_code: "KNOWLEDGE_ITEM_NOT_FOUND" });
      const page = Page.parse(req.query);
      const rows = await db`SELECT id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,
          governance_hash,revoked_at,revoked_reason,created_at
        FROM project_knowledge_versions WHERE project_id=${projectId} AND item_id=${itemId}
        ORDER BY version DESC LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
      return { items: rows.slice(0, page.limit), next_offset: rows.length > page.limit ? page.offset + page.limit : null };
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/:itemId/versions/:versionId", async (req, reply) => {
    try {
      const { id, itemId, versionId } = req.params as { id: string; itemId: string; versionId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      const item = await itemFor(db, projectId, Id.parse(itemId));
      const version = await versionFor(db, projectId, Id.parse(itemId), Id.parse(versionId));
      if (!item || !version) return reply.code(404).send({ error_code: "KNOWLEDGE_VERSION_NOT_FOUND" });
      // Only the owning project can inspect historical content. Source refs remain opaque.
      const candidate = await readKnowledgeBlob(db, String(version.content_sha256));
      return { ...version, item: { id: item.id, kind: item.kind, title: item.title, logical_key: item.logical_key }, candidate };
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/:itemId/versions/:versionId/grants", async (req, reply) => {
    try {
      const { id, itemId, versionId } = req.params as { id: string; itemId: string; versionId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      if (!await versionFor(db, projectId, Id.parse(itemId), Id.parse(versionId))) {
        return reply.code(404).send({ error_code: "KNOWLEDGE_VERSION_NOT_FOUND" });
      }
      return await db`SELECT id,owner_project_id,item_id,version_id,grantee_project_id,granted_by,revoked_at,created_at
        FROM project_knowledge_grants WHERE owner_project_id=${projectId} AND item_id=${itemId} AND version_id=${versionId}
        ORDER BY created_at DESC LIMIT 100`;
    } catch (error) { return errorReply(reply, error); }
  });

  app.post("/projects/:id/knowledge/:itemId/versions/:versionId/grants", async (req, reply) => {
    try {
      const { id, itemId, versionId } = req.params as { id: string; itemId: string; versionId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId, true)) return;
      const body = GrantBody.parse(req.body);
      if (body.grantee_project_id === projectId) return reply.code(400).send({ error_code: "KNOWLEDGE_GRANT_SELF" });
      const [grantee] = await db`SELECT id FROM projects WHERE id=${body.grantee_project_id} AND status<>'archived'`;
      if (!grantee) return reply.code(404).send({ error_code: "KNOWLEDGE_GRANTEE_NOT_FOUND" });
      const result = await db.begin(async (tx) => {
        // The version lock serializes grant creation with version revocation.
        const [version] = await tx`SELECT v.id,v.revoked_at,i.kind FROM project_knowledge_versions v
          JOIN project_knowledge_items i ON i.project_id=v.project_id AND i.id=v.item_id
          WHERE v.project_id=${projectId} AND v.item_id=${Id.parse(itemId)}
            AND v.id=${Id.parse(versionId)} FOR UPDATE OF v`;
        if (!version) return { state: "missing" as const };
        if (version.kind !== "skill" || version.revoked_at) return { state: "denied" as const };
        if (!(await approvedKnowledgeVersion(tx as unknown as Db, projectId, versionId))) return { state: "denied" as const };
        const [grant] = await tx`INSERT INTO project_knowledge_grants
          (owner_project_id,item_id,version_id,grantee_project_id,granted_by)
          VALUES(${projectId},${itemId},${versionId},${body.grantee_project_id},${req.actor!.name})
          ON CONFLICT (version_id,grantee_project_id) WHERE revoked_at IS NULL DO NOTHING
          RETURNING id,owner_project_id,item_id,version_id,grantee_project_id,granted_by,revoked_at,created_at`;
        return grant ? { state: "created" as const, grant } : { state: "exists" as const };
      });
      if (result.state === "missing") return reply.code(404).send({ error_code: "KNOWLEDGE_VERSION_NOT_FOUND" });
      if (result.state === "denied") return reply.code(409).send({ error_code: "KNOWLEDGE_GRANT_DENIED" });
      if (result.state === "exists") return reply.code(409).send({ error_code: "KNOWLEDGE_GRANT_EXISTS" });
      const grant = result.grant;
      await recordAudit(req, { action: "project_knowledge.grant", projectId, resourceType: "project_knowledge_grant",
        resourceId: String(grant.id), after: { item_id: itemId, version_id: versionId, grantee_project_id: body.grantee_project_id } });
      return reply.code(201).send(grant);
    } catch (error) { return errorReply(reply, error); }
  });

  app.post("/projects/:id/knowledge/grants/:grantId/revoke", async (req, reply) => {
    try {
      const { id, grantId } = req.params as { id: string; grantId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId, true)) return;
      const [grant] = await db`UPDATE project_knowledge_grants SET revoked_at=now()
        WHERE owner_project_id=${projectId} AND id=${Id.parse(grantId)} AND revoked_at IS NULL
        RETURNING id,item_id,version_id,grantee_project_id,revoked_at`;
      if (!grant) return reply.code(404).send({ error_code: "KNOWLEDGE_GRANT_NOT_ACTIVE" });
      await recordAudit(req, { action: "project_knowledge.grant_revoke", projectId, resourceType: "project_knowledge_grant",
        resourceId: String(grant.id), after: { item_id: grant.item_id, version_id: grant.version_id,
          grantee_project_id: grant.grantee_project_id, revoked_at: grant.revoked_at } });
      return grant;
    } catch (error) { return errorReply(reply, error); }
  });

  app.post("/projects/:id/knowledge/:itemId/versions/:versionId/revoke", async (req, reply) => {
    try {
      const { id, itemId, versionId } = req.params as { id: string; itemId: string; versionId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId, true)) return;
      const body = RevokeBody.parse(req.body);
      const result = await db.begin(async (tx) => {
        const [version] = await tx`UPDATE project_knowledge_versions
          SET revoked_at=now(),revoked_reason=${body.reason}
          WHERE project_id=${projectId} AND item_id=${Id.parse(itemId)}
            AND id=${Id.parse(versionId)} AND revoked_at IS NULL
          RETURNING id,item_id,version,revoked_at,revoked_reason`;
        if (!version) return null;
        await tx`UPDATE project_knowledge_grants SET revoked_at=now()
          WHERE owner_project_id=${projectId} AND version_id=${versionId} AND revoked_at IS NULL`;
        await tx`UPDATE project_knowledge_items SET status='revoked',active_version_id=NULL,
          generation=generation+1,updated_at=now()
          WHERE project_id=${projectId} AND id=${itemId} AND active_version_id=${versionId}`;
        return version;
      });
      if (!result) return reply.code(404).send({ error_code: "KNOWLEDGE_VERSION_NOT_ACTIVE" });
      await recordAudit(req, { action: "project_knowledge.version_revoke", projectId,
        resourceType: "project_knowledge_version", resourceId: versionId,
        after: { item_id: itemId, version: result.version, reason: body.reason } });
      return result;
    } catch (error) { return errorReply(reply, error); }
  });
}
