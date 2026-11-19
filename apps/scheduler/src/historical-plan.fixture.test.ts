import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import type { createPlanExecutionFixture } from "./plan-execution-test-fixture.js";
import { executionObjective } from "./plan-execution-test-fixture.js";
import { checkpointGuardFixture } from "./domains/job-control/human-checkpoint-fixture.js";
import { checkpointHash } from "./domains/job-control/human-checkpoint-files.js";
import { sealHumanCheckpoint } from "./domains/job-control/human-checkpoint.js";
import { destroyAndSettleHumanWaitRun } from "./dispatcher-human-wait.js";
import { updateAttemptResource, beginEffect } from "./domains/job-attempt/index.js";
import { humanExecutionStartedAt } from "./domains/job-control/human-continuation-clock.js";
import { ensureGatewayRequestBudget } from "./gateway-request-policy.js";

/** Start with a user HTTP objective and Control Plan dispatch, then continue its actual child. */
export async function historicalPlanCases(h: Awaited<ReturnType<typeof createPlanExecutionFixture>>) {
  const sealAndFail = async (jobId: string) => {
    const runtime = await h.start(jobId), sandboxId = `plan-history-${jobId}`;
    await updateAttemptResource(h.sql, runtime.attempt, { sandboxId, phase: "provisioned" });
    await h.sql`UPDATE jobs SET sandbox_id=${sandboxId} WHERE id=${jobId}`;
    await humanExecutionStartedAt(h.sql, jobId, runtime.attempt);
    await beginEffect(h.sql, runtime.attempt, { effectId: 'agent_run:1', kind: 'agent_run', replayPolicy: 'never',
      resourceIdentity: { job_id: jobId, attempt_id: runtime.attempt, sandbox_id: sandboxId } });
    const [job] = await h.sql`SELECT agent_snapshot_json FROM jobs WHERE id=${jobId}`;
    await ensureGatewayRequestBudget(h.sql, jobId, job.agent_snapshot_json);
    const request = await h.invoke(jobId, "request_human", { reason: "Confirm the authorized Plan reference", subject: { type: "platform_blocker", kind: "authorization" },
      guidance: { question: "Which reference applies?", required_action: "Check authorization", reply_instructions: "Send its reference", after_reply: "Continue the authorized Plan task" } });
    assert.equal(request.statusCode, 200, request.body);
    const [saved] = await h.sql`SELECT id FROM human_requests WHERE job_id=${jobId}`;
    assert.ok(saved, "normal request_human must persist its checkpoint owner");
    const bytes = Buffer.from("unfinished Plan child output");
    const host = { run: async () => ({ exitCode: 0, stdout: JSON.stringify([{ path: "plan.txt", bytes: bytes.length, sha256: checkpointHash(bytes), mode: 0o600 }]), stderr: "" }),
      runAsync: async () => checkpointGuardFixture(), readWorkspaceFile: async () => bytes } as unknown as RuntimeHost;
    await sealHumanCheckpoint({ jobId, attemptId: runtime.attempt, host, excludedPaths: [], secrets: [], processBaseline: [] });
    await destroyAndSettleHumanWaitRun(h.sql, { destroy: async () => {} }, { jobId, attemptId: runtime.attempt, sandboxId });
    await h.sql`UPDATE jobs SET status='failed' WHERE id=${jobId}`;
    const [closed] = await h.sql`SELECT revision FROM human_requests WHERE id=${saved.id}`;
    return { mutation_id: randomUUID(), request_id: String(saved.id), expected_revision: Number(closed.revision),
      reply: { message_id: randomUUID(), body: "Continue the authorized Plan work with the original reference" } };
  };
  for (const mode of ["remaining", "exhausted", "stopped"] as const) {
    const objective = executionObjective(); objective.budget.max_tasks = mode === "exhausted" ? 1 : 2;
    const f = await h.fixture(objective), proposal = h.proposal(f, [h.task("collect", f.root)]);
    const submitted = await h.invoke(f.hub, "submit_plan", proposal);
    assert.equal(submitted.statusCode, 200, submitted.body);
    const child = String((await h.children(f.hub))[0].id);
    const payload = await sealAndFail(child);
    if (mode === "stopped") await h.sql`UPDATE canvases SET target_json=jsonb_set(target_json,'{plan_execution,stop_reason}', '"user_stop"'::jsonb) WHERE id=${f.canvas}`;
    const response = await h.app.inject({ method: "POST", url: `/jobs/${child}/continuations`, payload });
    if (mode !== "remaining") {
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error_code, mode === "exhausted" ? "PLAN_CONTINUATION_TASK_BUDGET_EXHAUSTED" : "PLAN_CONTINUATION_OBJECTIVE_INACTIVE");
      assert.equal(response.json().reply_state, "reply_saved");
      assert.equal((await h.children(f.hub)).length, 1);
      continue;
    }
    assert.equal(response.statusCode, 202, response.body);
    const target = String(response.json().job_id);
    assert.equal((await h.state(f.canvas)).plan_execution.lifetime_tasks_dispatched, 2);
    assert.equal((await h.children(f.hub)).length, 2, "failed source and continuation both consume dispatched slots");
    // The original failed callback can arrive after handoff. It must resolve the live leaf.
    await h.sql.begin(tx => h.core.advancePlanTaskAfterTerminalJob(tx as unknown as typeof h.sql, child));
    assert.equal((await h.state(f.canvas)).plan_execution.stop_reason, null);
    assert.equal((await h.sql`SELECT status FROM jobs WHERE id=${target}`)[0].status, "pending");
    assert.equal((await h.sql`SELECT status FROM jobs WHERE id=${child}`)[0].status, "failed");
    const [source] = await h.sql`SELECT payload_json,parent_job_id FROM jobs WHERE id=${child}`;
    const [successor] = await h.sql`SELECT payload_json,parent_job_id FROM jobs WHERE id=${target}`;
    assert.deepEqual(successor, source, "continuation retains scheduler Plan assignment and parent");
    const exhausted = await sealAndFail(target);
    const denied = await h.app.inject({ method: "POST", url: `/jobs/${target}/continuations`, payload: exhausted });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().error_code, "PLAN_CONTINUATION_TASK_BUDGET_EXHAUSTED");
    assert.equal((await h.state(f.canvas)).plan_execution.lifetime_tasks_dispatched, 2);
  }
}
