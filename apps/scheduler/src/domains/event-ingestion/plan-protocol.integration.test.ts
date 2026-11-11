import assert from "node:assert/strict";
import test from "node:test";
import { contentSha256 } from "../plan-protocol/criterion-model.js";
import { readPlanAudit } from "../plan-protocol/application.js";
import { createPlanExecutionFixture } from "../../plan-execution-test-fixture.js";

test("ingestion retains the exact current route/result, refuses worker ownership and stops without rewriting child history", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const h = await createPlanExecutionFixture();
  try {
    const f = await h.fixture(), p = h.proposal(f);
    const accepted = await h.invoke(f.hub, "submit_plan", p);
    assert.equal(accepted.statusCode, 200, accepted.payload);
    const [owner] = await h.sql`SELECT payload_json FROM jobs WHERE id=${f.hub}`;
    const audit = readPlanAudit(owner.payload_json);
    assert.equal(audit?.v, 2); assert.deepEqual(audit?.raw, p.plan); assert.deepEqual(audit?.trimmed, p.plan);
    assert.deepEqual(audit?.trim_reasons, []);
    const child = (await h.children(f.hub))[0];
    await h.start(String(child.id));
    const worker = await h.invoke(String(child.id), "submit_plan", p);
    assert.ok(worker.statusCode >= 400, worker.payload);
    const result = { v: 2, objective_id: p.plan.objective_id, objective_revision: "1", route_revision: "1",
      plan_sha256: contentSha256(p.plan), outcome: "needs_human", summary: "Current work requires authorized human input", termination_reason: "operator_required" };
    const unknownTask = await h.invoke(f.hub, "submit_plan_result", { ...result, execution: [{ task_id: "nonexistent", status: "done" }] });
    assert.ok(unknownTask.statusCode >= 400, unknownTask.payload);
    const stopped = await h.invoke(f.hub, "submit_plan_result", result);
    assert.equal(stopped.statusCode, 200, stopped.payload);
    const target = await h.state(f.canvas);
    assert.equal(target.plan_execution.stop_reason, "model_needs_human");
    assert.equal(target.plan_objective.status, "stopped");
    await h.emit(String(child.id)); await h.finish(String(child.id));
    assert.equal((await h.children(f.hub)).length, 1, "late success cannot release stopped dependants");
    const [saved] = await h.sql`SELECT payload_json FROM jobs WHERE id=${f.hub}`;
    assert.equal(readPlanAudit(saved.payload_json)?.result?.outcome, "needs_human");
    const [immutable] = await h.sql`SELECT payload_json,agent_snapshot_json FROM jobs WHERE id=${child.id}`;
    assert.deepEqual(immutable.payload_json.plan_context, child.payload_json.plan_context);
    assert.deepEqual(immutable.agent_snapshot_json, child.agent_snapshot_json);
  } finally { await h.close(); }
});

test("plan 语义字段含 U+0000 在产生任何效果前结构化拒绝；修正后同 key 可接受（#1066）", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const h = await createPlanExecutionFixture();
  try {
    const f = await h.fixture(), base = h.proposal(f);
    const key = "3f1c2d9e-6a4b-4c8d-9e2f-1a3b5c7d9e01";
    const beforeEvents = (await h.sql`SELECT count(*)::int AS n FROM events WHERE job_id=${f.hub}`)[0].n;
    const beforeChildren = (await h.children(f.hub)).length;

    const rejected = await h.invoke(f.hub, "submit_plan",
      { ...base, revision: { ...base.revision, rationale: "why\u0000now" } }, key);
    const body = rejected.json() as { accepted?: boolean; error?: string; error_code?: string };
    assert.ok(rejected.statusCode >= 400 && rejected.statusCode < 500, rejected.payload);
    assert.equal(body.accepted, false, rejected.payload);
    assert.equal(body.error_code, "invalid_payload", rejected.payload);
    assert.match(String(body.error ?? ""), /U\+0000/u);
    assert.equal((await h.sql`SELECT count(*)::int AS n FROM events WHERE job_id=${f.hub}`)[0].n, beforeEvents,
      "rejected plan must not leave an event row");
    assert.equal((await h.children(f.hub)).length, beforeChildren, "rejected plan must not create derived tasks");
    const [dedup] = await h.sql`SELECT event_id FROM event_dedup WHERE event_id=${key}::uuid`;
    assert.ok(!dedup, "rejected plan must not consume the idempotency key");

    const accepted = await h.invoke(f.hub, "submit_plan",
      { ...base, revision: { ...base.revision, rationale: "why now" } }, key);
    assert.equal(accepted.statusCode, 200, accepted.payload);
  } finally { await h.close(); }
});
