import assert from "node:assert/strict";
import test from "node:test";
import {
  CHROME_JOB_STALL_SEC,
  CLICKHOUSE_JOB_STALL_SEC,
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
  assert.equal(resolveJobStallSec("deepsonar-clickhouse-audit", 900), CLICKHOUSE_JOB_STALL_SEC["deepsonar-clickhouse-audit"]);
  assert.equal(resolveJobStallSec("deepsonar-clickhouse-test", 900), CLICKHOUSE_JOB_STALL_SEC["deepsonar-clickhouse-test"]);
  assert.equal(resolveJobStallSec("deepsonar-clickhouse-fuzz", 900), CLICKHOUSE_JOB_STALL_SEC["deepsonar-clickhouse-fuzz"]);
  assert.equal(resolveJobStallSec("deepsonar-chrome-audit", 0), 0);
  assert.equal(runtimeImageKeyFromSnapshot({ runtime_image: { image_key: "deepsonar-chrome-fuzz" } }), "deepsonar-chrome-fuzz");
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
