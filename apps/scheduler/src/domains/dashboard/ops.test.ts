import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardOps } from "./ops.js";

const NOW = new Date("2026-08-19T10:00:00.000+08:00");

function ops(overrides: Partial<Parameters<typeof buildDashboardOps>[0]> = {}) {
  return buildDashboardOps({
    now: NOW,
    projects: 2,
    tasks: 3,
    jobs: [
      { key: "running", count: 1 },
      { key: "waiting_human", count: 1 },
      { key: "succeeded", count: 2 },
    ],
    findingsSeverity: [{ key: "critical", count: 1 }, { key: "high", count: 1 }],
    findingsDisposition: [{ key: "open", count: 2 }],
    findingsVerify: [{ key: "pending", count: 2 }],
    coverage: { projects_with_findings: 1, tasks_with_findings: 1 },
    highRisk: [{
      id: "f-open",
      title: "开放高风险",
      severity: "critical",
      verify_status: "pending",
      disposition: "open",
      project_id: "p1",
      project_name: "登录",
      canvas_id: "c1",
      created_at: "2026-08-19T01:00:00.000Z",
    }],
    highRiskTotal: 1,
    finishedJobs: [
      {
        type: "audit",
        status: "succeeded",
        started_at: "2026-08-18T01:00:00.000Z",
        finished_at: "2026-08-18T01:10:00.000Z",
      },
      {
        type: "audit",
        status: "failed",
        started_at: "2026-08-18T02:00:00.000Z",
        finished_at: "2026-08-18T02:05:00.000Z",
        error: "provision exploded",
      },
      {
        type: "review",
        status: "cancelled",
        started_at: "2026-08-18T03:00:00.000Z",
        finished_at: "2026-08-18T03:01:00.000Z",
      },
      {
        type: "test",
        status: "timeout",
        started_at: null,
        finished_at: "2026-08-18T04:00:00.000Z",
      },
    ],
    waitingHuman: 1,
    globalCap: 4,
    ...overrides,
  });
}

test("ops snapshot labels query planes and keeps empty buckets as real zeros", () => {
  const body = ops({
    jobs: [],
    findingsSeverity: [],
    findingsDisposition: [],
    findingsVerify: [],
    finishedJobs: [],
    highRisk: [],
    highRiskTotal: 0,
    projects: 0,
    tasks: 0,
    waitingHuman: 0,
  });
  assert.deepEqual(body.query_planes, { snapshot: "current", throughput: "history" });
  assert.equal(body.calendar_timezone, "Asia/Shanghai");
  assert.equal(body.totals.jobs, 0);
  assert.equal(body.totals.findings, 0);
  assert.equal(body.findings.severity.find((item) => item.key === "critical")?.count, 0);
  assert.equal(body.jobs.throughput.success_rate, null);
  assert.equal(body.jobs.duration.avg_ms, null);
});

test("throughput treats cancelled as finished and waiting_human as neither success nor failure", () => {
  const body = ops();
  assert.equal(body.jobs.throughput.finished, 4);
  assert.equal(body.jobs.throughput.succeeded, 1);
  assert.equal(body.jobs.throughput.failed, 2);
  assert.equal(body.jobs.throughput.cancelled, 1);
  assert.equal(body.jobs.throughput.success_rate, 0.25);
  assert.equal(body.jobs.concurrency.waiting_human, 1);
  assert.equal(body.jobs.concurrency.active, 2);
  assert.equal(body.jobs.concurrency.utilization, 0.5);
});

test("duration ignores Jobs that never started, and confirmed_vuln is not open high-risk", () => {
  const body = ops({
    highRisk: [
      {
        id: "f-closed",
        title: "已确认漏洞",
        severity: "critical",
        verify_status: "confirmed",
        disposition: "confirmed_vuln",
        project_id: "p1",
        project_name: "登录",
        canvas_id: "c1",
        created_at: "2026-08-19T01:00:00.000Z",
      },
    ],
    highRiskTotal: 0,
  });
  assert.equal(body.jobs.duration.count, 3);
  assert.equal(body.jobs.duration.avg_ms, Math.round((600_000 + 300_000 + 60_000) / 3));
  assert.deepEqual(body.findings.open_high_risk.items, []);
  assert.ok(body.jobs.failure_reasons.some((item) => item.key === "timeout"));
  assert.ok(body.jobs.failure_reasons.some((item) => item.key === "cancelled"));
});
