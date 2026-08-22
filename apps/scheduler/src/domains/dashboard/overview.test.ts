import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardOverview,
  classifyDashboardTask,
  dashboardWindow,
  dayKey,
  fillDistribution,
  shanghaiStartUtc,
  shanghaiYmd,
  shiftYmd,
  type DashboardTaskRow,
} from "./overview.js";

const NOW = new Date("2026-08-19T10:00:00.000+08:00");

function task(overrides: Partial<DashboardTaskRow> = {}): DashboardTaskRow {
  return {
    id: "canvas-1",
    project_id: "project-1",
    title: "审计登录",
    status: "active",
    created_at: "2026-08-19T02:00:00.000Z",
    started_at: "2026-08-19T02:10:00.000Z",
    ended_at: null,
    job_count: 1,
    active_count: 1,
    root_status: "running",
    report_status: null,
    ...overrides,
  };
}

test("Shanghai calendar windows cover today and the previous six days", () => {
  const window = dashboardWindow(NOW);
  assert.equal(shanghaiYmd(NOW), "2026-08-19");
  assert.deepEqual(window.days, [
    "2026-08-13",
    "2026-08-14",
    "2026-08-15",
    "2026-08-16",
    "2026-08-17",
    "2026-08-18",
    "2026-08-19",
  ]);
  assert.equal(window.todayStart.toISOString(), shanghaiStartUtc("2026-08-19").toISOString());
  assert.equal(window.last7Start.toISOString(), shanghaiStartUtc("2026-08-13").toISOString());
  assert.equal(shiftYmd("2026-08-19", -1), "2026-08-18");
  assert.equal(dayKey("2026-08-18T16:30:00.000Z"), "2026-08-19");
  assert.equal(dayKey("2026-08-18T15:59:59.000Z"), "2026-08-18");
});

test("task classification follows active_count and does not treat last job success as complete", () => {
  assert.equal(classifyDashboardTask(task(), NOW), "running");
  assert.equal(classifyDashboardTask(task({
    active_count: 0,
    ended_at: "2026-08-19T03:00:00.000Z",
    root_status: "succeeded",
  }), NOW), "completed");
  assert.equal(classifyDashboardTask(task({
    active_count: 1,
    ended_at: "2026-08-19T03:00:00.000Z",
    root_status: "succeeded",
  }), NOW), "running");
  assert.equal(classifyDashboardTask(task({
    active_count: 0,
    job_count: 0,
    started_at: null,
    ended_at: null,
    root_status: "succeeded",
  }), NOW), "idle");
  assert.equal(classifyDashboardTask(task({
    active_count: 0,
    ended_at: "2026-08-19T03:00:00.000Z",
    root_status: "failed",
  }), NOW), "failed");
  assert.equal(classifyDashboardTask(task({
    status: "archived",
    active_count: 1,
  }), NOW), "archived");
  assert.equal(classifyDashboardTask(task({
    active_count: 0,
    job_count: 1,
    started_at: null,
    ended_at: "2026-08-22T08:00:00.000Z",
    root_status: "active",
  }), NOW), "failed");
  assert.equal(classifyDashboardTask(task({
    active_count: 0,
    job_count: 1,
    started_at: "2026-08-19T02:10:00.000Z",
    ended_at: "2026-08-19T03:00:00.000Z",
    root_status: "active",
  }), NOW), "idle");
  assert.equal(classifyDashboardTask(task({
    active_count: 0,
    target_json: { execution_control: { paused: true } },
  }), NOW), "paused");
});

test("overview aggregates totals, 7-day trend, top projects, and recent activity", () => {
  const overview = buildDashboardOverview({
    now: NOW,
    projects: [{ key: "active", count: 2 }, { key: "archived", count: 1 }],
    jobs: [{ key: "running", count: 2 }, { key: "succeeded", count: 5 }],
    findings: [{ key: "pending", count: 3 }, { key: "confirmed", count: 1 }],
    tasks: [
      task({ id: "new-today", created_at: "2026-08-19T01:00:00.000Z", active_count: 1 }),
      task({
        id: "done-today",
        created_at: "2026-08-18T02:00:00.000Z",
        ended_at: "2026-08-19T01:30:00.000Z",
        active_count: 0,
        root_status: "succeeded",
      }),
      task({
        id: "old-idle",
        created_at: "2026-08-01T02:00:00.000Z",
        started_at: null,
        ended_at: null,
        job_count: 0,
        active_count: 0,
        root_status: null,
      }),
    ],
    findingCreatedAt: [
      "2026-08-19T01:10:00.000Z",
      "2026-08-13T02:00:00.000Z",
      "2026-08-01T02:00:00.000Z",
    ],
    activeProjects: [
      { id: "p-quiet", name: "静默", status: "active", active_jobs: 0, task_count: 4, finding_count: 9, last_activity_at: "2026-08-18T00:00:00.000Z" },
      { id: "p-hot", name: "热点", status: "active", active_jobs: 3, task_count: 2, finding_count: 1, last_activity_at: "2026-08-19T00:00:00.000Z" },
    ],
    recentActivity: [
      { id: "a1", kind: "finding", title: "旧发现", at: "2026-08-18T00:00:00.000Z", project_id: "p-quiet", project_name: "静默", canvas_id: "c1" },
      { id: "a2", kind: "job", title: "新运行", at: "2026-08-19T03:00:00.000Z", project_id: "p-hot", project_name: "热点", canvas_id: "c2", status: "running" },
    ],
  });

  assert.deepEqual(overview.totals, { projects: 3, tasks: 3, jobs: 7, findings: 4 });
  assert.equal(overview.distributions.tasks.find((item) => item.key === "running")?.count, 1);
  assert.equal(overview.distributions.tasks.find((item) => item.key === "completed")?.count, 1);
  assert.equal(overview.distributions.tasks.find((item) => item.key === "idle")?.count, 1);
  assert.deepEqual(overview.periods.today, { new_tasks: 1, completed_tasks: 1, new_findings: 1 });
  assert.deepEqual(overview.periods.last_7d, { new_tasks: 2, completed_tasks: 1, new_findings: 2 });
  assert.deepEqual(overview.trend_7d.find((day) => day.date === "2026-08-19"), {
    date: "2026-08-19",
    new_tasks: 1,
    completed_tasks: 1,
    new_findings: 1,
  });
  assert.deepEqual(overview.trend_7d.find((day) => day.date === "2026-08-13"), {
    date: "2026-08-13",
    new_tasks: 0,
    completed_tasks: 0,
    new_findings: 1,
  });
  assert.deepEqual(overview.active_projects.map((project) => project.id), ["p-hot", "p-quiet"]);
  assert.deepEqual(overview.recent_activity.map((item) => item.id), ["a2", "a1"]);
  assert.equal(fillDistribution(["a", "b"], [{ key: "b", count: 2 }, { key: "c", count: 9 }]).find((item) => item.key === "a")?.count, 0);
});
