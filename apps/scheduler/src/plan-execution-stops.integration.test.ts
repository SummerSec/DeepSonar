import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { contentSha256 } from "./domains/plan-protocol/criterion-model.js";
import { createPlanExecutionFixture, executionObjective } from "./plan-execution-test-fixture.js";

test("Plan v2 rejects unretained/mismatched outputs, unauthorized partial routes and unsafe continuation", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const h = await createPlanExecutionFixture();
  try {
    for (const mode of ["done", "wrong_output", "missing_bytes", "corrupt", "old_revision", "old_attempt", "rejected", "superseded", "unknown"] as const) {
      const f = await h.fixture(), p = h.proposal(f);
      const accepted = await h.invoke(f.hub, "submit_plan", p);
      assert.equal(accepted.statusCode, 200, accepted.payload);
      const child = String((await h.children(f.hub))[0].id);
      if (mode !== "done") {
        const output = await h.emit(child, {
          outputs: mode === "wrong_output" ? ["unrequested output"] : undefined,
          retain: mode !== "missing_bytes", corrupt: mode === "corrupt",
          revision: mode === "old_revision" ? "2" : undefined,
        });
        if (mode === "rejected") await h.sql`UPDATE canvas_nodes SET verification_status='rejected' WHERE id=${output.node_id}`;
        if (mode === "superseded") await h.sql`UPDATE artifacts SET status='superseded',superseded_at=now() WHERE id=${output.id}`;
        if (mode === "unknown") await h.sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status)
          VALUES(${output.attempt},${child},'unknown-fixture','execution','unknown')`;
        if (mode === "old_attempt") {
          await h.sql`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE id=${output.attempt}`;
          await h.start(child);
        }
      }
      if (mode === "unknown") {
        const denied = await h.invoke(child, "mark_job_done", { summary: "Unknown effects must never be repaired as success" });
        assert.equal(denied.statusCode, 409, denied.payload);
        await h.sql.begin(async (tx) => {
          await tx`SELECT id FROM canvases WHERE id=${f.canvas} FOR UPDATE`;
          await tx`UPDATE jobs SET status='orphan' WHERE id=${child}`;
          await tx`UPDATE job_attempts SET status='unknown',phase='terminal' WHERE job_id=${child}`;
          await h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, child);
        });
      } else await h.finish(child);
      assert.equal((await h.children(f.hub)).length, 1, mode);
      assert.equal((await h.state(f.canvas)).plan_execution.stop_reason, mode === "unknown" ? "unknown_external_effect" : "missing_output", mode);
      assert.equal((await h.state(f.canvas)).plan_objective.status, "stopped");
    }

    for (const role of ["hub_reason", "verify_finding", "report", "unadmitted-role"]) {
      const f = await h.fixture();
      const p = h.proposal(f, [h.task("allowed", f.root), { ...h.task("forbidden", f.root, ["allowed"]), role }]);
      const rejected = await h.invoke(f.hub, "submit_plan", p);
      assert.ok(rejected.statusCode >= 400, rejected.payload);
      assert.equal((await h.children(f.hub)).length, 0, "a forbidden delayed task cannot leave a partial root dispatch");
      assert.equal((await h.sql`SELECT id FROM events WHERE job_id=${f.hub} AND type='plan'`).length, 0);
    }
    for (const change of [{ runtime_image_key: "not-admitted" }, { allow_egress: true }, { cli_capability_ids: ["not-admitted"] }]) {
      const f = await h.fixture(), p = h.proposal(f);
      const denied = await h.invoke(f.hub, "submit_plan", { ...p, plan: { ...p.plan, tasks: [{ ...p.plan.tasks[0], ...change }] } });
      assert.ok(denied.statusCode >= 400, denied.payload);
      assert.equal((await h.children(f.hub)).length, 0);
    }

    const refs = await h.fixture(), unseen = randomUUID();
    await h.sql`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,verification_status,status,body_json)
      VALUES(${unseen},${refs.canvas},'fact','Unread canonical observation','unverified','open','{}')`;
    const unread = h.proposal(refs, [{ ...h.task("read-first", refs.root), from: [unseen] }]);
    const blind = await h.invoke(refs.hub, "submit_plan", unread);
    assert.equal(blind.json().error_code, "plan_source_unavailable", blind.payload);
    assert.equal((await h.children(refs.hub)).length, 0);
    assert.equal((await h.invoke(refs.hub, "graph_query", { kind: "node", ids: [unseen] })).statusCode, 200);
    const informed = await h.invoke(refs.hub, "submit_plan", unread);
    assert.equal(informed.statusCode, 200, informed.payload);
    assert.equal((await h.children(refs.hub)).length, 1);

    const revoked = await h.fixture();
    const revocable = h.proposal(revoked, [h.task("collect", revoked.root), { ...h.task("verify", revoked.root, ["collect"]), role: "review" }]);
    assert.equal((await h.invoke(revoked.hub, "submit_plan", revocable)).statusCode, 200);
    const predecessor = String((await h.children(revoked.hub))[0].id);
    await h.emit(predecessor);
    const unrelated = await h.fixture();
    await h.sql`UPDATE agent_roles SET project_id=${unrelated.project} WHERE name='review' AND project_id IS NULL`;
    await h.finish(predecessor);
    assert.equal((await h.sql`SELECT status FROM jobs WHERE id=${predecessor}`)[0].status, "succeeded", "later admission denial must not roll back proven predecessor success");
    assert.equal((await h.children(revoked.hub)).length, 1);
    assert.match((await h.state(revoked.canvas)).plan_execution.stop_reason, /^admission_denied:/);
    await h.sql`UPDATE agent_roles SET project_id=NULL WHERE name='review' AND project_id=${unrelated.project}`;

    for (const status of ["failed", "timeout", "cancelled", "orphan"]) {
      const f = await h.fixture(), p = h.proposal(f, [h.task("single", f.root)]);
      assert.equal((await h.invoke(f.hub, "submit_plan", p)).statusCode, 200);
      const child = String((await h.children(f.hub))[0].id);
      const runtime = await h.start(child);
      await h.sql.begin(async (tx) => {
        await tx`SELECT id FROM canvases WHERE id=${f.canvas} FOR UPDATE`;
        await tx`UPDATE jobs SET status=${status} WHERE id=${child}`;
        await tx`UPDATE job_attempts SET status='failed',phase='terminal',finished_at=now() WHERE id=${runtime.attempt}`;
        await h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, child);
      });
      assert.equal((await h.state(f.canvas)).plan_execution.stop_reason, `task_${status}`);
    }

    for (const noProgressLimit of [0, 1]) {
      const patch = executionObjective(); patch.completion.mode = "explicit_result";
      patch.budget.max_no_progress_rounds = noProgressLimit;
      const stalled = await h.fixture(patch), p = h.proposal(stalled, [h.task("single", stalled.root)]);
      assert.equal((await h.invoke(stalled.hub, "submit_plan", p)).statusCode, 200);
      const child = String((await h.children(stalled.hub))[0].id);
      await h.emit(child); await h.finish(child);
      const noProgress = await h.invoke(stalled.hub, "submit_plan_result", { v: 2,
        objective_id: p.plan.objective_id, objective_revision: "1", route_revision: "1", plan_sha256: contentSha256(p.plan),
        outcome: "continue", summary: "No further task or output has been proposed" });
      assert.equal(noProgress.statusCode, 200, noProgress.payload);
      assert.equal((await h.state(stalled.canvas)).plan_execution.stop_reason, "no_progress");
      const changed = await h.app.inject({ method: "PATCH", url: `/tasks/${stalled.canvas}`, payload: {
        plan_objective: { ...patch, expected_revision: "1" },
      } });
      assert.equal(changed.statusCode, 200, changed.payload);
      const replacement = h.proposal({ ...stalled, objective: changed.json().plan_objective }, p.plan.tasks, p.plan);
      const noReset = await h.invoke(stalled.hub, "submit_plan", replacement);
      assert.equal(noReset.statusCode, 200, noReset.payload);
      assert.equal((await h.children(stalled.hub)).length, 1, "objective CAS cannot reset the consumed no-progress lifetime guard");
      assert.equal((await h.state(stalled.canvas)).plan_execution.stop_reason, "no_progress");
    }

    // The same persisted result must survive every terminal/restart rebuild.
    const replayPatch = executionObjective(); replayPatch.completion.mode = "explicit_result";
    const replayFixture = await h.fixture(replayPatch);
    const replayPlan = h.proposal(replayFixture, [h.task("single", replayFixture.root)]);
    assert.equal((await h.invoke(replayFixture.hub, "submit_plan", replayPlan)).statusCode, 200);
    const replayChild = String((await h.children(replayFixture.hub))[0].id);
    await h.emit(replayChild); await h.finish(replayChild);
    const continueResult = { v: 2, objective_id: replayPlan.plan.objective_id, objective_revision: "1",
      route_revision: "1", plan_sha256: contentSha256(replayPlan.plan), outcome: "continue",
      summary: "No further task or output has been proposed" };
    const resultKey = randomUUID();
    const firstResult = await h.invoke(replayFixture.hub, "submit_plan_result", continueResult, resultKey);
    assert.equal(firstResult.statusCode, 200, firstResult.payload);
    const recorded = (await h.state(replayFixture.canvas)).plan_execution;
    assert.equal(recorded.no_progress_rounds, 1); assert.equal(recorded.stop_reason, null);
    assert.match(recorded.last_no_progress_result_event_id, /^[1-9][0-9]*$/);
    assert.equal((await h.invoke(replayFixture.hub, "submit_plan_result", continueResult, resultKey)).statusCode, 200);
    await h.sql.begin((tx) => h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, replayChild));
    await h.finish(replayFixture.hub);
    assert.deepEqual((await h.state(replayFixture.canvas)).plan_execution, recorded, "owner terminal must not spend the second round");
    const eventsBefore = await h.sql`SELECT id::text,event_id,job_seq,attempt_id,type,payload_json,created_at
      FROM events WHERE job_id=ANY(${[replayFixture.hub,replayChild]}::uuid[]) ORDER BY id`;
    const jobsBefore = await h.children(replayFixture.hub);
    const restartScript = `const {sql}=await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
      const {advancePlanTaskAfterTerminalJob}=await import(${JSON.stringify(new URL("./core.ts", import.meta.url).href)});
      try { for (const job of ${JSON.stringify([replayFixture.hub,replayChild])})
        await sql.begin(tx=>advancePlanTaskAfterTerminalJob(tx,job)); }
      finally { await sql.end({timeout:5}); }`;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", restartScript], { timeout: 30_000 });
    for (const job of [replayFixture.hub, replayChild]) {
      await h.sql.begin((tx) => h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, job));
    }
    assert.deepEqual((await h.state(replayFixture.canvas)).plan_execution, recorded);
    assert.equal((await h.state(replayFixture.canvas)).plan_objective.status, "active");
    assert.deepEqual(await h.children(replayFixture.hub), jobsBefore);
    const eventsAfter = await h.sql`SELECT id::text,event_id,job_seq,attempt_id,type,payload_json,created_at
      FROM events WHERE job_id=ANY(${[replayFixture.hub,replayChild]}::uuid[]) ORDER BY id`;
    assert.deepEqual(eventsAfter, eventsBefore, "reconstruction cannot rewrite immutable semantic history");

    // An identical body under a distinct committed event still spends budget.
    const distinct = await h.fixture(replayPatch), distinctPlan = h.proposal(distinct, [h.task("single", distinct.root)]);
    assert.equal((await h.invoke(distinct.hub, "submit_plan", distinctPlan)).statusCode, 200);
    const distinctChild = String((await h.children(distinct.hub))[0].id);
    const distinctResult = { ...continueResult, objective_id: distinctPlan.plan.objective_id, plan_sha256: contentSha256(distinctPlan.plan) };
    const distinctKey = randomUUID();
    assert.equal((await h.invoke(distinct.hub, "submit_plan_result", distinctResult, distinctKey)).statusCode, 200);
    assert.equal((await h.state(distinct.canvas)).plan_execution.no_progress_rounds, 0, "active task defers assessment");
    assert.equal((await h.state(distinct.canvas)).plan_execution.last_no_progress_result_event_id, undefined);
    await h.emit(distinctChild); await h.finish(distinctChild);
    assert.equal((await h.state(distinct.canvas)).plan_execution.no_progress_rounds, 1);
    assert.equal((await h.invoke(distinct.hub, "submit_plan_result", distinctResult, distinctKey)).statusCode, 200);
    const nextResult = await h.invoke(distinct.hub, "submit_plan_result", distinctResult);
    assert.equal(nextResult.statusCode, 200, nextResult.payload);
    const distinctEvents = await h.sql`SELECT id::text,payload_json FROM events WHERE job_id=${distinct.hub} AND type='plan_result' ORDER BY id`;
    assert.equal(distinctEvents.length, 2);
    assert.notEqual(distinctEvents[0].id, distinctEvents[1].id);
    assert.deepEqual(distinctEvents[0].payload_json, distinctEvents[1].payload_json);
    assert.equal((await h.state(distinct.canvas)).plan_execution.no_progress_rounds, 2);
    assert.equal((await h.state(distinct.canvas)).plan_execution.last_no_progress_result_event_id, distinctEvents[1].id);
    assert.equal((await h.state(distinct.canvas)).plan_execution.stop_reason, "no_progress");
    await h.sql.begin((tx) => h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, distinctChild));
    assert.equal((await h.state(distinct.canvas)).plan_execution.no_progress_rounds, 2);

    for (const provenance of ["missing", "foreign", "mismatched"] as const) {
      const f = await h.fixture(replayPatch), p = h.proposal(f, [h.task("single", f.root)]);
      assert.equal((await h.invoke(f.hub, "submit_plan", p)).statusCode, 200);
      const child = String((await h.children(f.hub))[0].id);
      await h.emit(child); await h.finish(child);
      const result = { ...continueResult, objective_id: p.plan.objective_id, plan_sha256: contentSha256(p.plan) };
      if (provenance === "foreign") {
        const foreign = await h.fixture(replayPatch);
        await h.sql`INSERT INTO events(job_id,event_id,job_seq,type,payload_json)
          SELECT ${foreign.hub},${randomUUID()},COALESCE(MAX(job_seq),0)+1,'plan_result',${h.sql.json(result)}
          FROM events WHERE job_id=${foreign.hub}`;
      }
      if (provenance === "mismatched") {
        const accepted = await h.invoke(f.hub, "submit_plan_result", result);
        assert.equal(accepted.statusCode, 200, accepted.payload);
      }
      const [owner] = await h.sql`SELECT payload_json FROM jobs WHERE id=${f.hub}`;
      // Corrupt only the mutable audit projection; source events stay immutable.
      const projectedResult = provenance === "mismatched" ? { ...result, summary: "This projection differs from its immutable event" } : result;
      await h.sql`UPDATE jobs SET payload_json=payload_json || ${h.sql.json({ plan_protocol: {
        ...owner.payload_json.plan_protocol, result: projectedResult,
      } })} WHERE id=${f.hub}`;
      const before = (await h.state(f.canvas)).plan_execution;
      await assert.rejects(h.sql.begin((tx) => h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, child)),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "plan_unknown_effect", provenance);
      assert.deepEqual((await h.state(f.canvas)).plan_execution, before, provenance);
      assert.equal((await h.children(f.hub)).length, 1, provenance);
    }

    const cappedPatch = executionObjective(); cappedPatch.budget.max_rounds = 1;
    const capped = await h.fixture(cappedPatch), initial = h.proposal(capped, [h.task("one", capped.root)]);
    assert.equal((await h.invoke(capped.hub, "submit_plan", initial)).statusCode, 200);
    const next = h.proposal(capped, [initial.plan.tasks[0], h.task("two", capped.root, ["one"])], initial.plan);
    const over = await h.invoke(capped.hub, "submit_plan", next);
    assert.equal(over.statusCode, 200, over.payload);
    assert.equal((await h.state(capped.canvas)).plan_execution.stop_reason, "budget_exhausted");
    assert.equal((await h.children(capped.hub)).length, 1);

    const stale = await h.fixture(), old = h.proposal(stale);
    assert.equal((await h.invoke(stale.hub, "submit_plan", old)).statusCode, 200);
    const historical = (await h.children(stale.hub))[0];
    const revised = await h.app.inject({ method: "PATCH", url: `/tasks/${stale.canvas}`, payload: { plan_objective: executionObjective("1") } });
    assert.equal(revised.statusCode, 200, revised.payload);
    const currentFixture = { ...stale, objective: revised.json().plan_objective };
    const current = h.proposal(currentFixture, old.plan.tasks, old.plan);
    const rerouted = await h.invoke(stale.hub, "submit_plan", current);
    assert.equal(rerouted.statusCode, 200, rerouted.payload);
    await h.emit(String(historical.id)); await h.finish(String(historical.id));
    const currentJobs = await h.children(stale.hub);
    assert.equal(currentJobs.length, 2, "old terminal frees a slot but cannot release the new revision's dependent");
    assert.equal(currentJobs[1].payload_json.plan_context.task_id, "collect");
    assert.equal(currentJobs[1].payload_json.plan_context.objective_revision, "2");
    const target = await h.state(stale.canvas);
    assert.equal(target.plan_objective.revision, "2"); assert.equal(target.plan_objective.status, "active");
    const [unchanged] = await h.sql`SELECT agent_snapshot_json,payload_json FROM jobs WHERE id=${historical.id}`;
    assert.deepEqual(unchanged.agent_snapshot_json, historical.agent_snapshot_json);
    assert.deepEqual(unchanged.payload_json.plan_context, historical.payload_json.plan_context);
    const lateResult = await h.invoke(stale.hub, "submit_plan_result", { v: 2, objective_id: old.plan.objective_id,
      objective_revision: "1", route_revision: "1", plan_sha256: contentSha256(old.plan), outcome: "complete",
      summary: "The superseded objective claims completion", termination_reason: "late_result" });
    assert.ok(lateResult.statusCode >= 400, lateResult.payload);
    assert.equal((await h.state(stale.canvas)).plan_objective.status, "active");
  } finally { await h.close(); }
});
