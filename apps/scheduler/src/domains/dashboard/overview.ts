import { taskExecutionState } from "../../task-execution-control.js";
import { sql } from "../../db.js";

export const DASHBOARD_CALENDAR_TIMEZONE = "Asia/Shanghai";
export const DASHBOARD_TOP_PROJECTS = 5;
export const DASHBOARD_RECENT_ACTIVITY = 12;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const ACTIVE_JOB_STATUSES = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
] as const;

export const JOB_STATUS_KEYS = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "timeout",
  "orphan",
  "cancelled",
] as const;

export const FINDING_STATUS_KEYS = [
  "pending",
  "verifying",
  "confirmed",
  "needs_human",
  "false_positive",
] as const;

export const PROJECT_STATUS_KEYS = ["active", "archived"] as const;

export const TASK_STATUS_KEYS = [
  "running",
  "pausing",
  "paused",
  "reporting",
  "analysis_complete",
  "completed",
  "failed",
  "idle",
  "archived",
] as const;

export type DashboardTaskStatus = (typeof TASK_STATUS_KEYS)[number];

export interface DashboardStatusBucket {
  key: string;
  count: number;
}

export interface DashboardPeriodCounts {
  new_tasks: number;
  completed_tasks: number;
  new_findings: number;
}

export interface DashboardTrendDay extends DashboardPeriodCounts {
  date: string;
}

export interface DashboardActiveProject {
  id: string;
  name: string;
  status: "active" | "archived";
  active_jobs: number;
  task_count: number;
  finding_count: number;
  last_activity_at: string | null;
}

export interface DashboardActivityItem {
  id: string;
  kind: "task" | "job" | "finding";
  title: string;
  at: string;
  project_id: string;
  project_name: string;
  canvas_id: string | null;
  status?: string;
}

export interface DashboardOverview {
  generated_at: string;
  calendar_timezone: string;
  totals: {
    projects: number;
    tasks: number;
    jobs: number;
    findings: number;
  };
  distributions: {
    projects: DashboardStatusBucket[];
    tasks: DashboardStatusBucket[];
    jobs: DashboardStatusBucket[];
    findings: DashboardStatusBucket[];
  };
  periods: {
    today: DashboardPeriodCounts;
    last_7d: DashboardPeriodCounts;
  };
  trend_7d: DashboardTrendDay[];
  active_projects: DashboardActiveProject[];
  recent_activity: DashboardActivityItem[];
}

export interface DashboardTaskRow {
  id: string;
  project_id: string;
  title: string;
  status?: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  job_count: number;
  active_count: number;
  root_status: string | null;
  report_status: string | null;
  target_json?: unknown;
}

export interface DashboardWindow {
  now: Date;
  todayStart: Date;
  last7Start: Date;
  days: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalized(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isFailure(value: string): boolean {
  return ["failed", "failure", "error", "timeout", "cancelled", "orphan"].includes(value) || value.endsWith("_failed");
}

function isSuccess(value: string): boolean {
  return ["succeeded", "success", "completed", "complete"].includes(value);
}

function isReportGeneration(value: string): boolean {
  return ["reporting", "pending", "generating"].includes(value);
}

export function shanghaiYmd(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function shanghaiStartUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00+08:00`);
}

export function shiftYmd(ymd: string, deltaDays: number): string {
  return shanghaiYmd(new Date(shanghaiStartUtc(ymd).getTime() + deltaDays * 86_400_000));
}

export function dashboardWindow(now: Date = new Date()): DashboardWindow {
  const today = shanghaiYmd(now);
  const days = Array.from({ length: 7 }, (_, index) => shiftYmd(today, index - 6));
  return {
    now,
    todayStart: shanghaiStartUtc(today),
    last7Start: shanghaiStartUtc(days[0]!),
    days,
  };
}

export function inRange(iso: string | null | undefined, start: Date, end: Date): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= start.getTime() && ms <= end.getTime();
}

export function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? shanghaiYmd(new Date(ms)) : null;
}

/**
 * Task buckets follow the same precedence as the web task lifecycle:
 * archived > active work (incl. pause) > failure > report phase >
 * analysis complete > completion > idle. Scheduled wait stays in running
 * because those canvases still occupy the active Job queue.
 */
export function classifyDashboardTask(row: DashboardTaskRow, now: Date = new Date()): DashboardTaskStatus {
  const archived = normalized(row.status) === "archived";
  const rootStatus = normalized(row.root_status);
  const reportStatus = normalized(row.report_status);
  const jobCount = Math.max(0, Math.floor(row.job_count || 0));
  const activeCount = Math.max(0, Math.floor(row.active_count || 0));
  const executionState = taskExecutionState(row.target_json, activeCount);
  const schedule = asRecord(asRecord(row.target_json).schedule).start_at;
  const scheduledMs = typeof schedule === "string" ? Date.parse(schedule) : Number.NaN;
  const waitingOnSchedule =
    Number.isFinite(scheduledMs)
    && scheduledMs > now.getTime()
    && !row.started_at
    && activeCount > 0;

  if (archived) return "archived";
  if (waitingOnSchedule) return "running";
  if (executionState === "pausing") return "pausing";
  if (executionState === "paused") return "paused";
  if (activeCount > 0) return "running";
  if (isFailure(rootStatus) || isFailure(reportStatus)) return "failed";
  if (rootStatus === "reporting" || isReportGeneration(reportStatus)) return "reporting";
  if (rootStatus === "analysis_complete") return "analysis_complete";
  if (jobCount > 0 && row.ended_at) return "completed";
  return "idle";
}

export function fillDistribution(keys: readonly string[], rows: Iterable<{ key: string; count: number }>): DashboardStatusBucket[] {
  const counts = new Map(keys.map((key) => [key, 0]));
  for (const row of rows) {
    counts.set(row.key, (counts.get(row.key) ?? 0) + Math.max(0, Math.floor(row.count || 0)));
  }
  return keys.map((key) => ({ key, count: counts.get(key) ?? 0 }));
}

export function emptyPeriod(): DashboardPeriodCounts {
  return { new_tasks: 0, completed_tasks: 0, new_findings: 0 };
}

export function emptyTrend(days: readonly string[]): DashboardTrendDay[] {
  return days.map((date) => ({ date, ...emptyPeriod() }));
}

export function buildDashboardOverview(input: {
  now?: Date;
  projects: Iterable<{ key: string; count: number }>;
  jobs: Iterable<{ key: string; count: number }>;
  findings: Iterable<{ key: string; count: number }>;
  tasks: readonly DashboardTaskRow[];
  findingCreatedAt: readonly string[];
  activeProjects: readonly DashboardActiveProject[];
  recentActivity: readonly DashboardActivityItem[];
}): DashboardOverview {
  const window = dashboardWindow(input.now ?? new Date());
  const taskStatuses = input.tasks.map((task) => ({ task, status: classifyDashboardTask(task, window.now) }));
  const taskBuckets = new Map<string, number>();
  const today = emptyPeriod();
  const last7d = emptyPeriod();
  const trend = new Map(window.days.map((date) => [date, emptyPeriod()]));

  const bump = (period: DashboardPeriodCounts, field: keyof DashboardPeriodCounts) => {
    period[field] += 1;
  };

  for (const { task, status } of taskStatuses) {
    taskBuckets.set(status, (taskBuckets.get(status) ?? 0) + 1);
    if (inRange(task.created_at, window.last7Start, window.now)) {
      bump(last7d, "new_tasks");
      if (inRange(task.created_at, window.todayStart, window.now)) bump(today, "new_tasks");
      const createdDay = dayKey(task.created_at);
      if (createdDay && trend.has(createdDay)) bump(trend.get(createdDay)!, "new_tasks");
    }
    if (status === "completed" && inRange(task.ended_at, window.last7Start, window.now)) {
      bump(last7d, "completed_tasks");
      if (inRange(task.ended_at, window.todayStart, window.now)) bump(today, "completed_tasks");
      const endedDay = dayKey(task.ended_at);
      if (endedDay && trend.has(endedDay)) bump(trend.get(endedDay)!, "completed_tasks");
    }
  }

  for (const createdAt of input.findingCreatedAt) {
    if (!inRange(createdAt, window.last7Start, window.now)) continue;
    bump(last7d, "new_findings");
    if (inRange(createdAt, window.todayStart, window.now)) bump(today, "new_findings");
    const createdDay = dayKey(createdAt);
    if (createdDay && trend.has(createdDay)) bump(trend.get(createdDay)!, "new_findings");
  }

  const projectDist = fillDistribution(PROJECT_STATUS_KEYS, input.projects);
  const jobDist = fillDistribution(JOB_STATUS_KEYS, input.jobs);
  const findingDist = fillDistribution(FINDING_STATUS_KEYS, input.findings);
  const taskDist = fillDistribution(TASK_STATUS_KEYS, [...taskBuckets].map(([key, count]) => ({ key, count })));

  return {
    generated_at: window.now.toISOString(),
    calendar_timezone: DASHBOARD_CALENDAR_TIMEZONE,
    totals: {
      projects: projectDist.reduce((sum, item) => sum + item.count, 0),
      tasks: taskDist.reduce((sum, item) => sum + item.count, 0),
      jobs: jobDist.reduce((sum, item) => sum + item.count, 0),
      findings: findingDist.reduce((sum, item) => sum + item.count, 0),
    },
    distributions: {
      projects: projectDist,
      tasks: taskDist,
      jobs: jobDist,
      findings: findingDist,
    },
    periods: { today, last_7d: last7d },
    trend_7d: window.days.map((date) => ({ date, ...trend.get(date)! })),
    active_projects: [...input.activeProjects]
      .sort((left, right) =>
        right.active_jobs - left.active_jobs
        || right.finding_count - left.finding_count
        || right.task_count - left.task_count
        || (right.last_activity_at ?? "").localeCompare(left.last_activity_at ?? ""))
      .slice(0, DASHBOARD_TOP_PROJECTS),
    recent_activity: [...input.recentActivity]
      .sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id))
      .slice(0, DASHBOARD_RECENT_ACTIVITY),
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

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export async function loadDashboardOverview(
  projectId: string | null = null,
  now: Date = new Date(),
): Promise<DashboardOverview> {
  const window = dashboardWindow(now);
  const [
    projectRows,
    jobRows,
    findingRows,
    taskRows,
    findingCreatedRows,
    activeProjectRows,
    recentTasks,
    recentJobs,
    recentFindings,
  ] = await Promise.all([
    sql<{ status: string; count: number }[]>`
      SELECT status, COUNT(*)::int AS count
      FROM projects
      WHERE (${projectId}::uuid IS NULL OR id = ${projectId}::uuid)
      GROUP BY status`,
    sql<{ status: string; count: number }[]>`
      SELECT status, COUNT(*)::int AS count
      FROM jobs
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
      GROUP BY status`,
    sql<{ verify_status: string; count: number }[]>`
      SELECT verify_status, COUNT(*)::int AS count
      FROM findings
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
      GROUP BY verify_status`,
    sql<Record<string, unknown>[]>`
      SELECT c.id, c.project_id, c.title, c.status, c.created_at, c.target_json,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id) AS job_count,
        (SELECT COUNT(*)::int FROM jobs j WHERE j.canvas_id = c.id
           AND j.status IN ('pending','claimed','provisioning','running','waiting_human')) AS active_count,
        (SELECT MIN(j.started_at) FROM jobs j WHERE j.canvas_id = c.id) AS started_at,
        (SELECT CASE
           WHEN COUNT(*) FILTER (WHERE j.status IN ('pending','claimed','provisioning','running','waiting_human')) = 0
           THEN MAX(j.finished_at)
           ELSE NULL
         END FROM jobs j WHERE j.canvas_id = c.id) AS ended_at,
        (SELECT n.status FROM canvas_nodes n
         WHERE n.canvas_id = c.id AND n.node_type = 'root'
         ORDER BY n.updated_at DESC LIMIT 1) AS root_status,
        (SELECT n.status FROM canvas_nodes n
         WHERE n.canvas_id = c.id AND n.node_type = 'report'
         ORDER BY n.updated_at DESC LIMIT 1) AS report_status
      FROM canvases c
      WHERE (${projectId}::uuid IS NULL OR c.project_id = ${projectId}::uuid)`,
    sql<{ created_at: Date | string }[]>`
      SELECT created_at
      FROM findings
      WHERE created_at >= ${window.last7Start}
        AND (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)`,
    sql<Record<string, unknown>[]>`
      SELECT p.id, p.name, p.status,
        (SELECT COUNT(*)::int FROM jobs j
          WHERE j.project_id = p.id
            AND j.status IN ('pending','claimed','provisioning','running','waiting_human')) AS active_jobs,
        (SELECT COUNT(*)::int FROM canvases c WHERE c.project_id = p.id) AS task_count,
        (SELECT COUNT(*)::int FROM findings f WHERE f.project_id = p.id) AS finding_count,
        GREATEST(
          p.updated_at,
          COALESCE((SELECT MAX(c.created_at) FROM canvases c WHERE c.project_id = p.id), p.updated_at),
          COALESCE((SELECT MAX(j.created_at) FROM jobs j WHERE j.project_id = p.id), p.updated_at),
          COALESCE((SELECT MAX(j.finished_at) FROM jobs j WHERE j.project_id = p.id), p.updated_at),
          COALESCE((SELECT MAX(f.created_at) FROM findings f WHERE f.project_id = p.id), p.updated_at)
        ) AS last_activity_at
      FROM projects p
      WHERE p.status = 'active'
        AND (${projectId}::uuid IS NULL OR p.id = ${projectId}::uuid)`,
    sql<Record<string, unknown>[]>`
      SELECT c.id, c.title, c.created_at, c.project_id, p.name AS project_name
      FROM canvases c
      JOIN projects p ON p.id = c.project_id
      WHERE (${projectId}::uuid IS NULL OR c.project_id = ${projectId}::uuid)
      ORDER BY c.created_at DESC
      LIMIT ${DASHBOARD_RECENT_ACTIVITY}`,
    sql<Record<string, unknown>[]>`
      SELECT j.id, j.type, j.status, j.created_at, j.started_at, j.finished_at,
             j.project_id, j.canvas_id, p.name AS project_name, c.title AS canvas_title
      FROM jobs j
      JOIN projects p ON p.id = j.project_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      WHERE (${projectId}::uuid IS NULL OR j.project_id = ${projectId}::uuid)
      ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at) DESC, j.id DESC
      LIMIT ${DASHBOARD_RECENT_ACTIVITY}`,
    sql<Record<string, unknown>[]>`
      SELECT f.id, f.title, f.created_at, f.verify_status, f.project_id,
             p.name AS project_name, j.canvas_id
      FROM findings f
      JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id
      WHERE (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${DASHBOARD_RECENT_ACTIVITY}`,
  ]);

  const tasks: DashboardTaskRow[] = taskRows.map((row) => ({
    id: asText(row.id),
    project_id: asText(row.project_id),
    title: asText(row.title),
    status: typeof row.status === "string" ? row.status : null,
    created_at: asIso(row.created_at) ?? window.now.toISOString(),
    started_at: asIso(row.started_at),
    ended_at: asIso(row.ended_at),
    job_count: asCount(row.job_count),
    active_count: asCount(row.active_count),
    root_status: typeof row.root_status === "string" ? row.root_status : null,
    report_status: typeof row.report_status === "string" ? row.report_status : null,
    target_json: row.target_json,
  }));

  const activity: DashboardActivityItem[] = [
    ...recentTasks.map((row) => ({
      id: asText(row.id),
      kind: "task" as const,
      title: asText(row.title) || "未命名任务",
      at: asIso(row.created_at) ?? window.now.toISOString(),
      project_id: asText(row.project_id),
      project_name: asText(row.project_name) || "未知项目",
      canvas_id: asText(row.id),
    })),
    ...recentJobs.map((row) => ({
      id: asText(row.id),
      kind: "job" as const,
      title: asText(row.canvas_title) || asText(row.type) || "运行",
      at: asIso(row.finished_at) ?? asIso(row.started_at) ?? asIso(row.created_at) ?? window.now.toISOString(),
      project_id: asText(row.project_id),
      project_name: asText(row.project_name) || "未知项目",
      canvas_id: typeof row.canvas_id === "string" ? row.canvas_id : null,
      status: asText(row.status),
    })),
    ...recentFindings.map((row) => ({
      id: asText(row.id),
      kind: "finding" as const,
      title: asText(row.title) || "发现",
      at: asIso(row.created_at) ?? window.now.toISOString(),
      project_id: asText(row.project_id),
      project_name: asText(row.project_name) || "未知项目",
      canvas_id: typeof row.canvas_id === "string" ? row.canvas_id : null,
      status: asText(row.verify_status),
    })),
  ];

  return buildDashboardOverview({
    now: window.now,
    projects: projectRows.map((row) => ({ key: asText(row.status), count: asCount(row.count) })),
    jobs: jobRows.map((row) => ({ key: asText(row.status), count: asCount(row.count) })),
    findings: findingRows.map((row) => ({ key: asText(row.verify_status), count: asCount(row.count) })),
    tasks,
    findingCreatedAt: findingCreatedRows.map((row) => asIso(row.created_at)).filter((value): value is string => Boolean(value)),
    activeProjects: activeProjectRows.map((row) => ({
      id: asText(row.id),
      name: asText(row.name),
      status: asText(row.status) === "archived" ? "archived" : "active",
      active_jobs: asCount(row.active_jobs),
      task_count: asCount(row.task_count),
      finding_count: asCount(row.finding_count),
      last_activity_at: asIso(row.last_activity_at),
    })),
    recentActivity: activity,
  });
}
