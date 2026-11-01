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
