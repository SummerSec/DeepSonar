import { ingestTaskKnowledgeSuggestions, type IngestOutcome, type IngestOwner } from "./domains/project-knowledge/task-knowledge-ingest.js";
import { readKnowledgeBlob } from "./domains/project-knowledge/blobs.js";

/**
 * 历史任务沉淀的要不要一次性并回可检索知识（#1219 第一步的补齐动作）。
 *
 * 迁移前的 `submit_task_knowledge_suggestion` 只写回执、事件与画布收尾节点，
 * 正文留在内容寻址存储里，知识库里查不到。这里按**回执**（而不是文本猜测）回放：
 * 归属仍是当初的 Job / Attempt / 画布，来源哈希用投稿时已校验的那份，
 * 走与线上同一条入库路径，因此同标题会追加版本、同内容会返回 unchanged。
 */

export type LegacyMigrationCandidate = {
  receipt_id: string;
  project_id: string;
  job_id: string;
  attempt_id: string;
  canvas_id: string | null;
  blob_hash: string;
  item_count: number | null;
};

export type LegacyTotals = { scanned: number; migrated: number; unchanged: number; skipped: number; failed: number };

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

type BlobPayload = { input?: { items?: unknown }; source_hashes?: unknown };

/** 从回执指向的正文里取出可入库的 memory 项与其来源哈希；结构不符时返回空，交给调用方跳过。 */
export function legacySuggestionItems(blob: unknown): { items: unknown[]; sourceHashes: string[][] } {
  const payload = (blob ?? {}) as BlobPayload;
  const rawItems = Array.isArray(payload.input?.items) ? payload.input.items : [];
  const rawHashes = Array.isArray(payload.source_hashes) ? payload.source_hashes : [];
  const sourceHashes = rawItems.map((_, index) => {
    const row = rawHashes[index];
    return Array.isArray(row) ? row.filter((value): value is string => typeof value === "string") : [];
  });
  return { items: rawItems, sourceHashes };
}

/** 列出还没并回知识库的历史沉淀回执；已带 `ingested` 标记的不再出现。 */
export async function planLegacyKnowledgeMigration(db: unknown, limit = 50): Promise<LegacyMigrationCandidate[]> {
  const sql = db as Sql;
  const rows = await sql`
    SELECT r.id, r.project_id, r.job_id, r.attempt_id, j.canvas_id,
      r.result_json->>'blob_hash' AS blob_hash, r.result_json->>'count' AS item_count
    FROM project_knowledge_receipts r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.operation = 'submit_task_knowledge_suggestion'
      AND r.result_json->>'blob_hash' IS NOT NULL
      AND COALESCE(r.result_json->>'ingested', '') = ''
    ORDER BY r.created_at, r.id
    LIMIT ${limit}`;
  return rows.map((row) => ({
    receipt_id: String(row.id), project_id: String(row.project_id), job_id: String(row.job_id),
    attempt_id: String(row.attempt_id), canvas_id: row.canvas_id ? String(row.canvas_id) : null,
    blob_hash: String(row.blob_hash), item_count: row.item_count === null ? null : Number(row.item_count),
  }));
}

/**
 * 逐个回执回放入库。`apply=false` 只做计划；`apply=true` 时每份回执一个事务，
 * 成功后把 `ingested` 写回该回执，重复执行即跳过（入库本身还有内容哈希幂等）。
 */
export async function migrateLegacyKnowledge(
  db: unknown,
  options: { apply: boolean; limit?: number },
): Promise<{ candidates: LegacyMigrationCandidate[]; outcomes: Array<{ receipt_id: string; items: IngestOutcome[]; error?: string }>; totals: LegacyTotals }> {
  const sql = db as Sql & { begin: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> };
  const candidates = await planLegacyKnowledgeMigration(db, options.limit ?? 50);
  const outcomes: Array<{ receipt_id: string; items: IngestOutcome[]; error?: string }> = [];
  const totals: LegacyTotals = { scanned: candidates.length, migrated: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (!options.apply) return { candidates, outcomes, totals };

  for (const candidate of candidates) {
    try {
      const result = await sql.begin(async (rawTx) => {
        const tx = rawTx as Sql;
        const blob = await readKnowledgeBlob(rawTx as never, candidate.blob_hash);
        const { items, sourceHashes } = legacySuggestionItems(blob);
        if (items.length === 0) return { outcome: [] as IngestOutcome[], skipped: true };
        const owner: IngestOwner = { projectId: candidate.project_id, jobId: candidate.job_id,
          attemptId: candidate.attempt_id, canvasId: candidate.canvas_id ?? "" };
        const outcome = await ingestTaskKnowledgeSuggestions(tx as never, owner,
          items as Parameters<typeof ingestTaskKnowledgeSuggestions>[2], sourceHashes);
        // 回写 ingested 标记：用参数化的 jsonb 文本，避免依赖事务句柄上的 json 辅助。
        await tx`UPDATE project_knowledge_receipts
          SET result_json = result_json || ${JSON.stringify({ ingested: outcome })}::jsonb
          WHERE id = ${candidate.receipt_id}`;
        return { outcome, skipped: false };
      });
      if (result.skipped) {
        totals.skipped += 1;
        outcomes.push({ receipt_id: candidate.receipt_id, items: [] });
        continue;
      }
      for (const item of result.outcome) {
        if (item.outcome === "unchanged") totals.unchanged += 1;
        else totals.migrated += 1;
      }
      outcomes.push({ receipt_id: candidate.receipt_id, items: result.outcome });
    } catch (error) {
      totals.failed += 1;
      outcomes.push({ receipt_id: candidate.receipt_id, items: [],
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }
  return { candidates, outcomes, totals };
}