import type { sql } from "./db.js";
import { automaticPreparationPredicate } from "./domains/project-knowledge/automatic-marker.js";
import { projectCollectionPolicyQuery } from "./domains/project-knowledge/collection-policy.js";

/** #1287：集合策略查询要扫 audit_logs，实测 6–11s；Dispatcher 每次刷新都会触发一次，
 * 于是同一个重查询被近乎连续地重跑，把事件循环与所有端点一起拖慢。这里做短 TTL 缓存：
 * 唤醒时间本身是「到点才需要精确」的，30s 内重复读没有意义。 */
const DEFAULT_WAKE_TTL_MS = 30_000;

let cached: { at: number; value: Date | null } | null = null;

/** 知识工作被写入/推进后主动失效，避免等到 TTL 才看到新的唤醒。 */
export function invalidateKnowledgeWake(): void {
  cached = null;
}

export function knowledgeWakeTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DEEPSONAR_KNOWLEDGE_WAKE_TTL_MS);
  return Number.isSafeInteger(raw) && raw >= 0 && raw <= 300_000 ? raw : DEFAULT_WAKE_TTL_MS;
}

/** Reuse the single Dispatcher timer; no polling loop or additional executor. */
export async function readNextKnowledgeWake(db: typeof sql, options: { fresh?: boolean } = {}): Promise<Date | null> {
  const at = Date.now();
  if (!options.fresh && cached && at - cached.at < knowledgeWakeTtlMs()) return cached.value;
  const [row] = await db`SELECT MIN(due.wake_at) AS wake_at FROM (
    SELECT w.next_attempt_at AS wake_at FROM project_knowledge_work w
    WHERE w.state='pending' AND NOT ${automaticPreparationPredicate(db)}
      AND NOT EXISTS(SELECT 1 FROM project_knowledge_work active
        WHERE active.project_id=w.project_id AND active.state='running')
    UNION ALL
    SELECT wake_at FROM (${projectCollectionPolicyQuery(db)}) collection
  ) due`;
  const value = row?.wake_at ? new Date(row.wake_at as string) : null;
  cached = { at, value };
  return value;
}
