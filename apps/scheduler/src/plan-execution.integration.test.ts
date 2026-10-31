import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { contentSha256 } from "./domains/plan-protocol/criterion-model.js";
import { createPlanExecutionFixture, executionObjective } from "./plan-execution-test-fixture.js";

test("Plan v2 Control -> ingestion -> admitted Intent/Job -> fake Attempt/bytes -> graph projection", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const h = await createPlanExecutionFixture();
  try {
    const objective = executionObjective(); objective.budget.max_tasks = 2;
    const f = await h.fixture(objective), proposal = h.proposal(f);
    const [ownerBefore] = await h.sql`SELECT status,
      (SELECT count(*)::int FROM job_attempts WHERE job_id=j.id) AS attempts FROM jobs j WHERE id=${f.hub}`;
    await assert.rejects(h.start(f.hub), /fixture start must claim a pending Job once/);
    const [ownerAfter] = await h.sql`SELECT status,
      (SELECT count(*)::int FROM job_attempts WHERE job_id=j.id) AS attempts FROM jobs j WHERE id=${f.hub}`;
    assert.deepEqual(ownerAfter, ownerBefore, "duplicate fixture start cannot create an Attempt or rewrite running state");
    const key = randomUUID();
    const submitted = await h.invoke(f.hub, "submit_plan", proposal, key);
    assert.equal(submitted.statusCode, 200, submitted.payload);
    const replay = await h.invoke(f.hub, "submit_plan", proposal, key);
    assert.equal(replay.statusCode, 200, replay.payload);
    let jobs = await h.children(f.hub);
    assert.equal(jobs.length, 1, "only the ready root is dispatched; transport replay creates nothing");
    assert.equal(jobs[0].agent_snapshot_json.role_kind, "role");
    assert.equal(jobs[0].agent_snapshot_json.network_policy.allow_egress, false);
    assert.ok(jobs[0].agent_snapshot_json.platform_tools.includes("emit_fact"));
    const first = String(jobs[0].id), original = jobs[0];
    const output = await h.emit(first);
    await h.finish(first);
    jobs = await h.children(f.hub);
    assert.equal(jobs.length, 2, "matching retained output releases the dependent task");
    const second = jobs.find((job) => job.id !== first)!;
    assert.deepEqual(second.payload_json.plan_context.dependency_outputs[0].artifact_ids, [output.id]);
    assert.equal(second.payload_json.plan_context.dependency_outputs[0].attempt_id, output.attempt);
    const edges = await h.sql`SELECT edge_type FROM canvas_edges
      WHERE canvas_id=${f.canvas} AND from_node_id=${output.node_id} AND to_node_id=${second.payload_json.intent_node_id}`;
    assert.equal(edges[0]?.edge_type, "depends_on");
    const graph = await h.invoke(f.hub, "graph_query", { kind: "node", ids: [output.node_id] });
    assert.equal(graph.statusCode, 200, graph.payload);
    assert.match(graph.payload, new RegExp(String(output.node_id)));
    await h.finish(f.hub);
    assert.equal((await h.state(f.canvas)).plan_objective.status, "active", "owner terminal cannot close the last active task's budget");
    await h.emit(String(second.id)); await h.finish(String(second.id));
    const target = await h.state(f.canvas);
    assert.equal(target.plan_execution.stop_reason, "complete");
    assert.equal(target.plan_execution.lifetime_tasks_dispatched, 2);
    assert.equal(target.plan_objective.status, "completed");
    const [beforeReplay] = await h.sql`SELECT payload_json,agent_snapshot_json FROM jobs WHERE id=${first}`;
    await h.sql.begin((tx) => h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, String(second.id)));
    assert.equal((await h.children(f.hub)).length, 2, "terminal reconstruction is idempotent");
    const [afterReplay] = await h.sql`SELECT payload_json,agent_snapshot_json FROM jobs WHERE id=${first}`;
    assert.deepEqual(afterReplay, beforeReplay);
    assert.deepEqual(afterReplay.agent_snapshot_json, original.agent_snapshot_json);

    const multi = await h.fixture(), p1 = h.proposal(multi, [h.task("one", multi.root)]);
    assert.equal((await h.invoke(multi.hub, "submit_plan", p1)).statusCode, 200);
    const root = (await h.children(multi.hub))[0];
    const p2 = h.proposal(multi, [p1.plan.tasks[0], h.task("two", multi.root, ["one"])], p1.plan);
    const revised = await h.invoke(multi.hub, "submit_plan", p2);
    assert.equal(revised.statusCode, 200, revised.payload);
    const stale = await h.invoke(multi.hub, "submit_plan_result", {
      v: 2, objective_id: multi.objective.objective_id, objective_revision: "1", route_revision: "1",
      plan_sha256: contentSha256(p1.plan), outcome: "complete", summary: "Old route claims completion", termination_reason: "old_route",
    });
    assert.ok(stale.statusCode >= 400, stale.payload);
    await h.emit(String(root.id)); await h.finish(String(root.id));
    assert.equal((await h.children(multi.hub)).length, 2, "a revised route releases new dependent work");
    assert.equal((await h.state(multi.canvas)).plan_execution.lifetime_rounds, 2);

    const terminal = await h.fixture();
    await h.sql`UPDATE canvases SET target_json=target_json-'plan_objective' WHERE id=${terminal.canvas}`;
    const ordinaryDecision = await h.invoke(terminal.hub, "submit_hub_decision", { intents: [{
      role: "explore", from: [terminal.root], description: "Read the authorized scope through an ordinary Hub Intent",
      prompt: "Read only this Canvas scope and retain the resulting evidence through the existing Control API.",
    }] });
    assert.equal(ordinaryDecision.statusCode, 200, ordinaryDecision.payload);
    assert.equal((await h.children(terminal.hub)).length, 1);
    const [ordinaryHub] = await h.sql`SELECT payload_json FROM jobs WHERE id=${terminal.hub}`;
    assert.equal(ordinaryHub.payload_json.plan_protocol, undefined, "ordinary Hub decisions cannot manufacture a new historical v1 audit");
    const [{ mintJobToken }, { encryptSecret }] = await Promise.all([
      import("./gateway.js"), import("./credentials.js"),
    ]);
    const credential = randomUUID();
    const encrypted = encryptSecret(`fixture-${randomUUID()}`);
    await h.sql`INSERT INTO credentials(id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4)
      VALUES(${credential},'terminal fixture','llm_provider','openai',${encrypted.ciphertext},
        ${encrypted.nonce},${encrypted.auth_tag},'fixture','only')`;
    const modelToken = await mintJobToken({ jobId: terminal.hub, projectId: terminal.project, credentialId: credential });
    await assert.rejects(h.sql.begin(async (tx) => {
      await h.core.finalizeJob(tx as unknown as typeof h.sql, terminal.hub, "succeeded", { summary: "Rolled back terminal proposal" });
      throw new Error("rollback terminal fixture");
    }), /rollback terminal fixture/);
    const [rolledBack] = await h.sql`SELECT j.status,t.status AS token_status,
      (SELECT count(*)::int FROM job_capability_tokens c WHERE c.job_id=j.id AND c.revoked_at IS NULL) AS active_capabilities
      FROM jobs j JOIN job_tokens t ON t.job_id=j.id WHERE j.id=${terminal.hub} AND t.id=${modelToken.id}`;
    assert.equal(rolledBack.status, "running");
    assert.equal(rolledBack.token_status, "active", "terminal rollback must also restore the model credential");
    assert.equal(rolledBack.active_capabilities, 1, "Control revocation participates in the same rollback");
    const [rolledBackAudit] = await h.sql`SELECT count(*)::int AS count FROM audit_logs
      WHERE action='job_token.revoke' AND resource_id=${modelToken.id}`;
    assert.equal(rolledBackAudit.count, 0);
    await h.finish(terminal.hub);
    await assert.rejects(h.start(terminal.hub), /fixture start must claim a pending Job once/);
    assert.equal((await h.sql`SELECT status FROM jobs WHERE id=${terminal.hub}`)[0].status, "succeeded",
      "fixture startup cannot revive terminal Jobs");
    const [revoked] = await h.sql`SELECT status,revoke_reason FROM job_tokens WHERE id=${modelToken.id}`;
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revoke_reason, "job_succeeded");
    const denied = await h.invoke(terminal.hub, "mark_job_done", { summary: "Late completion cannot reuse the revoked Control token" });
    assert.equal(denied.statusCode, 401);
  } finally { await h.close(); }
});
