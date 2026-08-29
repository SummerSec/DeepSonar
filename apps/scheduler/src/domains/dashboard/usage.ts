import { sql } from "../../db.js";
import {
  DASHBOARD_CALENDAR_TIMEZONE,
  dayKey,
  shanghaiStartUtc,
  shanghaiYmd,
  shiftYmd,
} from "./overview.js";

export const USAGE_PERIODS = ["day", "week", "month", "custom"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const USAGE_TOP_N = 8;
export const USAGE_MAX_DAYS = 366;
const PRESET_DAYS: Record<Exclude<UsagePeriod, "custom">, number> = { day: 1, week: 7, month: 30 };
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface UsageTokenTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  jobs: number;
  projects: number;
  tasks: number;
  settled: number;
  unknown: number;
  not_reported: number;
}

export interface UsageSeriesDay extends Pick<UsageTokenTotals, "requests" | "input_tokens" | "output_tokens" | "total_tokens"> {
  date: string;
}

export interface UsageProjectRow extends Pick<UsageTokenTotals, "requests" | "input_tokens" | "output_tokens" | "total_tokens" | "jobs" | "tasks"> {
  id: string;
  name: string;
}

export interface UsageTaskRow extends Pick<UsageTokenTotals, "requests" | "input_tokens" | "output_tokens" | "total_tokens" | "jobs"> {
  canvas_id: string | null;
  title: string;
  project_id: string;
  project_name: string;
}

export interface UsageModelRow extends Pick<UsageTokenTotals, "requests" | "input_tokens" | "output_tokens" | "total_tokens"> {
  provider: string;
  model: string;
}

export interface UsageWindow {
  period: UsagePeriod;
  now: Date;
  start: Date;
  endExclusive: Date;
  days: string[];
}

export interface UsageQueryError {
  ok: false;
  error: string;
  error_code: string;
}

export interface DashboardUsage {
  generated_at: string;
  calendar_timezone: string;
  period: UsagePeriod;
  range: { start: string; end: string; days: string[] };
  totals: UsageTokenTotals;
  series: UsageSeriesDay[];
  projects: UsageProjectRow[];
  tasks: UsageTaskRow[];
  models: UsageModelRow[];
}

export interface UsageLedgerRow {
  observed_at: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  settlement_status: string;
  provider: string;
  model: string;
  job_id: string;
  project_id: string;
  project_name: string;
  canvas_id: string | null;
  canvas_title: string | null;
}

export function parseUsagePeriod(value: unknown, hasCustomRange: boolean): UsagePeriod {
  if (USAGE_PERIODS.includes(value as UsagePeriod)) return value as UsagePeriod;
  return hasCustomRange ? "custom" : "week";
}

export function isShanghaiYmd(value: string): boolean {
  if (!YMD.test(value)) return false;
  return shanghaiYmd(shanghaiStartUtc(value)) === value;
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function daysBetween(startYmd: string, endYmd: string): string[] {
  const days = [startYmd];
  let cursor = startYmd;
  while (cursor < endYmd) {
    cursor = shiftYmd(cursor, 1);
    days.push(cursor);
    if (days.length > USAGE_MAX_DAYS) break;
  }
  return days;
}

function clampEndExclusive(endExclusive: Date, now: Date): Date {
  return endExclusive.getTime() > now.getTime() ? now : endExclusive;
}

export function resolveUsageWindow(input: {
  period?: unknown;
  from?: unknown;
  to?: unknown;
  now?: Date;
}): UsageWindow | UsageQueryError {
  const now = input.now ?? new Date();
  const fromRaw = typeof input.from === "string" ? input.from.trim() : "";
  const toRaw = typeof input.to === "string" ? input.to.trim() : "";
  const period = parseUsagePeriod(input.period, Boolean(fromRaw || toRaw));

  if (period !== "custom") {
    const today = shanghaiYmd(now);
    const length = PRESET_DAYS[period];
    const days = Array.from({ length }, (_, index) => shiftYmd(today, index - (length - 1)));
    return {
      period,
      now,
      start: shanghaiStartUtc(days[0]!),
      endExclusive: now,
      days,
    };
  }

  if (!fromRaw || !toRaw) {
    return { ok: false, error: "自定义时间需要 from 与 to", error_code: "USAGE_RANGE_REQUIRED" };
  }

  const start = isShanghaiYmd(fromRaw) ? shanghaiStartUtc(fromRaw) : parseInstant(fromRaw);
  const endExclusive = isShanghaiYmd(toRaw)
    ? shanghaiStartUtc(shiftYmd(toRaw, 1))
    : parseInstant(toRaw);
  if (!start || !endExclusive) {
    return { ok: false, error: "from / to 不是有效日期或时间", error_code: "USAGE_RANGE_INVALID" };
  }
  if (start.getTime() >= endExclusive.getTime()) {
    return { ok: false, error: "开始时间必须早于结束时间", error_code: "USAGE_RANGE_ORDER" };
  }
  if (start.getTime() > now.getTime()) {
    return { ok: false, error: "开始时间不能晚于当前时刻", error_code: "USAGE_RANGE_IN_FUTURE" };
  }

  const boundedEnd = clampEndExclusive(endExclusive, now);
  const firstDay = shanghaiYmd(start);
  const lastDay = shanghaiYmd(new Date(boundedEnd.getTime() - 1));
  const days = daysBetween(firstDay, lastDay);
  if (days.length > USAGE_MAX_DAYS) {
    return { ok: false, error: `自定义跨度最多 ${USAGE_MAX_DAYS} 天`, error_code: "USAGE_RANGE_TOO_LONG" };
  }
  return { period: "custom", now, start, endExclusive: boundedEnd, days };
}

function emptyTotals(): UsageTokenTotals {
  return {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    jobs: 0,
    projects: 0,
    tasks: 0,
    settled: 0,
    unknown: 0,
    not_reported: 0,
  };
}

function emptyDay(date: string): UsageSeriesDay {
  return { date, requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function addTokens(
  target: Pick<UsageTokenTotals, "requests" | "input_tokens" | "output_tokens" | "total_tokens">,
  row: Pick<UsageLedgerRow, "input_tokens" | "output_tokens" | "total_tokens">,
): void {
  target.requests += 1;
  target.input_tokens += asCount(row.input_tokens);
  target.output_tokens += asCount(row.output_tokens);
  target.total_tokens += asCount(row.total_tokens);
}

function rankByTotal<T extends { total_tokens: number; requests: number }>(rows: T[]): T[] {
  return [...rows].sort((left, right) =>
    right.total_tokens - left.total_tokens
    || right.requests - left.requests);
}

export function buildDashboardUsage(input: {
  window: UsageWindow;
  rows: readonly UsageLedgerRow[];
}): DashboardUsage {
  const { window } = input;
  const totals = emptyTotals();
  const series = new Map(window.days.map((date) => [date, emptyDay(date)]));
  const projects = new Map<string, UsageProjectRow & { jobIds: Set<string>; taskIds: Set<string> }>();
  const tasks = new Map<string, UsageTaskRow & { jobIds: Set<string> }>();
  const models = new Map<string, UsageModelRow>();
  const jobIds = new Set<string>();
  const projectIds = new Set<string>();
  const taskIds = new Set<string>();

  for (const row of input.rows) {
    addTokens(totals, row);
    jobIds.add(row.job_id);
    projectIds.add(row.project_id);
    if (row.canvas_id) taskIds.add(row.canvas_id);
    if (row.settlement_status === "unknown") totals.unknown += 1;
    else if (row.settlement_status === "not_reported") totals.not_reported += 1;
    else totals.settled += 1;

    const date = dayKey(row.observed_at);
    if (date && series.has(date)) addTokens(series.get(date)!, row);

    const project = projects.get(row.project_id) ?? {
      id: row.project_id,
      name: row.project_name || "未命名项目",
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      jobs: 0,
      tasks: 0,
      jobIds: new Set<string>(),
      taskIds: new Set<string>(),
    };
    addTokens(project, row);
    project.jobIds.add(row.job_id);
    if (row.canvas_id) project.taskIds.add(row.canvas_id);
    projects.set(row.project_id, project);

    const taskKey = row.canvas_id ?? `job:${row.job_id}`;
    const task = tasks.get(taskKey) ?? {
      canvas_id: row.canvas_id,
      title: row.canvas_title?.trim() || (row.canvas_id ? "未命名任务" : "未绑定画布"),
      project_id: row.project_id,
      project_name: row.project_name || "未命名项目",
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      jobs: 0,
      jobIds: new Set<string>(),
    };
    addTokens(task, row);
    task.jobIds.add(row.job_id);
    tasks.set(taskKey, task);

    const modelKey = `${row.provider}::${row.model}`;
    const model = models.get(modelKey) ?? {
      provider: row.provider || "unknown",
      model: row.model || "—",
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
    addTokens(model, row);
    models.set(modelKey, model);
  }

  totals.jobs = jobIds.size;
  totals.projects = projectIds.size;
  totals.tasks = taskIds.size;
  for (const project of projects.values()) {
    project.jobs = project.jobIds.size;
    project.tasks = project.taskIds.size;
  }
  for (const task of tasks.values()) task.jobs = task.jobIds.size;

  return {
    generated_at: window.now.toISOString(),
    calendar_timezone: DASHBOARD_CALENDAR_TIMEZONE,
    period: window.period,
    range: {
      start: window.start.toISOString(),
      end: window.endExclusive.toISOString(),
      days: window.days,
    },
    totals,
    series: window.days.map((date) => series.get(date)!),
    projects: rankByTotal([...projects.values()]).slice(0, USAGE_TOP_N).map(({ jobIds: _jobs, taskIds: _tasks, ...row }) => row),
    tasks: rankByTotal([...tasks.values()]).slice(0, USAGE_TOP_N).map(({ jobIds: _jobs, ...row }) => row),
    models: rankByTotal([...models.values()]).slice(0, USAGE_TOP_N),
  };
}

function asIso(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export async function loadDashboardUsage(input: {
  window: UsageWindow;
  projectId?: string | null;
  canvasId?: string | null;
}): Promise<DashboardUsage> {
  const projectId = input.projectId ?? null;
  const canvasId = input.canvasId ?? null;
  const rows = await sql<Record<string, unknown>[]>`
    SELECT u.observed_at, u.input_tokens, u.output_tokens, u.total_tokens,
           u.settlement_status, u.provider, u.model, u.job_id, u.project_id,
           p.name AS project_name, j.canvas_id, c.title AS canvas_title
    FROM job_usage_ledger u
    JOIN jobs j ON j.id = u.job_id
    JOIN projects p ON p.id = u.project_id
    LEFT JOIN canvases c ON c.id = j.canvas_id
    WHERE u.observed_at >= ${input.window.start}
      AND u.observed_at < ${input.window.endExclusive}
      AND (${projectId}::uuid IS NULL OR u.project_id = ${projectId}::uuid)
      AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId}::text)`;

  return buildDashboardUsage({
    window: input.window,
    rows: rows.map((row) => ({
      observed_at: asIso(row.observed_at) ?? input.window.now.toISOString(),
      input_tokens: asCount(row.input_tokens),
      output_tokens: asCount(row.output_tokens),
      total_tokens: asCount(row.total_tokens),
      settlement_status: asText(row.settlement_status),
      provider: asText(row.provider),
      model: asText(row.model),
      job_id: asText(row.job_id),
      project_id: asText(row.project_id),
      project_name: asText(row.project_name),
      canvas_id: typeof row.canvas_id === "string" && row.canvas_id ? row.canvas_id : null,
      canvas_title: typeof row.canvas_title === "string" ? row.canvas_title : null,
    })),
  });
}
