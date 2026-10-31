import { FINDING_DISPOSITIONS } from "../../finding-disposition.js";
import {
  HIGH_RISK_SEVERITIES,
  isOpenHighRiskFinding,
} from "../../finding-state-matrix.js";
import { globalRules } from "../../core.js";
import { sql } from "../../db.js";
import { FINDING_SEVERITY_KEYS, FINDING_VERIFY_KEYS, fillCountBuckets } from "../finding-verification/project-findings-summary.js";
import {
  ACTIVE_JOB_STATUSES,
  DASHBOARD_CALENDAR_TIMEZONE,
  JOB_STATUS_KEYS,
  dashboardWindow,
  fillDistribution,
  type DashboardStatusBucket,
} from "./overview.js";

export const OPS_HIGH_RISK_LIMIT = 20;
export const OPS_ROLE_LIMIT = 16;
export const OPS_FAILURE_REASON_LIMIT = 12;

export const SUCCESS_JOB_STATUSES = ["succeeded"] as const;
export const OPERATIONAL_FAILURE_JOB_STATUSES = ["failed", "timeout", "orphan"] as const;
export const CANCELLED_JOB_STATUSES = ["cancelled"] as const;
export const THROUGHPUT_JOB_STATUSES = [
  ...SUCCESS_JOB_STATUSES,
  ...OPERATIONAL_FAILURE_JOB_STATUSES,
  ...CANCELLED_JOB_STATUSES,
] as const;

export interface DashboardOpsHighRiskItem {
  id: string;
  title: string;
  severity: string;
  verify_status: string;
  disposition: string;
  project_id: string;
  project_name: string;
  canvas_id: string | null;
  created_at: string;
}

export interface DashboardOpsRoleRow {
  key: string;
  finished: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  avg_duration_ms: number | null;
}

export interface DashboardOpsDuration {
  count: number;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
}

export interface DashboardOps {
  generated_at: string;
  calendar_timezone: string;
  query_planes: { snapshot: "current"; throughput: "history" };
  totals: { projects: number; tasks: number; jobs: number; findings: number };
  findings: {
    severity: DashboardStatusBucket[];
    disposition: DashboardStatusBucket[];
    verify_status: DashboardStatusBucket[];
    open_high_risk: {
      total: number;
      truncated: boolean;
      limit: number;
      items: DashboardOpsHighRiskItem[];
    };
    coverage: {
      projects_with_findings: number;
      projects: number;
      tasks_with_findings: number;
      tasks: number;
    };
  };
  jobs: {
    statuses: DashboardStatusBucket[];
    throughput: {
      window: "last_7d";
      timezone: string;
      finished: number;
      succeeded: number;
      failed: number;
      cancelled: number;
      success_rate: number | null;
    };
    duration: DashboardOpsDuration;
    by_role: DashboardOpsRoleRow[];
    concurrency: {
      active: number;
      waiting_human: number;
      global_cap: number;
      utilization: number | null;
    };
    failure_reasons: DashboardStatusBucket[];
  };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function asIso(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? Number((part / whole).toFixed(4)) : null;
}

function durationMs(startedAt: unknown, finishedAt: unknown): number | null {
  const start = startedAt instanceof Date ? startedAt.getTime() : Date.parse(String(startedAt ?? ""));
  const end = finishedAt instanceof Date ? finishedAt.getTime() : Date.parse(String(finishedAt ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.trunc(end - start);
}

function failureReasonKey(status: string, error: unknown): string {
  if (status === "timeout" || status === "orphan" || status === "cancelled") return status;
  const text = asText(error).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return text ? text.slice(0, 48) : "failed";
}

export function buildDashboardOps(input: {
  now?: Date;
  projects: number;
  tasks: number;
  jobs: Iterable<{ key: string; count: number }>;
  findingsSeverity: Iterable<{ key: string; count: number }>;
  findingsDisposition: Iterable<{ key: string; count: number }>;
  findingsVerify: Iterable<{ key: string; count: number }>;
  coverage: { projects_with_findings: number; tasks_with_findings: number };
  highRisk: readonly DashboardOpsHighRiskItem[];
  highRiskTotal: number;
  finishedJobs: readonly {
    type: string;
    status: string;
    started_at: string | null;
    finished_at: string | null;
    error?: string | null;
  }[];
  waitingHuman: number;
  globalCap: number;
}): DashboardOps {
  const window = dashboardWindow(input.now ?? new Date());
  const jobDist = fillDistribution(JOB_STATUS_KEYS, input.jobs);
  const active = jobDist
    .filter((item) => (ACTIVE_JOB_STATUSES as readonly string[]).includes(item.key))
    .reduce((sum, item) => sum + item.count, 0);
  const finished = input.finishedJobs.filter((job) =>
    (THROUGHPUT_JOB_STATUSES as readonly string[]).includes(job.status));
  const succeeded = finished.filter((job) => job.status === "succeeded").length;
  const failed = finished.filter((job) =>
    (OPERATIONAL_FAILURE_JOB_STATUSES as readonly string[]).includes(job.status)).length;
  const cancelled = finished.filter((job) => job.status === "cancelled").length;
  const durations = finished
    .map((job) => durationMs(job.started_at, job.finished_at))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const roles = new Map<string, { finished: number; succeeded: number; failed: number; cancelled: number; durations: number[] }>();
  for (const job of finished) {
    const key = job.type || "unknown";
    const row = roles.get(key) ?? { finished: 0, succeeded: 0, failed: 0, cancelled: 0, durations: [] };
    row.finished += 1;
    if (job.status === "succeeded") row.succeeded += 1;
    else if ((OPERATIONAL_FAILURE_JOB_STATUSES as readonly string[]).includes(job.status)) row.failed += 1;
    else if (job.status === "cancelled") row.cancelled += 1;
    const ms = durationMs(job.started_at, job.finished_at);
    if (ms !== null) row.durations.push(ms);
    roles.set(key, row);
  }
  const failureReasons = new Map<string, number>();
  for (const job of finished) {
    if (job.status === "succeeded") continue;
    const key = failureReasonKey(job.status, job.error);
    failureReasons.set(key, (failureReasons.get(key) ?? 0) + 1);
  }
  const highRisk = input.highRisk.filter((item) => isOpenHighRiskFinding(item));

  return {
    generated_at: window.now.toISOString(),
    calendar_timezone: DASHBOARD_CALENDAR_TIMEZONE,
    query_planes: { snapshot: "current", throughput: "history" },
    totals: {
      projects: input.projects,
      tasks: input.tasks,
      jobs: jobDist.reduce((sum, item) => sum + item.count, 0),
      findings: [...input.findingsVerify].reduce((sum, item) => sum + Math.max(0, Math.floor(item.count || 0)), 0),
    },
    findings: {
      severity: fillCountBuckets(FINDING_SEVERITY_KEYS, input.findingsSeverity),
      disposition: fillCountBuckets(FINDING_DISPOSITIONS, input.findingsDisposition),
      verify_status: fillCountBuckets(FINDING_VERIFY_KEYS, input.findingsVerify),
      open_high_risk: {
        total: input.highRiskTotal,
        truncated: input.highRiskTotal > OPS_HIGH_RISK_LIMIT,
        limit: OPS_HIGH_RISK_LIMIT,
        items: highRisk.slice(0, OPS_HIGH_RISK_LIMIT),
      },
      coverage: {
        projects_with_findings: input.coverage.projects_with_findings,
        projects: input.projects,
        tasks_with_findings: input.coverage.tasks_with_findings,
        tasks: input.tasks,
      },
    },
    jobs: {
      statuses: jobDist,
      throughput: {
        window: "last_7d",
        timezone: DASHBOARD_CALENDAR_TIMEZONE,
        finished: finished.length,
        succeeded,
        failed,
        cancelled,
        success_rate: rate(succeeded, finished.length),
      },
      duration: {
        count: durations.length,
        avg_ms: durations.length
          ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
          : null,
        p50_ms: percentile(durations, 50),
        p95_ms: percentile(durations, 95),
      },
      by_role: [...roles.entries()]
        .map(([key, row]) => ({
          key,
          finished: row.finished,
          succeeded: row.succeeded,
          failed: row.failed,
          cancelled: row.cancelled,
          avg_duration_ms: row.durations.length
            ? Math.round(row.durations.reduce((sum, value) => sum + value, 0) / row.durations.length)
            : null,
        }))
        .sort((left, right) => right.finished - left.finished || left.key.localeCompare(right.key))
        .slice(0, OPS_ROLE_LIMIT),
      concurrency: {
        active,
        waiting_human: input.waitingHuman,
        global_cap: input.globalCap,
        utilization: rate(active, input.globalCap),
      },
      failure_reasons: [...failureReasons.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
        .slice(0, OPS_FAILURE_REASON_LIMIT),
    },
  };
}

export async function loadDashboardOps(
  projectId: string | null = null,
  now: Date = new Date(),
): Promise<DashboardOps> {
  const window = dashboardWindow(now);
  const [
    projectCount,
    taskCount,
    jobRows,
    severityRows,
    dispositionRows,
    verifyRows,
    coverageProjects,
    coverageTasks,
    highRiskRows,
    highRiskTotal,
    finishedRows,
    waitingHuman,
    rules,
  ] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM projects
      WHERE (${projectId}::uuid IS NULL OR id = ${projectId}::uuid)`,
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM canvases
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)`,
    sql<{ status: string; count: number }[]>`
      SELECT status, COUNT(*)::int AS count FROM jobs
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
      GROUP BY status`,
    sql<{ key: string; count: number }[]>`
      SELECT COALESCE(NULLIF(severity, ''), 'unset') AS key, COUNT(*)::int AS count
      FROM findings
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
      GROUP BY 1`,
    sql<{ key: string; count: number }[]>`
      SELECT COALESCE(NULLIF(disposition, ''), 'open') AS key, COUNT(*)::int AS count
      FROM findings
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
      GROUP BY 1`,
    sql<{ key: string; count: number }[]>`
      SELECT COALESCE(NULLIF(verify_status, ''), 'pending') AS key, COUNT(*)::int AS count
      FROM findings
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)
      GROUP BY 1`,
    sql<{ count: number }[]>`
      SELECT COUNT(DISTINCT project_id)::int AS count FROM findings
      WHERE (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)`,
    sql<{ count: number }[]>`
      SELECT COUNT(DISTINCT j.canvas_id)::int AS count
      FROM findings f JOIN jobs j ON j.id = f.job_id
      WHERE j.canvas_id IS NOT NULL
        AND (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)`,
    sql<Record<string, unknown>[]>`
      SELECT f.id, f.title, f.severity, f.verify_status, f.disposition, f.created_at,
             f.project_id, p.name AS project_name, j.canvas_id
      FROM findings f
      JOIN projects p ON p.id = f.project_id
      JOIN jobs j ON j.id = f.job_id
      WHERE f.severity = ANY(${HIGH_RISK_SEVERITIES as unknown as string[]})
        AND COALESCE(f.disposition, 'open') IN ('open', 'accepted', 'human_reproducing')
        AND (${projectId}::uuid IS NULL OR f.project_id = ${projectId}::uuid)
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${OPS_HIGH_RISK_LIMIT}`,
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM findings
      WHERE severity = ANY(${HIGH_RISK_SEVERITIES as unknown as string[]})
        AND COALESCE(disposition, 'open') IN ('open', 'accepted', 'human_reproducing')
        AND (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)`,
    sql<Record<string, unknown>[]>`
      SELECT type, status, started_at, finished_at, error
      FROM jobs
      WHERE status = ANY(${THROUGHPUT_JOB_STATUSES as unknown as string[]})
        AND finished_at IS NOT NULL
        AND finished_at >= ${window.last7Start}
        AND finished_at <= ${window.now}
        AND (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)`,
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM jobs
      WHERE status = 'waiting_human'
        AND (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid)`,
    globalRules(sql),
  ]);

  return buildDashboardOps({
    now: window.now,
    projects: asCount(projectCount[0]?.count),
    tasks: asCount(taskCount[0]?.count),
    jobs: jobRows.map((row) => ({ key: asText(row.status), count: asCount(row.count) })),
    findingsSeverity: severityRows.map((row) => ({ key: asText(row.key), count: asCount(row.count) })),
    findingsDisposition: dispositionRows.map((row) => ({ key: asText(row.key), count: asCount(row.count) })),
    findingsVerify: verifyRows.map((row) => ({ key: asText(row.key), count: asCount(row.count) })),
    coverage: {
      projects_with_findings: asCount(coverageProjects[0]?.count),
      tasks_with_findings: asCount(coverageTasks[0]?.count),
    },
    highRisk: highRiskRows.map((row) => ({
      id: asText(row.id),
      title: asText(row.title) || "发现",
      severity: asText(row.severity),
      verify_status: asText(row.verify_status),
      disposition: asText(row.disposition) || "open",
      project_id: asText(row.project_id),
      project_name: asText(row.project_name) || "未知项目",
      canvas_id: typeof row.canvas_id === "string" ? row.canvas_id : null,
      created_at: asIso(row.created_at) ?? window.now.toISOString(),
    })),
    highRiskTotal: asCount(highRiskTotal[0]?.count),
    finishedJobs: finishedRows.map((row) => ({
      type: asText(row.type),
      status: asText(row.status),
      started_at: asIso(row.started_at),
      finished_at: asIso(row.finished_at),
      error: typeof row.error === "string" ? row.error : null,
    })),
    waitingHuman: asCount(waitingHuman[0]?.count),
    globalCap: rules.maxGlobalJobs,
  });
}
