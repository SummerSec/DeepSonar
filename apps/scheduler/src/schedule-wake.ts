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
let refreshRequestsDueKick = false;
let kick: (() => void) | null = null;

/** #1287：知识唤醒的集合策略查询很重，按最小间隔回库，不再每次刷新都重跑。 */
let knowledgeProbe: KnowledgeWakeProbeState = { wakeAt: null, probedAt: 0, firedFor: null, refreshRequested: true };
/** #1287：查询在途期间到来的刷新请求要保留，不能被旧结果覆盖掉。 */
let refreshGeneration = 0;

/** 知识工作被写入/推进后调用，下一次刷新立刻回库。 */
export function noteKnowledgeWakeChange(): void {
  // 只在知识真正失效时推进代次：在途探测的旧结果会被丢弃并补查一次。
  knowledgeProbe.refreshRequested = true;
  refreshGeneration += 1;
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

function scanTaskDeadlines(rows: { target_json?: unknown }[], now: number): { nearest: number | null; hasDue: boolean } {
  let nearest: number | null = null;
  let hasDue = false;
  for (const row of rows) {
    const start = readScheduleStartAt(row.target_json);
    if (!start) continue;
    const ms = start.getTime();
    if (ms <= now) { hasDue = true; continue; }
    if (nearest == null || ms < nearest) nearest = ms;
  }
  return { nearest, hasDue };
}

/** 只合并「更早」的候选：等待期间路由可能已经装了更早的普通任务时间。 */
export function earlierDeadline(current: number | null, candidate: number | null): number | null {
  if (candidate == null) return current;
  if (current == null) return candidate;
  return Math.min(current, candidate);
}

/** #1287：普通扫描与知识探测各自单飞，互不等待——A 的定时器触发后必须能立刻重扫并为 B 挂表。 */
let taskRefreshInFlight: Promise<void> | null = null;
let knowledgeProbeInFlight: Promise<void> | null = null;

async function refreshTaskDeadlines(): Promise<void> {
  if (taskRefreshInFlight) return taskRefreshInFlight;
  taskRefreshInFlight = (async () => {
    try {
      const rows = await sql`
        SELECT c.target_json
        FROM jobs j
        INNER JOIN canvases c ON c.id = j.canvas_id
        WHERE j.status = 'pending'
          AND c.status = 'active'
          AND c.target_json->'schedule'->>'start_at' IS NOT NULL
        LIMIT 500`;
      const now = Date.now();
      const tasks = scanTaskDeadlines(rows as { target_json?: unknown }[], now);
      // 已经过去的 armedUntilMs 视为没有定时器，避免挡住新装的时间。
      const armed = armedUntilMs != null && armedUntilMs > now ? armedUntilMs : null;
      const merged = earlierDeadline(armed, tasks.nearest);
      if (merged != null && merged !== armed) armTimer(merged);
      // 按本次普通扫描消费掉 kick 请求：知识侧的静默刷新（kickDueTasks: false）不能借它再触发领取。
      const dueKick = tasks.hasDue && refreshRequestsDueKick;
      refreshRequestsDueKick = false;
      if (dueKick) fireKick();
    } catch (error) {
      console.error("[schedule-wake] task scan failed:", error);
    } finally {
      taskRefreshInFlight = null;
    }
  })();
  return taskRefreshInFlight;
}

async function refreshKnowledgeDeadline(): Promise<void> {
  if (knowledgeProbeInFlight) return knowledgeProbeInFlight;
  const generation = refreshGeneration;
  knowledgeProbeInFlight = (async () => {
    let stale = false;
    try {
      const now = Date.now();
      const knowledge = await probeKnowledgeDeadline(now, generation);
      stale = knowledge.stale;
      const armed = armedUntilMs != null && armedUntilMs > now ? armedUntilMs : null;
      const merged = earlierDeadline(armed, knowledge.nearest);
      if (merged != null && merged !== armed) armTimer(merged);
      if (knowledge.due) fireKick();
    } catch (error) {
      console.error("[schedule-wake] knowledge probe failed:", error);
    } finally {
      knowledgeProbeInFlight = null;
      if (stale || refreshGeneration !== generation) void refreshKnowledgeDeadline();
    }
  })();
  return knowledgeProbeInFlight;
}

/** 知识侧只决定「是否需要回库、到期没到期」；调用前普通任务的定时器已经装好。 */
async function probeKnowledgeDeadline(now: number, generation: number):
  Promise<{ nearest: number | null; due: boolean; stale: boolean }> {
  if (!shouldProbeKnowledgeWake(knowledgeProbe, now)) {
    const ms = knowledgeProbe.wakeAt;
    if (ms == null) return { nearest: null, due: false, stale: false };
    if (ms <= now) return { nearest: null, due: knowledgeProbe.firedFor !== ms, stale: false };
    return { nearest: ms, due: false, stale: false };
  }
  const wake = await readNextKnowledgeWake(sql);
  if (refreshGeneration !== generation) return { nearest: null, due: false, stale: true };
  const ms = wake ? wake.getTime() : null;
  knowledgeProbe = { wakeAt: ms, probedAt: now, refreshRequested: false,
    firedFor: ms != null && ms <= now ? ms : knowledgeProbe.firedFor };
  if (ms == null) return { nearest: null, due: false, stale: false };
  return ms <= now ? { nearest: null, due: true, stale: false } : { nearest: ms, due: false, stale: false };
}

/** Scan pending task and knowledge schedules and arm their nearest durable deadline. */
export async function refreshScheduleWakeFromDb(options?: { kickDueTasks?: boolean }): Promise<void> {
  if (options?.kickDueTasks !== false) refreshRequestsDueKick = true;
  // 普通扫描先跑并且可以独立完成：知识探测再慢也不会挡住下一次普通挂表。
  await refreshTaskDeadlines();
  if (options?.kickDueTasks !== false) {
    // 定时器触发的路径需要尽快返回；知识探测在后台单飞，结果只用于把定时器提前。
    void refreshKnowledgeDeadline();
    return;
  }
  await refreshKnowledgeDeadline();
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
