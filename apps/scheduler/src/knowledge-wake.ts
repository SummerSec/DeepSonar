import type { sql } from "./db.js";
import { automaticPreparationPredicate } from "./domains/project-knowledge/automatic-marker.js";
import { projectCollectionPolicyQuery } from "./domains/project-knowledge/collection-policy.js";

/** Reuse the single Dispatcher timer; no polling loop or additional executor. */
export async function readNextKnowledgeWake(db: typeof sql): Promise<Date | null> {
  const [row] = await db`SELECT MIN(due.wake_at) AS wake_at FROM (
    SELECT w.next_attempt_at AS wake_at FROM project_knowledge_work w
    WHERE w.state='pending' AND NOT ${automaticPreparationPredicate(db)}
      AND NOT EXISTS(SELECT 1 FROM project_knowledge_work active
        WHERE active.project_id=w.project_id AND active.state='running')
    UNION ALL
    SELECT wake_at FROM (${projectCollectionPolicyQuery(db)}) collection
  ) due`;
  return row?.wake_at ? new Date(row.wake_at as string) : null;
}

/** #1287：Dispatcher 每次刷新都会重跑集合策略查询（44k audit_logs 时 6–11s），
 * 这里只决定「这次刷新要不要回库」，不改变唤醒语义本身。 */
export type KnowledgeWakeProbeState = {
  /** 上次查到的最近唤醒时间（毫秒）；null 表示上次没有唤醒。 */
  wakeAt: number | null;
  /** 上次回库时间（毫秒）。 */
  probedAt: number;
  /** 最近一次唤醒已经触发过 kick，避免同一条 due 反复回库。 */
  firedFor: number | null;
  /** 知识工作被写入/推进后的显式失效请求。 */
  refreshRequested: boolean;
};

export const DEFAULT_KNOWLEDGE_PROBE_INTERVAL_MS = 30_000;

export function knowledgeProbeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DEEPSONAR_KNOWLEDGE_PROBE_INTERVAL_MS);
  return Number.isSafeInteger(raw) && raw >= 0 && raw <= 300_000 ? raw : DEFAULT_KNOWLEDGE_PROBE_INTERVAL_MS;
}

/** 只有真需要新数字时才回库：显式失效、到期、或超过最小回库间隔。 */
export function shouldProbeKnowledgeWake(state: KnowledgeWakeProbeState, now: number,
  intervalMs: number = knowledgeProbeIntervalMs()): boolean {
  if (state.refreshRequested) return true;
  const elapsed = now - state.probedAt;
  if (state.wakeAt === null) return elapsed >= intervalMs;
  if (state.wakeAt > now) return false;
  if (state.firedFor === state.wakeAt) return elapsed >= intervalMs;
  return true;
}
