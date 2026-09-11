import assert from "node:assert/strict";
import test from "node:test";
import { projectTaskTrace, taskTraceDigest } from "./task-trace";

test("trace keeps intent → report order with digest and timestamps", () => {
  const created = "2026-09-10T08:00:00.000Z";
  const rows = projectTaskTrace({
    objective: "确认登录绕过",
    createdAt: created,
    jobs: [
      { id: "hub-1", type: "hub_reason", status: "succeeded", role_name: "hub", created_at: "2026-09-10T08:05:00.000Z" },
      { id: "job-1", type: "review", status: "running", role_name: "review", created_at: "2026-09-10T08:10:00.000Z" },
    ],
    facts: [{ id: "fact-1", verification_status: "verified", created_at: "2026-09-10T08:12:00.000Z" }],
    findings: [{ id: "find-1", verify_status: "confirmed", created_at: "2026-09-10T08:15:00.000Z" }],
    report: { id: "rep-1", version: 3, status: "succeeded", generated_at: "2026-09-10T09:00:00.000Z" },
    lifecycleLabel: "进行中",
    lifecycleReason: "仍有 1 个活动运行",
  });

  assert.deepEqual(rows.map((row) => row.kind), ["intent", "plan", "capability", "run", "evidence", "decision", "report"]);
  assert.equal(rows[0]?.title, "确认登录绕过");
  assert.equal(rows[0]?.digest, null);
  assert.ok(rows[1]?.source_refs.includes("job:hub-1"));
  assert.ok(rows[1]?.digest);
  assert.equal(rows[1]?.digest, taskTraceDigest(["job:hub-1"], "2026-09-10T08:05:00.000Z"));
  assert.match(rows[2]?.title ?? "", /review/);
  assert.equal(rows[6]?.title, "报告 v3");
  assert.equal(rows[6]?.created_at, "2026-09-10T09:00:00.000Z");
  assert.equal(rows[5]?.reason, "仍有 1 个活动运行");
});

test("empty trace still emits the pipeline without inventing a report success", () => {
  const rows = projectTaskTrace({
    objective: "  ",
    createdAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(rows.length, 7);
  assert.equal(rows[6]?.status, "none");
  assert.equal(rows[3]?.status, "pending");
  assert.equal(rows[0]?.title, "任务目标");
});
