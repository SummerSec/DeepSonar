import assert from "node:assert/strict";
import test from "node:test";
import {
  CHROME_JOB_STALL_SEC,
  HUB_JOB_STALL_SEC,
  INFLIGHT_TOOL_BUDGET_MIN_SEC,
  inflightToolBudgetSec,
  inflightToolFromPayload,
  resolveJobStallSec,
  runtimeImageKeyFromSnapshot,
  shouldReapStalledJob,
  toolCallActivityPatch,
  toolCallPhaseFromProgressMessage,
  toolCallProgressMessage,
} from "./stall-policy.js";

const now = new Date("2026-08-20T12:00:00.000Z");
const startedAt = new Date(now.getTime() - 1_000_000);
const liveLease = new Date(now.getTime() + 60_000);
const expiredLease = new Date(now.getTime() - 1_000);

test("chrome image keys get a stall floor; others keep the global 900s window", () => {
  assert.equal(resolveJobStallSec("deepsonar-audit", 900), 900);
  assert.equal(resolveJobStallSec(null, 900), 900);
  assert.equal(resolveJobStallSec("deepsonar-chrome-audit", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-audit"]);
  assert.equal(resolveJobStallSec("deepsonar-chrome-test", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-test"]);
  assert.equal(resolveJobStallSec("deepsonar-chrome-fuzz", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"]);
  assert.equal(resolveJobStallSec("deepsonar-chrome-audit", 0), 0);
  assert.equal(resolveJobStallSec("deepsonar-base", 900), 900);
  assert.equal(resolveJobStallSec("deepsonar-base", 900, "hub_reason"), HUB_JOB_STALL_SEC);
  assert.equal(resolveJobStallSec("deepsonar-base", 900, "audit"), 900);
  assert.equal(resolveJobStallSec("deepsonar-base", 0, "hub_reason"), 0);
  assert.equal(runtimeImageKeyFromSnapshot({ runtime_image: { image_key: "deepsonar-chrome-fuzz" } }), "deepsonar-chrome-fuzz");
});

test("hub_reason floor keeps a silent Hub alive past 900s when stall is on", () => {
  assert.equal(shouldReapStalledJob({
    now,
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-base",
    jobType: "hub_reason",
    leaseExpiresAt: liveLease,
  }), false);
  assert.equal(shouldReapStalledJob({
    now: new Date(startedAt.getTime() + HUB_JOB_STALL_SEC * 1000 + 1),
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-base",
    jobType: "hub_reason",
    leaseExpiresAt: liveLease,
  }), true);
  assert.equal(shouldReapStalledJob({
    now,
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-base",
    jobType: "audit",
    leaseExpiresAt: liveLease,
  }), true);
});

test("in-flight tool.call + live lease is not stalled even after 900s of silence", () => {
  const chromeAudit = {
    now,
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-chrome-audit",
    leaseExpiresAt: liveLease,
    inflightTool: "Bash",
    latestToolCallPhase: "started" as const,
  };
  assert.equal(shouldReapStalledJob(chromeAudit), false);
  assert.equal(shouldReapStalledJob({
    ...chromeAudit,
    imageKey: "deepsonar-chrome-fuzz",
    inflightTool: null,
    lastEventAt: startedAt,
  }), false, "chrome-fuzz still inside 10800s floor without an in-flight tool");
  assert.equal(shouldReapStalledJob({
    now,
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-audit",
    leaseExpiresAt: liveLease,
    inflightTool: "Bash",
    latestToolCallPhase: "started",
  }), false, "non-chrome long tools share the in-flight exemption");
});

test("a silent non-chrome job with only a live lease is still reaped after 900s", () => {
  assert.equal(shouldReapStalledJob({
    now,
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-audit",
    leaseExpiresAt: liveLease,
  }), true);
  assert.equal(shouldReapStalledJob({
    now,
    startedAt,
    lastEventAt: new Date(now.getTime() - 1_000),
    stallSec: 900,
    imageKey: "deepsonar-audit",
    leaseExpiresAt: liveLease,
  }), false);
});

test("chrome floor does not protect a silent job past its override, and expired lease drops the in-flight exemption", () => {
  assert.equal(shouldReapStalledJob({
    now,
    startedAt: new Date(now.getTime() - 6_000_000),
    stallSec: 900,
    imageKey: "deepsonar-chrome-audit",
    leaseExpiresAt: liveLease,
  }), true);
  assert.equal(shouldReapStalledJob({
    now,
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-audit",
    leaseExpiresAt: expiredLease,
    inflightTool: "Bash",
    latestToolCallPhase: "started",
  }), true);
  assert.equal(shouldReapStalledJob({
    now,
    startedAt,
    stallSec: 900,
    imageKey: "deepsonar-audit",
    leaseExpiresAt: liveLease,
    latestToolCallPhase: "completed",
  }), true);
});

test("tool.call activity patch and progress message stay paired", () => {
  const started = toolCallActivityPatch("started", "Bash", now);
  assert.deepEqual(started.runtime_activity, { inflight_tool: "Bash", phase: "started", at: now.toISOString() });
  assert.equal(inflightToolFromPayload({ runtime_activity: started.runtime_activity }), "Bash");
  assert.equal(inflightToolFromPayload(toolCallActivityPatch("completed", "Bash", now)), null);
  assert.equal(toolCallProgressMessage("started", "Bash"), "tool.call.started Bash");
  assert.equal(toolCallPhaseFromProgressMessage("tool.call.started Bash clang-tidy"), "started");
  assert.equal(toolCallPhaseFromProgressMessage("tool.call.completed Bash"), "completed");
  assert.equal(toolCallPhaseFromProgressMessage("scanning files"), null);
});

test("#1086: in-flight tool budgets derive from the same per-image floor", () => {
  assert.equal(inflightToolBudgetSec("deepsonar-audit", 900), INFLIGHT_TOOL_BUDGET_MIN_SEC);
  assert.equal(inflightToolBudgetSec(null, 900), INFLIGHT_TOOL_BUDGET_MIN_SEC);
  assert.equal(inflightToolBudgetSec("deepsonar-chrome-audit", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-audit"] * 2);
  assert.equal(inflightToolBudgetSec("deepsonar-chrome-fuzz", 900), CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"] * 2);
  assert.equal(inflightToolBudgetSec("deepsonar-base", 900, "hub_reason"), HUB_JOB_STALL_SEC * 2);
  assert.equal(inflightToolBudgetSec("deepsonar-audit", 7_200), 14_400, "a larger frozen stall_sec raises the budget too");
  assert.equal(inflightToolBudgetSec("deepsonar-audit", 0), 0, "stall off stays off");
});

test("#1086: an in-flight tool is exempt only up to its budget", () => {
  const inflight = { inflightTool: "bash" };
  const withinBudget = new Date(startedAt.getTime() + INFLIGHT_TOOL_BUDGET_MIN_SEC * 1000 - 1);
  const overBudget = new Date(startedAt.getTime() + INFLIGHT_TOOL_BUDGET_MIN_SEC * 1000 + 1);
  const leaseAt = (at: Date) => new Date(at.getTime() + 60_000);
  assert.equal(shouldReapStalledJob({ now: withinBudget, startedAt, stallSec: 900, imageKey: "deepsonar-audit", leaseExpiresAt: leaseAt(withinBudget), ...inflight }), false);
  assert.equal(shouldReapStalledJob({ now: overBudget, startedAt, stallSec: 900, imageKey: "deepsonar-audit", leaseExpiresAt: leaseAt(overBudget), ...inflight }), true);
  // 进度事件把 last activity 推后，预算按最近活动重新计时。
  const recentEvent = new Date(withinBudget.getTime() + 60_000);
  assert.equal(shouldReapStalledJob({ now: withinBudget, startedAt, lastEventAt: recentEvent, stallSec: 900, imageKey: "deepsonar-audit", leaseExpiresAt: leaseAt(withinBudget), ...inflight }), false);
  // chrome-fuzz 的 3h 合法长工具仍在预算内。
  const fuzzNow = new Date(startedAt.getTime() + CHROME_JOB_STALL_SEC["deepsonar-chrome-fuzz"] * 1000 + 60_000);
  assert.equal(shouldReapStalledJob({
    now: fuzzNow,
    startedAt, stallSec: 900, imageKey: "deepsonar-chrome-fuzz", leaseExpiresAt: leaseAt(fuzzNow),
    latestToolCallPhase: "started",
  }), false);
  // 租约失效时不再走豁免分支，普通停滞判定照旧。
  assert.equal(shouldReapStalledJob({ now: withinBudget, startedAt, stallSec: 900, imageKey: "deepsonar-audit", leaseExpiresAt: expiredLease, ...inflight }), true);
});
