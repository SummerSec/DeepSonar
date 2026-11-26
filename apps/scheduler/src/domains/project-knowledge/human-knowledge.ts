import { KnowledgeCandidate } from "@deepsonar/shared-types";
import { readKnowledgeVersionContent, registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { canonical, KnowledgeOperationError, sha256, type KnowledgeDb } from "./types.js";

/** 人类（Web 操作员）在项目内维护知识时的身份；没有 Job/Attempt，因此单独记录作者。 */
export interface KnowledgeAuthor {
  projectId: string;
  id: string;
  name: string;
}

export interface KnowledgeWriteResult {
  item_ref: string;
  version_ref: string;
  version: number;
}


/** 已撤回的条目不允许任何人工维护动作。 */
function refuseClosed(status: unknown): void {
  if (status !== "revoked") return;
  throw new KnowledgeOperationError("KNOWLEDGE_REVOKED", "该知识条目已被撤回，不能再维护", "permanent_failure", "停止维护这个条目；需要新内容请新建条目。");
}

const notFound = (): never => {
  throw new KnowledgeOperationError("KNOWLEDGE_ITEM_NOT_FOUND", "知识条目不存在或已被撤销", "permanent_failure", "刷新项目知识列表后重试；不要假设该条目仍然存在。");
};

/** 人类写入没有治理流程，用内容与身份的确定性摘要占位，保持既有的 64 位十六进制约束。 */
function humanGovernanceHash(input: { projectId: string; itemId: string; version: number; contentHash: string }): string {
  return sha256(canonical({ kind: "human-authored", ...input }));
}

export async function createHumanKnowledgeItem(db: KnowledgeDb, author: KnowledgeAuthor, candidate: KnowledgeCandidate): Promise<KnowledgeWriteResult> {
  const blob = await writeKnowledgeBlob(db, candidate);
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`knowledge-human:${author.projectId}:${candidate.kind}:${candidate.logical_key}`}))`;
    const [existing] = await tx`SELECT id FROM project_knowledge_items
      WHERE project_id=${author.projectId} AND kind=${candidate.kind} AND logical_key=${candidate.logical_key}`;
    if (existing) {
      throw new KnowledgeOperationError("KNOWLEDGE_BASE_CONFLICT", "同名标识的知识已存在，请改用编辑或换一个标识", "model_correctable", "改用已有条目编辑入口，或换一个 logically unique 的 logical_key 后重试。");
    }
    const [item] = await tx`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,keywords_json)
      VALUES(${author.projectId},${candidate.kind},${candidate.logical_key},${candidate.title},${tx.json(candidate.keywords ?? [])}) RETURNING id`;
    const itemId = String(item!.id);
    // SAFETY: postgres.js 的事务句柄与连接句柄共用同一 SQL 接口；这里只借用它写同一事务内的 blob 元数据。
    const blobDb = tx as unknown as KnowledgeDb;
    await registerKnowledgeBlob(blobDb, blob.hash, blob.bytes);
    const [version] = await tx`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,created_by_type,created_by,sources_json,governance_hash)
      VALUES(${author.projectId},${itemId},1,${blob.hash},'human',${author.id},'[]'::jsonb,${humanGovernanceHash({ projectId: author.projectId, itemId, version: 1, contentHash: blob.hash })}) RETURNING id,version`;
    await tx`UPDATE project_knowledge_items SET status='active',active_version_id=${String(version!.id)},generation=generation+1,updated_at=now() WHERE id=${itemId}`;
    return { item_ref: itemId, version_ref: String(version!.id), version: Number(version!.version) };
  });
}

export interface KnowledgeRevisionInput {
  title: string;
  content?: string;
  files?: unknown;
  /** 未传表示沿用基准版本的关键词；显式 [] 才表示清空。 */
  keywords?: string[];
}

export async function reviseHumanKnowledgeItem(
  db: KnowledgeDb, author: KnowledgeAuthor, itemId: string, expectedVersion: number, input: KnowledgeRevisionInput,
): Promise<KnowledgeWriteResult> {
  // 锁外准备：状态与基准只做一次快照，正文读取与 CAS 写入都不占条目锁；
  // 事务内再重验条目状态、基准 ID/版本/哈希与撤销条件，沿用 revision-feedback.ts 的模式。
  const [snapshot] = await db`SELECT i.kind, i.logical_key, i.status, i.active_version_id,
      v.version AS base_version, v.revoked_at AS base_revoked_at
    FROM project_knowledge_items i
    LEFT JOIN project_knowledge_versions v ON v.project_id=i.project_id AND v.id=i.active_version_id
    WHERE i.project_id=${author.projectId} AND i.id=${itemId}`;
  if (!snapshot) notFound();
  refuseClosed(snapshot.status);
  if (!snapshot.active_version_id || !snapshot.base_version) {
    throw new KnowledgeOperationError("KNOWLEDGE_ITEM_NOT_FOUND", "知识条目没有可编辑的生效版本", "permanent_failure", "刷新条目后重试；没有生效版本时请新建条目。");
  }
  if (snapshot.base_revoked_at) {
    throw new KnowledgeOperationError("KNOWLEDGE_REVOKED", "基准版本已被撤回，不能再基于它编辑", "permanent_failure", "停止基于这个版本编辑；需要新内容请新建条目。");
  }
  // 关键词未传＝沿用基准版本；显式 [] 才清空。基准正文读失败必须让整笔编辑失败。
  const inherited = input.keywords ?? await readVersionKeywords(db, String(snapshot.active_version_id));
  const candidate = KnowledgeCandidate.parse({
    kind: snapshot.kind, logical_key: snapshot.logical_key, title: input.title, keywords: inherited,
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.files === undefined ? {} : { files: input.files }),
  });
  // CAS 写在锁外完成；事务内只登记元数据并切换生效版本。
  const blob = await writeKnowledgeBlob(db, candidate);
  const version = expectedVersion + 1;
  return db.begin(async (tx) => {
    const [locked] = await tx`SELECT kind, logical_key, status, active_version_id FROM project_knowledge_items
      WHERE project_id=${author.projectId} AND id=${itemId} FOR UPDATE`;
    if (!locked) notFound();
    refuseClosed(locked.status);
    if (String(locked.active_version_id ?? "") !== String(snapshot.active_version_id)
      || locked.kind !== snapshot.kind || locked.logical_key !== snapshot.logical_key) {
      throw new KnowledgeOperationError("KNOWLEDGE_VERSION_CONFLICT", "知识已被其他修改更新，请重新读取最新版本后再提交", "model_correctable", "重新读取条目最新版本，确认差异后用新的 expected_version 重新提交。");
    }
    const [base] = await tx`SELECT version, revoked_at FROM project_knowledge_versions
      WHERE project_id=${author.projectId} AND id=${String(snapshot.active_version_id)} FOR UPDATE`;
    if (!base || Number(base.version) !== expectedVersion || base.revoked_at) {
      throw new KnowledgeOperationError(base?.revoked_at ? "KNOWLEDGE_REVOKED" : "KNOWLEDGE_VERSION_CONFLICT",
        base?.revoked_at ? "基准版本已被撤回，不能再基于它编辑" : "知识已被其他修改更新，请重新读取最新版本后再提交",
        base?.revoked_at ? "permanent_failure" : "model_correctable",
        base?.revoked_at ? "停止基于这个版本编辑；需要新内容请新建条目。" : "重新读取条目最新版本，确认差异后用新的 expected_version 重新提交。");
    }
    // SAFETY: postgres.js 的事务句柄与连接句柄共用同一 SQL 接口；这里只登记同一事务内的 blob 元数据。
    const blobDb = tx as unknown as KnowledgeDb;
    await registerKnowledgeBlob(blobDb, blob.hash, blob.bytes);
    const [created] = await tx`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,created_by_type,created_by,sources_json,governance_hash)
      VALUES(${author.projectId},${itemId},${version},${blob.hash},'human',${author.id},'[]'::jsonb,${humanGovernanceHash({ projectId: author.projectId, itemId, version, contentHash: blob.hash })}) RETURNING id,version`;
    await tx`UPDATE project_knowledge_items SET status='active',retired_reason=NULL,active_version_id=${String(created!.id)},title=${candidate.title},keywords_json=${tx.json(candidate.keywords ?? [])},generation=generation+1,updated_at=now() WHERE id=${itemId}`;
    return { item_ref: itemId, version_ref: String(created!.id), version: Number(created!.version) };
  });
}

export async function archiveHumanKnowledgeItem(db: KnowledgeDb, author: KnowledgeAuthor, itemId: string): Promise<{ item_ref: string; status: "retired" }> {
  return db.begin(async (tx) => {
    const [item] = await tx`SELECT id,status FROM project_knowledge_items WHERE project_id=${author.projectId} AND id=${itemId} FOR UPDATE`;
    if (!item) notFound();
    if (item!.status === "revoked") {
      throw new KnowledgeOperationError("KNOWLEDGE_REVOKED", "该知识条目已被撤回，不能再下架", "permanent_failure", "停止操作这个条目；撤回由安全流程处理，不能通过下架绕过。");
    }
    if (item!.status === "retired") return { item_ref: itemId, status: "retired" as const };
    await tx`UPDATE project_knowledge_items SET status='retired',retired_reason='archived_by_user',generation=generation+1,updated_at=now() WHERE id=${itemId}`;
    return { item_ref: itemId, status: "retired" as const };
  });
}

export async function restoreHumanKnowledgeItem(db: KnowledgeDb, author: KnowledgeAuthor, itemId: string): Promise<{ item_ref: string; status: "active" }> {
  return db.begin(async (tx) => {
    const [item] = await tx`SELECT id,status,retired_reason,active_version_id FROM project_knowledge_items
      WHERE project_id=${author.projectId} AND id=${itemId} FOR UPDATE`;
    if (!item) notFound();
    if (item!.status !== "retired" || item!.retired_reason !== "archived_by_user" || !item!.active_version_id) {
      throw new KnowledgeOperationError("KNOWLEDGE_RESTORE_DENIED", "只有用户下架的条目可以恢复；评测淘汰或撤回的条目不能直接恢复", "permanent_failure", "不要通过恢复绕过评测淘汰或安全撤回；需要新内容请新建条目。");
    }
    await tx`UPDATE project_knowledge_items SET status='active',retired_reason=NULL,generation=generation+1,updated_at=now() WHERE id=${itemId}`;
    return { item_ref: itemId, status: "active" as const };
  });
}

/**
 * 读取基准版本的关键词。读取失败（版本被撤销、字节不可用）必须让整笔编辑失败，
 * 不能当成「没有关键词」继续写新版本——否则一次读取故障就会静默清空检索词。
 */
async function readVersionKeywords(db: KnowledgeDb, versionId: string): Promise<string[]> {
  const candidate = await readKnowledgeVersionContent(db, versionId);
  return Array.isArray(candidate.keywords) ? candidate.keywords : [];
}
