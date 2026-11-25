/**
 * 人工处置写入（#1264）：处置、证据追加与审计必须落在同一个事务里。
 *
 * 证据列只追加：合并与去重直接写进 UPDATE 的 SET 表达式，由数据库读取最新行，
 * 因此并发的两笔追加都会保留，也没有「先读后写」的旧快照覆盖问题。
 * 审计 before 来自事务内 FOR UPDATE 读到的行，确保记录的是这次真正覆盖的状态。
 */
import type { FastifyRequest } from "fastify";
import type { sql } from "../../db.js";
import { recordDurableAudit } from "../../audit.js";

export interface HumanDispositionInput {
  findingId: string;
  disposition: string;
  note?: string | null;
  duplicateOf: string | null;
  actorName: string;
  evidenceRefs: readonly string[];
}

export async function applyHumanDisposition(
  req: FastifyRequest,
  db: typeof sql,
  input: HumanDispositionInput,
): Promise<Record<string, unknown> | null> {
  return db.begin(async (tx) => {
    const [current] = await tx`
      SELECT id, disposition, verify_status, project_id FROM findings
      WHERE id = ${input.findingId} FOR UPDATE`;
    if (!current) return null;
    const [row] = await tx`
      UPDATE findings SET
        disposition = ${input.disposition},
        disposition_note = ${input.note ?? null},
        disposition_by = ${input.actorName},
        disposition_at = now(),
        duplicate_of = ${input.duplicateOf},
        updated_at = now(),
        evidence_refs_json = CASE
          WHEN ${input.evidenceRefs.length} = 0 THEN evidence_refs_json
          ELSE (
            SELECT COALESCE(jsonb_agg(DISTINCT merged.value), '[]'::jsonb)
            FROM jsonb_array_elements_text(evidence_refs_json || ${tx.json(input.evidenceRefs as never)}::jsonb) AS merged(value)
          )
        END
      WHERE id = ${input.findingId}
      RETURNING *`;
    // SAFETY: TransactionSql 与 Sql 只差事务句柄，仍是同一个连接上的同一个标签函数。
    await recordDurableAudit(req, {
      action: "finding.disposition",
      resourceType: "finding",
      resourceId: input.findingId,
      projectId: row.project_id as string,
      before: { disposition: current.disposition, verify_status: current.verify_status },
      after: {
        disposition: input.disposition,
        disposition_source: "human",
        note: input.note ?? null,
        duplicate_of: input.duplicateOf,
        evidence_refs: [...input.evidenceRefs],
        verify_status: row.verify_status,
      },
    }, tx as unknown as typeof sql);
    return row as Record<string, unknown>;
  });
}
