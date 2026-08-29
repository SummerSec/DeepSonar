import assert from "node:assert/strict";
import test from "node:test";
import {
  USAGE_MAX_DAYS,
  buildDashboardUsage,
  resolveUsageWindow,
  type UsageLedgerRow,
  type UsageQueryError,
  type UsageWindow,
} from "./usage.js";

const NOW = new Date("2026-08-19T10:00:00.000+08:00");

function errorCode(value: UsageWindow | UsageQueryError): string | undefined {
  return "error_code" in value ? value.error_code : undefined;
}

function row(overrides: Partial<UsageLedgerRow> = {}): UsageLedgerRow {
  return {
    observed_at: "2026-08-19T01:00:00.000Z",
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    settlement_status: "settled",
    provider: "anthropic",
    model: "claude",
    job_id: "job-1",
    project_id: "project-1",
    project_name: "登录审计",
    canvas_id: "canvas-1",
    canvas_title: "探测入口",
    ...overrides,
  };
}

test("preset windows use Asia/Shanghai calendar days through now", () => {
  const week = resolveUsageWindow({ period: "week", now: NOW });
  assert.equal("error_code" in week, false);
  if ("error_code" in week) return;
  assert.equal(week.period, "week");
  assert.deepEqual(week.days, [
    "2026-08-13",
    "2026-08-14",
    "2026-08-15",
    "2026-08-16",
    "2026-08-17",
    "2026-08-18",
    "2026-08-19",
  ]);
  assert.equal(week.start.toISOString(), "2026-08-12T16:00:00.000Z");
  assert.equal(week.endExclusive.toISOString(), NOW.toISOString());

  const day = resolveUsageWindow({ period: "day", now: NOW });
  assert.equal("error_code" in day, false);
  if ("error_code" in day) return;
  assert.deepEqual(day.days, ["2026-08-19"]);

  const month = resolveUsageWindow({ period: "month", now: NOW });
  assert.equal("error_code" in month, false);
  if ("error_code" in month) return;
  assert.equal(month.days.length, 30);
  assert.equal(month.days[0], "2026-07-21");
  assert.equal(month.days.at(-1), "2026-08-19");
});

test("custom Shanghai dates are inclusive and clamp the open end to now", () => {
  const window = resolveUsageWindow({ period: "custom", from: "2026-08-17", to: "2026-08-19", now: NOW });
  assert.equal("error_code" in window, false);
  if ("error_code" in window) return;
  assert.deepEqual(window.days, ["2026-08-17", "2026-08-18", "2026-08-19"]);
  assert.equal(window.start.toISOString(), "2026-08-16T16:00:00.000Z");
  assert.equal(window.endExclusive.toISOString(), NOW.toISOString());
});

test("custom ISO instants keep the caller range and still bucket by Shanghai day", () => {
  const window = resolveUsageWindow({
    period: "custom",
    from: "2026-08-17T12:00:00.000+08:00",
    to: "2026-08-18T18:00:00.000+08:00",
    now: NOW,
  });
  assert.equal("error_code" in window, false);
  if ("error_code" in window) return;
  assert.deepEqual(window.days, ["2026-08-17", "2026-08-18"]);
  assert.equal(window.start.toISOString(), "2026-08-17T04:00:00.000Z");
  assert.equal(window.endExclusive.toISOString(), "2026-08-18T10:00:00.000Z");
});

test("custom range validation rejects missing, inverted, future, and oversized windows", () => {
  assert.equal(errorCode(resolveUsageWindow({ period: "custom", now: NOW })), "USAGE_RANGE_REQUIRED");
  assert.equal(errorCode(resolveUsageWindow({ period: "custom", from: "2026-08-19", to: "2026-08-18", now: NOW })), "USAGE_RANGE_ORDER");
  assert.equal(errorCode(resolveUsageWindow({ period: "custom", from: "2026-08-20", to: "2026-08-21", now: NOW })), "USAGE_RANGE_IN_FUTURE");
  assert.equal(errorCode(resolveUsageWindow({ period: "custom", from: "not-a-date", to: "2026-08-19", now: NOW })), "USAGE_RANGE_INVALID");
  const long = resolveUsageWindow({ period: "custom", from: "2025-01-01", to: "2026-08-19", now: NOW });
  assert.equal("error_code" in long, true);
  if (!("error_code" in long)) return;
  assert.equal(long.error_code, "USAGE_RANGE_TOO_LONG");
  assert.match(long.error, new RegExp(String(USAGE_MAX_DAYS)));
});

test("from/to without period implies a custom window", () => {
  const window = resolveUsageWindow({ from: "2026-08-18", to: "2026-08-18", now: NOW });
  assert.equal("error_code" in window, false);
  if ("error_code" in window) return;
  assert.equal(window.period, "custom");
  assert.deepEqual(window.days, ["2026-08-18"]);
});

test("usage board aggregates tokens by day, project, task, and model", () => {
  const window = resolveUsageWindow({ period: "week", now: NOW });
  assert.equal("error_code" in window, false);
  if ("error_code" in window) return;
  const usage = buildDashboardUsage({
    window,
    rows: [
      row(),
      row({
        observed_at: "2026-08-18T02:00:00.000Z",
        input_tokens: 20,
        output_tokens: 6,
        total_tokens: 26,
        job_id: "job-2",
        canvas_id: "canvas-2",
        canvas_title: "复测",
        model: "sonnet",
      }),
      row({
        observed_at: "2026-08-18T03:00:00.000Z",
        project_id: "project-2",
        project_name: "支付",
        job_id: "job-3",
        canvas_id: "canvas-3",
        canvas_title: "支付链路",
        provider: "openai",
        model: "gpt",
        settlement_status: "unknown",
        total_tokens: 14,
      }),
    ],
  });

  assert.equal(usage.totals.requests, 3);
  assert.equal(usage.totals.input_tokens, 40);
  assert.equal(usage.totals.output_tokens, 14);
  assert.equal(usage.totals.total_tokens, 54);
  assert.equal(usage.totals.jobs, 3);
  assert.equal(usage.totals.projects, 2);
  assert.equal(usage.totals.tasks, 3);
  assert.equal(usage.totals.settled, 2);
  assert.equal(usage.totals.unknown, 1);
  assert.equal(usage.series.find((day) => day.date === "2026-08-18")?.total_tokens, 40);
  assert.equal(usage.series.find((day) => day.date === "2026-08-19")?.total_tokens, 14);
  assert.deepEqual(usage.projects.map((item) => item.id), ["project-1", "project-2"]);
  assert.equal(usage.tasks[0]?.title, "复测");
  assert.deepEqual(usage.models.map((item) => item.model), ["sonnet", "claude", "gpt"]);
});
