import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Plan, mergePlanAudit } from "@deepsonar/shared-types";
import { createPlanExecutionFixture } from "./plan-execution-test-fixture.js";
import { readPlanAudit } from "./domains/plan-protocol/application.js";
import { taskInputSha256 } from "./domains/plan-protocol/task-input.js";

test("historical v1 is immutable/readable, refuses new execution and permits durable safe human stops", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const h = await createPlanExecutionFixture();
  try {
    const f = await h.fixture();
    const plan = Plan.parse({ v: 1, goal: "Retain historical scoped execution evidence", tasks: [h.task("historical", f.root)],
      completion: { mode: "explicit_result", description: "Historical operator completion criterion", required_outputs: [] } });
    const audit = mergePlanAudit(null, { source: "submit_plan", raw: plan, trimmed: plan });
    // Archive fixtures are seeded as immutable records, never ingested as new v1 input.
    await h.sql`UPDATE canvases SET target_json=target_json-'plan_objective' WHERE id=${f.canvas}`;
    const [canvas] = await h.sql`SELECT title,target_json FROM canvases WHERE id=${f.canvas}`;
    await h.sql`UPDATE jobs SET payload_json=payload_json || ${h.sql.json({ plan_protocol: audit, plan_input_sha256: taskInputSha256(canvas.title, canvas.target_json) })} WHERE id=${f.hub}`;
    await h.sql`INSERT INTO events(job_id,event_id,job_seq,type,payload_json)
      VALUES(${f.hub},${randomUUID()},1,'plan',${h.sql.json({ plan })})`;
    const [snapshot] = await h.sql`SELECT payload_json,agent_snapshot_json FROM jobs WHERE id=${f.hub}`;
    assert.deepEqual(readPlanAudit(snapshot.payload_json)?.raw, plan);
    for (const operation of ["submit_plan", "submit_plan_result"]) {
      const response = await h.invoke(f.hub, operation, operation === "submit_plan" ? { plan } : { v: 1, outcome: "continue", summary: "A historical result cannot start new work" });
      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error_code, "invalid_payload");
    }
    const read = await h.invoke(f.hub, "graph_query", { kind: "plan_gap" });
    assert.equal(read.statusCode, 200, read.payload);
    const gap = read.json().items[0];
    assert.equal(gap.historical, true); assert.equal(gap.supplementation_remaining, 0);
    const basis = { v: 1, plan_job_id: f.hub, plan_sha256: gap.plan_sha256, criterion_id: "completion",
      expected_revision: gap.revision, expected_task_input_sha256: gap.task_input_sha256, expected_projection_sha256: gap.projection_sha256,
      source_refs: [], outcome: "continue", rationale: "Historical data cannot authorize new execution", expected_gain: "Collect new evidence" };
    const denied = await h.invoke(f.hub, "submit_hub_decision", { intents: [{ from: [f.root], role: "explore", description: "Collect another historical output", prompt: h.task("historical", f.root).prompt }], plan_basis: basis });
    assert.ok(denied.statusCode >= 400, denied.payload);
    assert.equal((await h.children(f.hub)).length, 0);
    const key = randomUUID(), stop = { reason: "Historical route needs an authorized current objective", subject: { type: "platform_blocker", kind: "business_decision" },
      plan_basis: { ...basis, outcome: "needs_human", expected_gain: undefined } };
    h.holdPlanCommit.add(f.hub);
    const accepted = await h.invoke(f.hub, "request_human", stop, key);
    assert.equal(accepted.statusCode, 200, accepted.payload);
    assert.equal(accepted.json().receipt_status, "persisted_deferred");
    assert.equal((await h.sql`SELECT id FROM events WHERE event_id=${key} AND type='human'`).length, 0);
    h.api.clearPlatformApiIdempotencyCache(); h.api.unregisterRuntimeHandler(f.hub);
    const recovered = await h.invoke(f.hub, "request_human", stop, key);
    assert.deepEqual(recovered.json(), accepted.json());
    assert.equal((await h.children(f.hub)).length, 0);
    const [after] = await h.sql`SELECT payload_json,agent_snapshot_json FROM jobs WHERE id=${f.hub}`;
    assert.deepEqual(readPlanAudit(after.payload_json), readPlanAudit(snapshot.payload_json));
    assert.deepEqual(after.agent_snapshot_json, snapshot.agent_snapshot_json);
  } finally { await h.close(); }
});
