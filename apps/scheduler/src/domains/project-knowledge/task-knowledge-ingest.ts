import type { SubmitTaskKnowledgeSuggestionPayload } from "@deepsonar/shared-types";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { canonical, sha256, type KnowledgeDb } from "./types.js";

type SuggestionItem = SubmitTaskKnowledgeSuggestionPayload["items"][number];

export type IngestOwner = { projectId: string; jobId: string; attemptId: string; canvasId: string };

export type IngestOutcome = {
  item_ref: string; version_ref: string; version: number; logical_key: string;
  outcome: "created" | "revised" | "unchanged";
};

/** 标题归一化成稳定逻辑键：小写、非字母数字折叠成单横线，最长 120 字符。 */
export function taskKnowledgeLogicalKey(title: string): string {
  const slug = title.toLowerCase().normalize("NFKC").replace(/[^\p{Letter}\p{Number}]+/gu, "-")
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
    const blob = await writeKnowledgeBlob(tx, { kind: "memory", title: item.title, content: item.content, sources });
    await registerKnowledgeBlob(tx, blob.hash, blob.bytes);
    const governanceHash = sha256(canonical({ project_id: owner.projectId, job_id: owner.jobId,
      attempt_id: owner.attemptId, operation: "submit_task_knowledge_suggestion", logical_key: logicalKey,
      content_hash: blob.hash }));
    const [existing] = await tx`SELECT i.id, i.status, i.active_version_id, v.content_sha256 AS active_hash
      FROM project_knowledge_items i
      LEFT JOIN project_knowledge_versions v ON v.id=i.active_version_id AND v.project_id=i.project_id
      WHERE i.project_id=${owner.projectId} AND i.kind='memory' AND i.logical_key=${logicalKey}
      FOR UPDATE OF i`;
    if (existing && String(existing.active_hash ?? "") === blob.hash) {
      outcomes.push({ item_ref: String(existing.id), version_ref: String(existing.active_version_id),
        version: 0, logical_key: logicalKey, outcome: "unchanged" });
      continue;
    }
    let itemId: string;
    let version = 1;
    if (existing) {
      itemId = String(existing.id);
      const [number] = await tx`SELECT COALESCE(MAX(version),0)+1 AS next
        FROM project_knowledge_versions WHERE item_id=${itemId}`;
      version = Number(number?.next ?? 1);
    } else {
      const [created] = await tx`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,keywords_json)
        VALUES(${owner.projectId},'memory',${logicalKey},${item.title.slice(0, 200)},${tx.json([item.scope.slice(0, 80)])})
        RETURNING id`;
      itemId = String(created?.id);
    }
    const [created] = await tx`INSERT INTO project_knowledge_versions
      (project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${owner.projectId},${itemId},${version},${blob.hash},${owner.jobId},${owner.attemptId},
        ${tx.json(sources)},${governanceHash}) RETURNING id`;
    await tx`UPDATE project_knowledge_items SET active_version_id=${String(created?.id)},status='active',
      title=${item.title.slice(0, 200)},generation=generation+1,updated_at=now()
      WHERE project_id=${owner.projectId} AND id=${itemId}`;
    outcomes.push({ item_ref: itemId, version_ref: String(created?.id), version,
      logical_key: logicalKey, outcome: existing ? "revised" : "created" });
  }
  return outcomes;
}