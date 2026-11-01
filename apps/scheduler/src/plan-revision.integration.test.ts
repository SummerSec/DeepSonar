import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPlanExecutionFixture } from "./plan-execution-test-fixture.js";

test("current Plan route CAS preserves dispatched tasks, history, scope and immutable user controls", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const h = await createPlanExecutionFixture();
  try {
    const f = await h.fixture(), p1 = h.proposal(f);
    assert.equal((await h.invoke(f.hub, "submit_plan", p1)).statusCode, 200);
    const before = await h.children(f.hub);
    const route = (method: string) => h.proposal(f, [p1.plan.tasks[0], { ...p1.plan.tasks[1], description: `Verify using the ${method} method` }], p1.plan);
    const proposals = [route("first"), route("second")], keys = [randomUUID(), randomUUID()];
    const raced = await Promise.all(proposals.map((p, index) => h.invoke(f.hub, "submit_plan", p, keys[index])));
    assert.equal(raced.filter((r) => r.statusCode === 200).length, 1, raced.map((r) => r.payload).join("\n"));
    assert.equal(raced.find((r) => r.statusCode !== 200)!.json().error_code, "plan_stale_revision");
    const winner = raced.findIndex((r) => r.statusCode === 200), accepted = proposals[winner];
    assert.equal((await h.invoke(f.hub, "submit_plan", accepted, keys[winner])).statusCode, 200);
    assert.deepEqual(await h.children(f.hub), before, "route revision does not rewrite dispatched Jobs/snapshots or create blocked work");
    h.api.clearPlatformApiIdempotencyCache(); h.api.unregisterRuntimeHandler(f.hub);
    const recovered = await h.invoke(f.hub, "submit_plan", accepted, keys[winner]);
    assert.equal(recovered.statusCode, 200, recovered.payload);
    assert.deepEqual(await h.children(f.hub), before, "committed receipt recovery never dispatches again");
    // Restore the same active fixture handler without creating another Attempt.
    h.rebind(f.hub);
    const current = accepted.plan;
    const next = () => h.proposal(f, [current.tasks[0], { ...current.tasks[1], description: "Use another bounded unstarted verification method" }], current);
    for (const change of [
      { goal: "Model tried to replace the user objective" },
      { completion: { ...current.completion, required_outputs: ["Weakened completion"] } },
      { budget: { ...current.budget, max_tasks: 100 } },
      { tasks: [{ ...current.tasks[0], prompt: "Changed immutable dispatched task instructions now" }, current.tasks[1]] },
    ]) {
      const proposal = next();
      const rejected = await h.invoke(f.hub, "submit_plan", { ...proposal, plan: { ...proposal.plan, ...change } });
      assert.ok(rejected.statusCode >= 400, rejected.payload);
      assert.deepEqual(await h.children(f.hub), before);
    }
    const other = await h.fixture();
    const crossScope = await h.invoke(other.hub, "submit_plan", next());
    assert.ok(crossScope.statusCode >= 400, crossScope.payload);
    assert.equal((await h.children(other.hub)).length, 0);
    const runtime = await h.start(String(before[0].id));
    await h.sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status)
      VALUES(${runtime.attempt},${before[0].id},'unresolved-revision-effect','execution','unknown')`;
    const unknown = await h.invoke(f.hub, "submit_plan", next());
    assert.equal(unknown.json().error_code, "plan_unknown_effect", unknown.payload);
    assert.deepEqual([...(await h.children(f.hub))], before.map((row, index) => index === 0 ? { ...row, status: "running" } : row));
  } finally { await h.close(); }
});
