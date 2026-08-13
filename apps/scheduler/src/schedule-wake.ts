/**
 * Event-driven dispatcher wake for future task schedules.
 *
 * When DEEPSONAR_DISPATCH_POLL_SEC=0 (default), pending jobs that are only
 * blocked by schedule.start_at would never be claimed without a timer.
 * This module arms a single process timer for the nearest future start_at.
 */

import { sql } from "./db.js";
import { readScheduleStartAt } from "./task-schedule.js";

/** Node timers saturate around 2^31-1 ms; clamp and re-arm from DB. */
const MAX_TIMER_MS = 2_147_483_647;
/** Fire slightly after the wall time so claim sees start_at <= now(). */
const WAKE_SLACK_MS = 25;

let timer: ReturnType<typeof setTimeout> | null = null;
let armedUntilMs: number | null = null;
let refreshInFlight: Promise<void> | null = null;
let kick: (() => void) | null = null;

/** Wire the dispatcher kick once at boot to avoid a module cycle. */
export function bindScheduleWake(kickDispatcher: () => void): void {
  kick = kickDispatcher;
}

function fireKick(): void {
  kick?.();
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

/** Scan pending jobs and arm the nearest future canvas schedule. */
export async function refreshScheduleWakeFromDb(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
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
      const now = Date.now();
      for (const row of rows) {
        const start = readScheduleStartAt(row.target_json);
        if (!start) continue;
        const ms = start.getTime();
        if (ms <= now) {
          fireKick();
          continue;
        }
        if (nearest == null || ms < nearest) nearest = ms;
      }
      if (nearest != null) armTimer(nearest);
      else clearArmedTimer();
    } catch (error) {
      console.error("[schedule-wake] refresh failed:", error);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function armTimer(targetMs: number): void {
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
