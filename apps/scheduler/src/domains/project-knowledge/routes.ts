import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TASK_KNOWLEDGE_SUGGESTION_OPERATION } from "@deepsonar/shared-types";
import { audit } from "../../audit.js";
import { actorHasScope, type Actor } from "../../auth.js";
import { readableVersionKeysJson, readableVersionSources } from "./version-visibility.js";
import { sql } from "../../db.js";
import { validationHttpError } from "../../http-validation-error.js";
import { projectScopeAllows } from "../../project-scope.js";
import { readKnowledgeBlob } from "./blobs.js";
import type { KnowledgeDb } from "./types.js";
import { CLOSEOUT_EVALUATION_PREFIX } from "./closeout-evaluation-key.js";
import { actorMayReadGovernanceSources, resolveSourceOwners } from "./source-scope.js";
import { approvedKnowledgeVersion } from "./grant-policy.js";
import { registerAutomaticKnowledgeRoutes } from "./automatic-routes.js";
import { registerTaskKnowledgeCloseoutRoutes } from "./closeout-routes.js";
import { registerKnowledgeActivityRoutes } from "./activity-routes.js";

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
// #1256：评价明细按版本读取；unrated 表示读过但没有分类评价。
const FeedbackList = Page.extend({ outcome: z.enum(["success", "failure", "inapplicable", "unrated"]).optional() });

type Db = KnowledgeDb;
type Row = Record<string, unknown>;

function publicReceipt(row: Row): Row {
  if (row.operation !== TASK_KNOWLEDGE_SUGGESTION_OPERATION) return row;
  return { ...row, result_json: { accepted: true, operation: row.operation, receipt_ref: row.id, receipt_status: row.state } };
}

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

// Evaluation-only drafts use the existing version store, but stay private to the
// source-checked closeout detail. A revision must not hide the existing active item.
/** 无权读原始资料的人看不到受限版本的来源字段（#1286）。 */
function redactVersionSources(rows: Row[], actor: Actor | undefined): Row[] {
  if (actor && actorHasScope(actor, "tasks:read")) return rows;
  return rows.map((row) => {
    const { sources_json: _sources, creator_job_id: _job, creator_attempt_id: _attempt, ...rest } = row;
    // SAFETY: 只是删掉三个已知键，剩余键仍来自同一行查询结果（Row），结构不变。
    return rest as Row;
  });
}

function publicKnowledgeVersion(db: Db) {
  return db`NOT EXISTS (SELECT 1 FROM project_knowledge_proposals p JOIN project_knowledge_work w ON w.id=p.work_id
    WHERE p.project_id=v.project_id AND p.candidate_version_id=v.id AND w.trigger_key LIKE ${CLOSEOUT_EVALUATION_PREFIX + "%"})`;
}

function publicKnowledgeItem(db: Db) {
  return db`(i.active_version_id IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM project_knowledge_versions v WHERE v.project_id=i.project_id AND v.item_id=i.id AND NOT (${publicKnowledgeVersion(db)})))`;
}

async function itemFor(db: Db, projectId: string, itemId: string): Promise<Row | undefined> {
  const [item] = await db`SELECT i.* FROM project_knowledge_items i WHERE i.project_id=${projectId} AND i.id=${itemId} AND ${publicKnowledgeItem(db)}`;
  return item as Row | undefined;
}

async function versionFor(db: Db, projectId: string, itemId: string, versionId: string,
  actor?: Actor): Promise<Row | undefined> {
  const keysText = await readableVersionKeysJson(db, actor, projectId);
  const [version] = await db`SELECT v.* FROM project_knowledge_versions v
    WHERE v.project_id=${projectId} AND v.item_id=${itemId} AND v.id=${versionId} AND ${publicKnowledgeVersion(db)}
      AND ${readableVersionSources(db, keysText)}`;
  return version as Row | undefined;
}

async function itemDetail(db: Db, projectId: string, itemId: string, actor?: Actor) {
  const item = await itemFor(db, projectId, itemId);
  if (!item) return null;
  const keysText = await readableVersionKeysJson(db, actor, projectId);
  // 活跃版本整版受限时，整个条目连带标题都不再暴露（不是只藏来源字段）。
  if (item.active_version_id) {
    const [visible] = await db`SELECT ${readableVersionSources(db, keysText)} AS ok
      FROM project_knowledge_versions v WHERE v.id=${String(item.active_version_id)}`;
    if (!visible?.ok) return null;
  }
  const versions = await db`SELECT id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,
      governance_hash,revoked_at,revoked_reason,created_at
    FROM project_knowledge_versions v WHERE v.project_id=${projectId} AND v.item_id=${itemId} AND ${publicKnowledgeVersion(db)}
      AND ${readableVersionSources(db, keysText)}
    ORDER BY version DESC LIMIT 51`;
  const visibleVersions = redactVersionSources(versions as Row[], actor);
  // #1286：关联信息同样以「通过授权的版本」为边界，不能从全部历史版本取数。
  const visibleIds = (versions as Row[]).map((row) => String(row.id)).join("\u0001");
  // 条目关联、候选与基线都在 SQL 里先过滤，再排序取页：较新的不可见提案不会挤掉较旧的可读提案。
  const proposals = await db`SELECT p.id,p.work_id,p.action,p.state,p.revision,p.parent_proposal_id,
      p.candidate_version_id,p.maker_job_id,p.base_refs_json,p.evaluation_plan_json,p.reason,p.created_at
    FROM project_knowledge_proposals p JOIN project_knowledge_work w ON w.id=p.work_id
    WHERE p.project_id=${projectId} AND w.trigger_key NOT LIKE ${CLOSEOUT_EVALUATION_PREFIX + "%"}
      AND (
        p.candidate_version_id = ANY(
          CASE WHEN ${visibleIds} = '' THEN ARRAY[]::uuid[] ELSE string_to_array(${visibleIds}, chr(1))::uuid[] END)
        OR p.base_refs_json @> jsonb_build_array(jsonb_build_object('item_ref', ${itemId}::text))
      )
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.base_refs_json)='array' THEN p.base_refs_json ELSE '[]'::jsonb END) b
        WHERE (b->>'item_ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND NOT EXISTS (
            SELECT 1 FROM project_knowledge_versions v
            WHERE v.project_id = p.project_id AND v.item_id = (b->>'item_ref')::uuid
              AND v.id = CASE WHEN (b->>'version_ref') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (b->>'version_ref')::uuid END
              AND ${readableVersionSources(db, keysText)}
          )
      )
    ORDER BY p.created_at DESC LIMIT 50`;
  const proposalIds = proposals.map((row) => row.id as string);
  const evaluations = proposalIds.length
    ? await db`SELECT id,proposal_id,proposal_revision,kind,actor_job_id,input_digest,result_json,created_at
        FROM project_knowledge_evaluations WHERE project_id=${projectId} AND proposal_id IN ${db(proposalIds)}
        ORDER BY created_at DESC LIMIT 100`
    : [];
  const usages = visibleIds
    ? await db`SELECT id,job_id,attempt_id,selector,content_sha256,version_id,feedback_json,created_at
      FROM project_knowledge_usages WHERE project_id=${projectId} AND owner_project_id=${projectId}
        AND version_id = ANY(string_to_array(${visibleIds}, chr(1))::uuid[])
      ORDER BY created_at DESC LIMIT 100`
    : [];
  return { ...item, versions: visibleVersions.slice(0, 50), versions_next_offset: versions.length > 50 ? 50 : null,
    proposals, evaluations, usages };
}

/** 评价 JSON 是不可信历史内容，只读已知字段，缺失即 null。 */
function recordField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const field = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : null;
}

/** #1256 复核：明细与计数必须绑定同一 version_id，且只统计本项目 owner 的使用记录；同 hash 双版本绝不混票。 */
async function readVersionFeedbackRows(db: Db, projectId: string, versionId: string, contentSha256: string,
  outcome: "success" | "failure" | "inapplicable" | "unrated" | null, limit: number, offset: number,
): Promise<{ counts: FeedbackCounts; rows: Row[] }> {
  const counts = await readVersionFeedbackCounts(db, projectId, versionId, contentSha256);
  const rows = await db<Array<Row>>`
    SELECT u.id,u.job_id,u.created_at,u.feedback_json
    FROM project_knowledge_usages u
    WHERE u.project_id=${projectId} AND u.version_id=${versionId}
      AND u.owner_project_id=${projectId}
      AND (${outcome}::text IS NULL
        OR (${outcome}::text = 'unrated' AND u.feedback_json IS NULL)
        OR u.feedback_json->>'outcome'=${outcome})
    ORDER BY u.created_at DESC,u.id DESC LIMIT ${limit + 1} OFFSET ${offset}`;
  return { counts, rows };
}

/** #1256：一个版本的三类评价计数与未评价数，供卡片与明细共用。 */
async function readVersionFeedbackCounts(db: Db, projectId: string, versionId: string, knownHash: string): Promise<FeedbackCounts> {
  // #1256 复核：同一 content_sha256 可能同时属于两个版本，计票必须绑定 version_id；
  // owner_project_id 限定只统计本项目自己的使用，不把消费方的票或理由混进来。
  const rows = await db<Array<{ outcome: string | null; count: number }>>`
    SELECT feedback_json->>'outcome' AS outcome, count(*)::int AS count
    FROM project_knowledge_usages WHERE project_id=${projectId} AND version_id=${versionId}
      AND owner_project_id=${projectId} AND content_sha256=${knownHash}
    GROUP BY feedback_json->>'outcome'`;
  const counts: FeedbackCounts = { total: 0, success: 0, failure: 0, inapplicable: 0, unrated: 0 };
  for (const row of rows) {
    counts.total += Number(row.count);
    if (row.outcome === "success") counts.success += Number(row.count);
    else if (row.outcome === "failure") counts.failure += Number(row.count);
    else if (row.outcome === "inapplicable") counts.inapplicable += Number(row.count);
    else counts.unrated += Number(row.count);
  }
  return counts;
}

/** #1256：卡片要的一句话结论与三类评价计数；一次批量聚合，不随页大小增加往返。 */
type FeedbackCounts = { total: number; success: number; failure: number; inapplicable: number; unrated: number };
const EMPTY_FEEDBACK: FeedbackCounts = { total: 0, success: 0, failure: 0, inapplicable: 0, unrated: 0 };
const CARD_SUMMARY_READ_LIMIT = 50;

async function knowledgeCardFacts(db: Db, projectId: string, rows: Row[]): Promise<{
  summaries: Map<string, string>; feedback: Map<string, FeedbackCounts>;
}> {
  const feedback = new Map<string, FeedbackCounts>();
  const summaries = new Map<string, string>();
  // 计票与摘要都只认可见的当前版本：join 已按 publicKnowledgeVersion 过滤，隐藏版本不会带 hash。
  const visible = rows.filter((row): row is Row & { active_version_id: string; content_sha256: string } =>
    typeof row.active_version_id === "string" && typeof row.content_sha256 === "string");
  if (!visible.length) return { summaries, feedback };
  for (const row of visible) feedback.set(String(row.active_version_id), { ...EMPTY_FEEDBACK });
  const versionIds = visible.map((row) => String(row.active_version_id));
  // 一页条目一次分组查询：口径绑定 (project, version_id, owner_project_id)，同 hash 不同版本互不串票。
  const grouped = await db<Array<{ version_id: string; outcome: string | null; count: number }>>`
    SELECT u.version_id, u.feedback_json->>'outcome' AS outcome, count(*)::int AS count
    FROM project_knowledge_usages u
    WHERE u.project_id=${projectId} AND u.owner_project_id=${projectId}
      AND u.version_id = ANY(${versionIds}::uuid[])
    GROUP BY u.version_id, u.feedback_json->>'outcome'`;
  for (const row of grouped) {
    const counts = feedback.get(String(row.version_id));
    if (!counts) continue;
    counts.total += Number(row.count);
    if (row.outcome === "success") counts.success += Number(row.count);
    else if (row.outcome === "failure") counts.failure += Number(row.count);
    else if (row.outcome === "inapplicable") counts.inapplicable += Number(row.count);
    else counts.unrated += Number(row.count);
  }
  const hashes = [...new Set(visible.map((row) => String(row.content_sha256)))].slice(0, CARD_SUMMARY_READ_LIMIT);
  for (const hash of hashes) {
    try {
      const candidate: unknown = await readKnowledgeBlob(db, hash);
      // 版本 CAS 字节是完整 KnowledgeCandidate；这里只读可选的 content 作为卡片摘要。
      const content = typeof candidate === "object" && candidate !== null && "content" in candidate
        ? candidate.content : undefined;
      if (typeof content === "string") summaries.set(hash, content.replace(/\s+/gu, " ").trim().slice(0, 240));
    } catch { /* 摘要缺失不影响列表本身 */ }
  }
  return { summaries, feedback };
}

/** Routes are locally scoped too; auth.ts must additionally register their route scopes. */
async function versionSourcesReadable(db: KnowledgeDb, req: FastifyRequest, projectId: string,
  version: Record<string, unknown>): Promise<boolean> {
  const resolved = await resolveSourceOwners(db, version.sources_json);
  if (resolved.unresolved > 0) return false;
  if (resolved.owners.some((owner) => owner.project_id !== projectId)) return false;
  // 沿用来源原有权限：能读原始资料（tasks:read/admin）的人不必再持有治理 Job 清单；角色名不参与判定。
  const humanAuthority = Boolean(req.actor && actorHasScope(req.actor, "tasks:read"));
  return actorMayReadGovernanceSources(db, { jobId: req.actor?.id ?? null, projectId, humanAuthority }, resolved.owners);
}

export function registerProjectKnowledgeRoutes(
  app: FastifyInstance,
  deps: { db?: Db; recordAudit?: typeof audit } = {},
): void {
  registerAutomaticKnowledgeRoutes(app, deps);
  registerTaskKnowledgeCloseoutRoutes(app, deps);
  registerKnowledgeActivityRoutes(app, deps);
  const db = deps.db ?? sql;
  const recordAudit = deps.recordAudit ?? audit;
  app.get("/projects/:id/knowledge", async (req, reply) => {
    try {
      const projectId = Id.parse((req.params as { id: string }).id);
      if (!access(req, reply, projectId)) return;
      const input = List.parse(req.query);
      const pattern = input.query ? `%${input.query.replace(/[\\%_]/g, "\\$&")}%` : null;
      const keysText = await readableVersionKeysJson(db, req.actor, projectId);
      const rows = await db`SELECT i.id,i.project_id,i.kind,i.logical_key,i.title,i.keywords_json,
          i.status,i.active_version_id,i.generation,i.created_at,i.updated_at,
          v.version,v.content_sha256
        FROM project_knowledge_items i
        LEFT JOIN project_knowledge_versions v ON v.id=i.active_version_id AND v.project_id=i.project_id
          AND ${publicKnowledgeVersion(db)}
        WHERE i.project_id=${projectId} AND ${publicKnowledgeItem(db)}
          AND (v.id IS NULL OR ${readableVersionSources(db, keysText)})
          AND (i.active_version_id IS NULL OR EXISTS (SELECT 1 FROM project_knowledge_versions v
            WHERE v.id=i.active_version_id AND ${readableVersionSources(db, keysText)}))
          AND (${input.kind ?? null}::text IS NULL OR i.kind=${input.kind ?? null})
          AND (${input.status ?? null}::text IS NULL OR i.status=${input.status ?? null})
          AND (${pattern}::text IS NULL OR i.title ILIKE ${pattern} ESCAPE '\\' OR i.logical_key ILIKE ${pattern} ESCAPE '\\')
        ORDER BY i.updated_at DESC,i.id DESC LIMIT ${input.limit + 1} OFFSET ${input.offset}`;
      const page = rows.slice(0, input.limit);
      const { summaries, feedback } = await knowledgeCardFacts(db, projectId, page);
      const items = page.map((row) => ({
        ...row,
        summary: typeof row.content_sha256 === "string" ? summaries.get(row.content_sha256) ?? null : null,
        feedback: row.active_version_id ? feedback.get(String(row.active_version_id)) ?? EMPTY_FEEDBACK : EMPTY_FEEDBACK,
      }));
      return { items, next_offset: rows.length > input.limit ? input.offset + input.limit : null };
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
      return { items: rows.slice(0, input.limit).map(publicReceipt), next_offset: rows.length > input.limit ? input.offset + input.limit : null };
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
      return row ? publicReceipt(row) : reply.code(404).send({ error_code: "KNOWLEDGE_RECEIPT_NOT_FOUND" });
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/:itemId", async (req, reply) => {
    try {
      const { id, itemId } = req.params as { id: string; itemId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      return await itemDetail(db, projectId, Id.parse(itemId), req.actor)
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
      const keysText = await readableVersionKeysJson(db, req.actor, projectId);
      const rows = await db`SELECT id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,
          governance_hash,revoked_at,revoked_reason,created_at
        FROM project_knowledge_versions v WHERE v.project_id=${projectId} AND v.item_id=${itemId} AND ${publicKnowledgeVersion(db)}
          AND ${readableVersionSources(db, keysText)}
        ORDER BY version DESC LIMIT ${page.limit + 1} OFFSET ${page.offset}`;
      return { items: redactVersionSources(rows.slice(0, page.limit) as Row[], req.actor),
        next_offset: rows.length > page.limit ? page.offset + page.limit : null };
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/projects/:id/knowledge/:itemId/versions/:versionId", async (req, reply) => {
    try {
      const { id, itemId, versionId } = req.params as { id: string; itemId: string; versionId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      const item = await itemFor(db, projectId, Id.parse(itemId));
      const version = await versionFor(db, projectId, Id.parse(itemId), Id.parse(versionId), req.actor);
      // #1286：管理 API 的按版本读取沿用来源原有授权，作者/受众之外的人看不到。
      if (version && !(await versionSourcesReadable(db, req, projectId, version))) {
        return reply.code(404).send({ error_code: "KNOWLEDGE_VERSION_NOT_FOUND" });
      }
      if (!item || !version) return reply.code(404).send({ error_code: "KNOWLEDGE_VERSION_NOT_FOUND" });
      // Only the owning project can inspect historical content. Source refs remain opaque.
      const candidate = await readKnowledgeBlob(db, String(version.content_sha256));
      const [visible] = redactVersionSources([version as Row], req.actor);
      // 读取历史版本时用该版本自己的标题；当前条目标题会被新版本改写，不能带出去。
      const versionTitle = recordField(candidate, "title") ?? item.title;
      return { ...visible, item: { id: item.id, kind: item.kind, title: versionTitle, logical_key: item.logical_key }, candidate };
    } catch (error) { return errorReply(reply, error); }
  });

  // #1256：某一版本的评价计数与明细（时间倒序分页）；只有所属项目可读，来源引用保持不透明。
  app.get("/projects/:id/knowledge/:itemId/versions/:versionId/feedback", async (req, reply) => {
    try {
      const { id, itemId, versionId } = req.params as { id: string; itemId: string; versionId: string };
      const projectId = Id.parse(id);
      if (!access(req, reply, projectId)) return;
      const version = await versionFor(db, projectId, Id.parse(itemId), Id.parse(versionId));
      if (!version) return reply.code(404).send({ error_code: "KNOWLEDGE_VERSION_NOT_FOUND" });
      const input = FeedbackList.parse(req.query);
      const canSeeSources = req.actor ? actorHasScope(req.actor, "tasks:read") : false;
      const hash = String(version.content_sha256);
      const page = await readVersionFeedbackRows(db, projectId, String(version.id), hash,
        input.outcome ?? null, input.limit, input.offset);
      return {
        counts: page.counts,
        items: page.rows.slice(0, input.limit).map((row) => ({
          id: row.id, created_at: row.created_at,
          outcome: recordField(row.feedback_json, "outcome"),
          // 理由是任务产生的自由文本，与来源任务同权限：没有 tasks:read 一律不返回。
          reason: canSeeSources ? recordField(row.feedback_json, "reason") : null,
          // 来源任务与理由属于项目内执行记录：没有 tasks:read 就不给，避免只读目录者看到任务侧内容。
          job_id: canSeeSources ? row.job_id : null,
        })),
        next_offset: page.rows.length > input.limit ? input.offset + input.limit : null,
      };
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
