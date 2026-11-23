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
    const blob = await writeKnowledgeBlob(tx, { kind: "memory", title: item.title, content: item.content, sources });
    await registerKnowledgeBlob(tx, blob.hash, blob.bytes);
    const governanceHash = sha256(canonical({ project_id: owner.projectId, job_id: owner.jobId,
      attempt_id: owner.attemptId, operation: "submit_task_knowledge_suggestion", logical_key: logicalKey,
      content_hash: blob.hash }));
    // 标题归一化只是「同一条知识」的候选键，不能凭它接管别人的条目：只有显式指定
    // 修订目标（调用方已按 usage_ref 校验过归属、版本与 active 状态）才追加版本。
    // 先在数据库里按 (项目,kind,逻辑键) 串行化：对新行 FOR UPDATE 加不上锁，
    // 两个不同画布的投稿会同时通过存在性查询再撞唯一键。事务级 advisory lock 覆盖两者。
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`knowledge-ingest:${owner.projectId}:memory:${logicalKey}`}))`;
    const target = targets[index] ?? null;
    const [existing] = await tx`SELECT i.id, i.status, i.active_version_id, v.content_sha256 AS active_hash
      FROM project_knowledge_items i
      LEFT JOIN project_knowledge_versions v ON v.id=i.active_version_id AND v.project_id=i.project_id
      WHERE i.project_id=${owner.projectId} AND i.kind='memory' AND i.logical_key=${logicalKey}
      FOR UPDATE OF i`;
    if (existing) {
      if (String(existing.active_hash ?? "") === blob.hash) {
        outcomes.push({ item_ref: String(existing.id), version_ref: String(existing.active_version_id),
          version: 0, logical_key: logicalKey, outcome: "unchanged" });
        continue;
      }
      // 同名但不是显式修订目标，或条目已退出生命周期（retired/revoked/stale）：
      // 一律不动它，交给后续的显式治理流程，避免同名投稿复活撤销条目。
      const revivable = existing.status === "active" || existing.status === "draft";
      if (!target || target.item_ref !== String(existing.id) || !revivable) {
        outcomes.push({ item_ref: String(existing.id), version_ref: String(existing.active_version_id ?? ""),
          version: 0, logical_key: logicalKey,
          outcome: target ? "skipped" : "unchanged",
          reason: target ? "同名条目存在但不是本次修订目标，或已退出生命周期" : "同名条目已存在且内容不同，需显式修订目标" });
        continue;
      }
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