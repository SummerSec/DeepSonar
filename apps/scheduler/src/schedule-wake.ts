/**
 * Event-driven dispatcher wake for future task schedules.
 *
 * When DEEPSONAR_DISPATCH_POLL_SEC=0 (default), pending jobs that are only
 * blocked by schedule.start_at would never be claimed without a timer.
 * This module arms a single process timer for the nearest future start_at.
 */

import { sql } from "./db.js";
import { readScheduleStartAt } from "./task-schedule.js";
import { readNextKnowledgeWake, shouldProbeKnowledgeWake, type KnowledgeWakeProbeState } from "./knowledge-wake.js";

/** Node timers saturate around 2^31-1 ms; clamp and re-arm from DB. */
const MAX_TIMER_MS = 2_147_483_647;
/** Fire slightly after the wall time so claim sees start_at <= now(). */
const WAKE_SLACK_MS = 25;
const CLAIM_CONTENTION_RETRY_MS = 250;
const CREDENTIAL_CAPACITY_RETRY_MS = 5_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let claimContentionTimer: ReturnType<typeof setTimeout> | null = null;
let credentialCapacityTimer: ReturnType<typeof setTimeout> | null = null;
let armedUntilMs: number | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshRequestsDueKick = false;
let kick: (() => void) | null = null;

/** #1287：知识唤醒的集合策略查询很重，按最小间隔回库，不再每次刷新都重跑。 */
let knowledgeProbe: KnowledgeWakeProbeState = { wakeAt: null, probedAt: 0, firedFor: null, refreshRequested: true };
/** #1287：查询在途期间到来的刷新请求要保留，不能被旧结果覆盖掉。 */
let refreshGeneration = 0;

/** 知识工作被写入/推进后调用，下一次刷新立刻回库。 */
export function noteKnowledgeWakeChange(): void {
  knowledgeProbe.refreshRequested = true;
}

/** Wire the dispatcher kick once at boot to avoid a module cycle. */
export function bindScheduleWake(kickDispatcher: () => void): void {
  kick = kickDispatcher;
}

/** Freeze must also prevent an in-flight refresh from rearming the timer. */
export function unbindScheduleWake(): void {
  kick = null;
  clearArmedTimer();
  if (claimContentionTimer) clearTimeout(claimContentionTimer);
  claimContentionTimer = null;
  if (credentialCapacityTimer) clearTimeout(credentialCapacityTimer);
  credentialCapacityTimer = null;
}

function fireKick(): void {
  kick?.();
}

/** SKIP LOCKED consumes a wake without guaranteeing another NOTIFY on unlock.
 * Retry only an observed incomplete claim scan, coalescing into one timer.
 * Keep it separate from future task/knowledge deadlines, which DB refresh owns. */
export function noteClaimContentionWake(): void {
  if (!kick || claimContentionTimer) return;
  claimContentionTimer = setTimeout(() => {
    claimContentionTimer = null;
    fireKick();
  }, CLAIM_CONTENTION_RETRY_MS);
  claimContentionTimer.unref?.();
}

/** Coalesce observed quota waits. Pending time never consumes execution timeout. */
export function noteCredentialCapacityWake(): void {
  if (!kick || credentialCapacityTimer) return;
  credentialCapacityTimer = setTimeout(() => {
    credentialCapacityTimer = null;
    fireKick();
  }, CREDENTIAL_CAPACITY_RETRY_MS);
  credentialCapacityTimer.unref?.();
}

export function noteScheduleWakeAt(at: Date | number | string | null | undefined): void {
  if (at == null) return;
  const ms = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(ms)) return;
  const now = Date.now();
  if (ms <= now + WAKE_SLACK_MS) {
    clearArmedTimer();
    fireKick();
    return;
  }
  if (armedUntilMs != null && ms >= armedUntilMs && timer) return;
  armTimer(ms);
}

export function clearScheduleWake(): void {
  clearArmedTimer();
}

/** Scan pending task and knowledge schedules and arm their nearest durable deadline. */
export async function refreshScheduleWakeFromDb(options?: { kickDueTasks?: boolean }): Promise<void> {
  if (options?.kickDueTasks !== false) refreshRequestsDueKick = true;
  if (refreshInFlight) { refreshGeneration += 1; return refreshInFlight; }
  const generation = refreshGeneration;
  refreshInFlight = (async () => {
    let stale = false;
    try {
      const rows = await sql`
        SELECT c.target_json
        FROM jobs j
        INNER JOIN canvases c ON c.id = j.canvas_id
        WHERE j.status = 'pending'
          AND c.status = 'active'
          AND c.target_json->'schedule'->>'start_at' IS NOT NULL
        LIMIT 500`;
      let nearest: number | null = null;
      let hasDue = false;
      const now = Date.now();
      for (const row of rows) {
        const start = readScheduleStartAt(row.target_json);
        if (!start) continue;
        const ms = start.getTime();
        if (ms <= now) {
          hasDue = true;
          continue;
        }
        if (nearest == null || ms < nearest) nearest = ms;
      }
      let knowledgeDue = false;
      if (shouldProbeKnowledgeWake(knowledgeProbe, now)) {
        const knowledgeWake = await readNextKnowledgeWake(sql);
        // 查询在途期间有新请求进来：旧结果一律丢弃，稍后重新查。
        if (refreshGeneration !== generation) {
          stale = true;
        } else {
          const ms = knowledgeWake ? knowledgeWake.getTime() : null;
          knowledgeProbe = { wakeAt: ms, probedAt: now, refreshRequested: false,
            firedFor: ms != null && ms <= now ? ms : knowledgeProbe.firedFor };
          if (ms != null) {
            if (ms <= now) knowledgeDue = true;
            else if (nearest == null || ms < nearest) nearest = ms;
          }
        }
      } else if (knowledgeProbe.wakeAt != null) {
        const ms = knowledgeProbe.wakeAt;
        // 同一条到期只 kick 一次，不能靠缓存反复触发。
        if (ms <= now && knowledgeProbe.firedFor !== ms) knowledgeDue = true;
        else if (ms > now && (nearest == null || ms < nearest)) nearest = ms;
      }
      if (nearest != null) armTimer(nearest);
      else clearArmedTimer();
      if (knowledgeDue || (hasDue && refreshRequestsDueKick)) fireKick();
    } catch (error) {
      console.error("[schedule-wake] refresh failed:", error);
    } finally {
      refreshInFlight = null;
      refreshRequestsDueKick = false;
      if (stale || refreshGeneration !== generation) void refreshScheduleWakeFromDb({ kickDueTasks: false });
    }
  })();
  return refreshInFlight;
}

function armTimer(targetMs: number): void {
  if (!kick) return;
  clearArmedTimer();
  armedUntilMs = targetMs;
  const delay = Math.min(Math.max(targetMs - Date.now() + WAKE_SLACK_MS, 1), MAX_TIMER_MS);
  timer = setTimeout(() => {
    timer = null;
    armedUntilMs = null;
    fireKick();
    // After claim attempt, re-arm for any remaining future schedules.
    void refreshScheduleWakeFromDb();
  }, delay);
  // Allow process exit while only a schedule timer is pending.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }
}

function clearArmedTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  armedUntilMs = null;
}
