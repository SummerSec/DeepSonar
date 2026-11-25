import type { SubmitTaskKnowledgeSuggestionPayload } from "@deepsonar/shared-types";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { canonical, sha256, type KnowledgeDb } from "./types.js";

type SuggestionItem = SubmitTaskKnowledgeSuggestionPayload["items"][number];

export type IngestOwner = { projectId: string; jobId: string; attemptId: string; canvasId: string };

/** 调用方已校验过的修订目标；只有明确指向某条目时才允许追加版本。 */
export type IngestTarget = { item_ref: string; version_ref: string };

export type IngestOutcome = {
  item_ref: string; version_ref: string; version: number; logical_key: string;
  outcome: "created" | "revised" | "unchanged" | "skipped";
  reason?: string;
};

/** 标题归一化成稳定逻辑键：小写、非字母数字折叠成单横线，最长 120 字符。 */
export function taskKnowledgeLogicalKey(title: string): string {
  // 逻辑键要落进 knowledge 契约（^[a-zA-Z0-9][a-zA-Z0-9._/-]*$），所以标题先做 NFKC
  // 兼容归一，再把非 ASCII 字母数字折叠成 '-'：中文标题不拼拼音，只留稳定可读的前缀。
  const slug = title.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "").slice(0, 120);
  return `task/${slug || "untitled"}`;
}

/**
 * 只有 memory 类沉淀走这条确定性入库路径。Skill 需要文件包与显式送评
 * （#1219 明确保留「Skill 显式送评」），因此这里跳过、由既有链路处理。
 */
export function ingestibleSuggestions(items: readonly SuggestionItem[]): SuggestionItem[] {
  return items.filter((item) => item.kind === "memory");
}

/**
 * 把任务内沉淀的记忆直接写成可检索的知识条目与版本（#1219 第一步：能记、能查、能读、能改）。
 *
 * 不经过 maker→evaluator→reviewer 的模型评测：内容是 Agent 在本次会话里带证据记下的观察，
 * 评测只会再起模型任务。同标题再次沉淀时追加新版本并把新版本置为 active，形成可追溯的修订。
 * 写入范围仍受调用方已校验的 Job/Attempt/Canvas/项目约束，本函数不读也不放宽任何权限。
 */
export async function ingestTaskKnowledgeSuggestions(
  tx: KnowledgeDb,
  owner: IngestOwner,
  items: readonly SuggestionItem[],
  evidenceHashes: readonly (readonly string[])[],
  targets: readonly (IngestTarget | null)[] = [],
): Promise<IngestOutcome[]> {
  const outcomes: IngestOutcome[] = [];
  for (const item of items) {
    if (item.kind !== "memory") continue;
    const index = items.indexOf(item);
    const logicalKey = taskKnowledgeLogicalKey(item.title);
    const sources = [
      ...item.evidence_refs.map((ref, position) => ({ kind: ref.kind, ref: ref.ref,
        integrity_hash: evidenceHashes[index]?.[position] ?? null })),
      { kind: "task", job_id: owner.jobId, canvas_id: owner.canvasId, attempt_id: owner.attemptId, scope: item.scope },
    ];
    // 版本 CAS 字节必须是完整的 KnowledgeCandidate（strict）：来源与任务归属单独进
    // sources_json，不能混进正文，否则读取侧 KnowledgeCandidate.parse 会直接拒绝。
    const blob = await writeKnowledgeBlob(tx, { kind: "memory", logical_key: logicalKey,
      title: item.title.slice(0, 200), keywords: [item.scope.slice(0, 80)], content: item.content });
    await registerKnowledgeBlob(tx, blob.hash, blob.bytes);
    const governanceHash = sha256(canonical({ project_id: owner.projectId, job_id: owner.jobId,
      attempt_id: owner.attemptId, operation: "submit_task_knowledge_suggestion", logical_key: logicalKey,
      content_hash: blob.hash }));
    const resolution = await resolveIngestItem(tx, owner, { target: targets[index] ?? null,
      logicalKey, title: item.title, scope: item.scope, hash: blob.hash });
    if (resolution.kind === "skip") {
      outcomes.push(resolution.outcome);
      continue;
    }
    const { itemId, itemKey, version, mode } = resolution;
    const [created] = await tx`INSERT INTO project_knowledge_versions
      (project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${owner.projectId},${itemId},${version},${blob.hash},${owner.jobId},${owner.attemptId},
        ${tx.json(sources)},${governanceHash}) RETURNING id`;
    await tx`UPDATE project_knowledge_items SET active_version_id=${String(created?.id)},status='active',
      title=${item.title.slice(0, 200)},generation=generation+1,updated_at=now()
      WHERE project_id=${owner.projectId} AND id=${itemId}`;
    outcomes.push({ item_ref: itemId, version_ref: String(created?.id), version,
      logical_key: itemKey, outcome: mode });
  }
  return outcomes;
}

type ItemResolution =
  | { kind: "skip"; outcome: IngestOutcome }
  | { kind: "use"; itemId: string; itemKey: string; version: number; mode: "created" | "revised" };

/**
 * 决定这次沉淀落到哪一条目：显式 target 走修订（条目锁内按基线复核），
 * 否则按逻辑键判重并新建。返回 skip 表示这次不该写，原因写进 outcome。
 */
async function resolveIngestItem(
  tx: KnowledgeDb,
  owner: IngestOwner,
  input: { target: IngestTarget | null; logicalKey: string; title: string; scope: string; hash: string },
): Promise<ItemResolution> {
  if (input.target) return resolveRevisionTarget(tx, owner, input.target, input.logicalKey);
  // 先在数据库里按 (项目,kind,逻辑键) 串行化：对新行 FOR UPDATE 加不上锁，
  // 两个不同画布的投稿会同时通过存在性查询再撞唯一键。事务级 advisory lock 覆盖两者。
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`knowledge-ingest:${owner.projectId}:memory:${input.logicalKey}`}))`;
  const [existing] = await tx`SELECT i.id, i.status, i.active_version_id, v.content_sha256 AS active_hash
    FROM project_knowledge_items i
    LEFT JOIN project_knowledge_versions v ON v.id=i.active_version_id AND v.project_id=i.project_id
    WHERE i.project_id=${owner.projectId} AND i.kind='memory' AND i.logical_key=${input.logicalKey}
    FOR UPDATE OF i`;
  if (existing) {
    const itemRef = String(existing.id);
    const versionRef = String(existing.active_version_id ?? "");
    if (String(existing.active_hash ?? "") === input.hash) {
      return { kind: "skip", outcome: { item_ref: itemRef, version_ref: versionRef, version: 0,
        logical_key: input.logicalKey, outcome: "unchanged" } };
    }
    return { kind: "skip", outcome: { item_ref: itemRef, version_ref: versionRef, version: 0,
      logical_key: input.logicalKey, outcome: "skipped", reason: "同名条目已存在且内容不同；修订需要显式 target 基线" } };
  }
  const [created] = await tx`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,keywords_json)
    VALUES(${owner.projectId},'memory',${input.logicalKey},${input.title.slice(0, 200)},${tx.json([input.scope.slice(0, 80)])})
    RETURNING id`;
  return { kind: "use", itemId: String(created?.id), itemKey: input.logicalKey, version: 1, mode: "created" };
}

/** 显式修订：条目锁内按 (item_ref, version_ref) 复核，基线过期或撤销一律 skip。 */
async function resolveRevisionTarget(
  tx: KnowledgeDb,
  owner: IngestOwner,
  target: IngestTarget,
  logicalKey: string,
): Promise<ItemResolution> {
  const [current] = await tx`SELECT i.id, i.status, i.active_version_id, i.logical_key, v.revoked_at
    FROM project_knowledge_items i
    LEFT JOIN project_knowledge_versions v ON v.id=${target.version_ref} AND v.item_id=i.id
    WHERE i.project_id=${owner.projectId} AND i.id=${target.item_ref} AND i.kind='memory'
    FOR UPDATE OF i`;
  const skip = (reason: string, key = logicalKey): ItemResolution => ({ kind: "skip",
    outcome: { item_ref: target.item_ref, version_ref: target.version_ref, version: 0,
      logical_key: key, outcome: "skipped", reason } });
  if (!current || current.status !== "active") return skip("修订目标条目已不处于 active");
  const currentKey = String(current.logical_key ?? logicalKey);
  // 同一基线被两个任务同时修订时，只有先取得锁的那份能生效。
  if (String(current.active_version_id ?? "") !== target.version_ref) return skip("修订基线已被别的版本取代", currentKey);
  if (current.revoked_at) return skip("修订基线版本已撤销", currentKey);
  const [number] = await tx`SELECT COALESCE(MAX(version),0)+1 AS next
    FROM project_knowledge_versions WHERE item_id=${target.item_ref}`;
  return { kind: "use", itemId: target.item_ref, itemKey: currentKey,
    version: Number(number?.next ?? 1), mode: "revised" };
}
