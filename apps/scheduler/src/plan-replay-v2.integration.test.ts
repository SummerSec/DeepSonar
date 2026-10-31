import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { Plan, mergePlanAudit } from "@deepsonar/shared-types";
import { createPlanExecutionFixture, executionObjective } from "./plan-execution-test-fixture.js";
import { contentSha256 } from "./domains/plan-protocol/criterion-model.js";
import { readPlanAudit } from "./domains/plan-protocol/application.js";
import { taskInputSha256 } from "./domains/plan-protocol/task-input.js";

type ReplayRow = {
  mode: "control_http";
  id: string;
  category: string;
  observed: Record<string, unknown>;
  trace: Record<string, unknown>;
};

const outputPath = process.env.PLAN_REPLAY_OUTPUT;
const fault = process.env.PLAN_REPLAY_FAULT ?? null;
const rows: ReplayRow[] = [];
const faultPaths: Record<string, string> = {
  unproven_completion_accepted: "test_runtime_handler_skip_completion_ingestion",
  scope_cross_project_accepted: "test_runtime_handler_in_memory_input_rewrite",
  stale_route_accepted: "test_runtime_handler_in_memory_input_rewrite",
  unknown_effect_replayed: "test_sql_effect_ledger_clear_before_completion_http",
  evidence_bytes_fabricated: "test_blob_byte_mutation_after_emit_fact",
  system_role_accepted: "test_runtime_handler_in_memory_input_rewrite",
  stop_bypass_accepted: "test_runtime_handler_in_memory_input_rewrite",
};

function responseBody(response: { json(): any }): any {
  try {
    const body = response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

function responseCode(response: { statusCode: number; json(): any }): string | null {
  const body = responseBody(response);
  return typeof body.error_code === "string" ? body.error_code : null;
}

async function record(id: string, category: string, observed: Record<string, unknown>, trace: Record<string, unknown>): Promise<void> {
  const row: ReplayRow = {
    mode: "control_http",
    id,
    category,
    observed: structuredClone(observed),
    trace: {
      ...trace,
      ...(fault && [
        "unproven_completion_accepted",
        "scope_cross_project_accepted",
        "stale_route_accepted",
        "unknown_effect_replayed",
        "evidence_bytes_fabricated",
        "system_role_accepted",
        "stop_bypass_accepted",
      ].includes(fault) && id === ({
        unproven_completion_accepted: "output_unbound_not_completion",
        scope_cross_project_accepted: "scope_cross_project_rejected",
        stale_route_accepted: "stale_route_rejected",
        unknown_effect_replayed: "unknown_effect_stops",
        evidence_bytes_fabricated: "positive_output_association",
        system_role_accepted: "system_role_rejected",
        stop_bypass_accepted: "explicit_human_stop",
      } as Record<string, string>)[fault]
        ? { fault_injection: { name: fault, actual_path: faultPaths[fault] ?? "unknown_test_fault_path" } }
        : {}),
    },
  };
  rows.push(row);
  if (outputPath) await appendFile(outputPath, `${JSON.stringify(row)}\n`, { encoding: "utf8" });
}

async function sqlTrace(h: any, jobId: string, evidence?: { id: string; uri: string; attempt: string }): Promise<Record<string, unknown>> {
  const [job] = await h.sql`SELECT id,status,canvas_id,project_id FROM jobs WHERE id=${jobId}`;
  const [attempt] = evidence
    ? await h.sql`SELECT id,status,phase,attempt_no FROM job_attempts WHERE job_id=${jobId} AND id=${evidence.attempt}`
    : await h.sql`SELECT id,status,phase,attempt_no FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no DESC,id DESC LIMIT 1`;
  const [events] = await h.sql`SELECT count(*)::int AS count FROM events WHERE job_id=${jobId}`;
  const [effect] = await h.sql`SELECT effect_id,status FROM job_attempt_effects WHERE job_id=${jobId} ORDER BY created_at DESC,id DESC LIMIT 1`;
  const trace: Record<string, unknown> = {
    job_id: job?.id ?? jobId,
    job_status: job?.status ?? null,
    canvas_id: job?.canvas_id ?? null,
    project_id: job?.project_id ?? null,
    attempt_id: attempt?.id ?? evidence?.attempt ?? null,
    attempt_status: attempt?.status ?? null,
    attempt_phase: attempt?.phase ?? null,
    attempt_no: attempt?.attempt_no ?? null,
    event_count: events?.count ?? 0,
    effect_id: effect?.effect_id ?? null,
    effect_status: effect?.status ?? null,
  };
  if (evidence) {
    const file = path.join(h.blob, "jobs", jobId, evidence.uri);
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifestBytes = await readFile(path.join(h.blob, "jobs", jobId, "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const manifestRawSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const entry = Array.isArray(manifest.files) ? manifest.files.find((item: any) => item.path === evidence.uri) : null;
    const [artifact] = await h.sql`SELECT id,node_id,source_event_id,source_operation,extensions_json FROM artifacts WHERE id=${evidence.id}`;
    const [event] = artifact?.source_event_id
      ? await h.sql`SELECT event_id,type,attempt_id,payload_json FROM events WHERE job_id=${jobId} AND event_id=${artifact.source_event_id}`
      : [];
    const pathAttemptId = /^attempts\/([^/]+)\//.exec(evidence.uri)?.[1] ?? null;
    trace.artifact_id = artifact?.id ?? null;
    trace.event_id = event?.event_id ?? null;
    trace.event_type = event?.type ?? null;
    trace.artifact_node_id = artifact?.node_id ?? null;
    trace.artifact_extensions = artifact?.extensions_json ?? null;
    trace.event_artifact_extensions = event?.payload_json?.artifact?.extensions ?? null;
    trace.evidence = {
      uri: evidence.uri,
      attempt_id: evidence.attempt,
      path_attempt_id: pathAttemptId,
      bytes: bytes.length,
      sha256,
      bytes_base64: bytes.toString("base64"),
      manifest_bytes: entry?.bytes ?? null,
      manifest_sha256: entry?.sha256 ?? null,
      manifest_finalized_at: manifest.finalized_at ?? null,
      manifest_raw_bytes_base64: manifestBytes.toString("base64"),
      manifest_raw_sha256: manifestRawSha256,
      artifact_id: artifact?.id ?? evidence.id,
      source_event_id: artifact?.source_event_id ?? null,
      source_event_attempt_id: event?.attempt_id ?? null,
      source_operation: artifact?.source_operation ?? null,
    };
  }
  return trace;
}

function planResult(f: any, p: any, outcome: "continue" | "complete" | "blocked" | "needs_human", terminationReason = "operator_required") {
  return {
    v: 2,
    objective_id: f.objective.objective_id,
    objective_revision: f.objective.revision,
    route_revision: p.plan.route_revision,
    plan_sha256: contentSha256(p.plan),
    outcome,
    summary: "The current v2 route was evaluated through the Control API",
    ...(outcome === "continue" ? {} : { termination_reason: terminationReason }),
  };
}

function completionBasis(gap: any, owner: string, outcome: "complete" | "continue" = "complete") {
  return {
    v: 1,
    plan_job_id: owner,
    plan_sha256: gap.plan_sha256,
    criterion_id: "completion",
    expected_revision: gap.revision,
    expected_task_input_sha256: gap.task_input_sha256,
    expected_projection_sha256: gap.projection_sha256,
    source_refs: Array.isArray(gap.source_refs) ? gap.source_refs.map((item: any) => ({ fact_id: item.fact_id, source_sha256: item.source_sha256 })) : [],
    outcome,
    rationale: "The operator evaluated the current bounded v2 route and retained the decision basis",
    ...(outcome === "continue" ? { expected_gain: "Collect the next current route output" } : {}),
  };
}

const fixtureOperations = ["submit_plan", "submit_plan_result", "submit_hub_decision", "graph_query", "emit_fact", "mark_job_done", "request_human"];

async function installFaultHandler(h: any, jobId: string, kind: string, rewrite?: (input: any) => any): Promise<void> {
  if (fault !== kind) return;
  h.api.registerRuntimeHandler(jobId, async (context: any) => {
    if (context.planPhase === "abort") return {};
    if (context.planPhase === "prepare") return { plan_prepared: true };
    if (context.completionPhase === "prepare") return { completion_prepared: true };
    if (context.completionPhase === "commit" || context.planPhase === "commit") return { accepted: true, event_id: context.eventId };
    if (context.operationId === "graph_query") {
      const { executeGraphQuery } = await import("./graph-query.js");
      return executeGraphQuery({ jobId, canvasId: String(context.canvasId), payload: context.input, maxCalls: 100, maxBytes: 1024 * 1024 });
    }
    if (context.operationId === "submit_hub_decision") return { accepted: true, event_id: context.eventId };
    const rewritten = rewrite ? rewrite(structuredClone(context.input)) : context.input;
    if (rewrite && context.input && typeof context.input === "object" && !Array.isArray(context.input)
      && rewritten && typeof rewritten === "object" && !Array.isArray(rewritten)) {
      // Test-only runtime fault: mutate the in-memory handler input before the
      // real ingestion/receipt path.  The HTTP response and durable event are
      // therefore the actual faulted result; no SQL row is rewritten later.
      for (const key of Object.keys(context.input as Record<string, unknown>)) delete (context.input as Record<string, unknown>)[key];
      Object.assign(context.input as Record<string, unknown>, rewritten);
    }
    const input = context.input;
    const type = context.operationId === "submit_plan" ? "plan" : context.operationId === "submit_plan_result" ? "plan_result" : "done";
    await h.core.ingestEvent(jobId, { v: 1, event_id: context.eventId, type, payload: input } as never);
    return { accepted: true, event_id: context.eventId };
  }, fixtureOperations);
}

test("current Plan v2 offline replay records real Control/SQL/evidence traces", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  if (outputPath) await writeFile(outputPath, "", { encoding: "utf8", mode: 0o600 });
  const h = await createPlanExecutionFixture();
  try {
    {
      const f = await h.fixture(), p = h.proposal(f, [h.task("collect", f.root), h.task("verify", f.root, ["collect"])]);
      const submitted = await h.invoke(f.hub, "submit_plan", p);
      const child = (await h.children(f.hub))[0];
      const output = await h.emit(String(child.id));
      if (fault === "evidence_bytes_fabricated") {
        await writeFile(path.join(h.blob, "jobs", String(child.id), output.uri), Buffer.from("tampered fixture bytes"));
      }
      const done = await h.invoke(String(child.id), "mark_job_done", {
        summary: fault === "evidence_bytes_fabricated" ? "Attempt to complete after the retained bytes changed" : "Completed the first retained output",
      });
      const released = await h.children(f.hub);
      const dependent: any = released.find((item: any) => item.id !== child.id);
      let dependentOutput: any = null;
      if (dependent) {
        dependentOutput = await h.emit(String(dependent.id));
        await h.invoke(String(dependent.id), "mark_job_done", { summary: "Completed the dependent retained output" });
      }
      const trace = await sqlTrace(h, String(child.id), output);
      const childContext = child.payload_json?.plan_context;
      const planOutput = (trace.artifact_extensions as any)?.["plan.output"];
      const eventPlanOutput = (trace.event_artifact_extensions as any)?.["plan.output"];
      const expectedPlanOutput = {
        v: 2, objective_id: childContext?.objective_id, objective_revision: childContext?.objective_revision,
        task_id: childContext?.task_id, task_sha256: childContext?.task_sha256,
        expected_outputs: child.payload_json?.intent?.expected_outputs,
      };
      const outputBinding = isDeepStrictEqual(planOutput, expectedPlanOutput)
        && isDeepStrictEqual(eventPlanOutput, expectedPlanOutput) ? "current_task" : "unbound_or_mismatched";
      const dependency = dependent?.payload_json?.plan_context?.dependency_outputs?.[0];
      await record("positive_output_association", "execution_output", {
        submit_status: submitted.statusCode,
        child_count: (await h.children(f.hub)).length,
        job_status: trace.job_status,
        attempt_status: trace.attempt_status,
        evidence_bytes: (trace.evidence as any).bytes,
        evidence_sha256: (trace.evidence as any).sha256,
        output_binding: outputBinding,
        dependent_released: Boolean(dependent),
        dependency_attempt_bound: dependency?.attempt_id === trace.attempt_id,
        dependency_artifact_bound: dependency?.artifact_ids?.length === 1 && dependency.artifact_ids[0] === (trace.evidence as any)?.artifact_id,
        semantic_completion: "not_claimed",
      }, { owner_job_id: f.hub, done_status: done.statusCode, ...trace,
        dependency_job_id: dependent?.id ?? null,
        dependency_context: dependent?.payload_json?.plan_context?.dependency_outputs ?? null,
        dependency_output_trace: dependentOutput ? await sqlTrace(h, String(dependent.id), dependentOutput) : null });
    }

    {
      const f = await h.fixture(), p = h.proposal(f), key = randomUUID();
      const first = await h.invoke(f.hub, "submit_plan", p, key);
      const replay = await h.invoke(f.hub, "submit_plan", p, key);
      const [events] = await h.sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.hub} AND type='plan'`;
      const children = await h.children(f.hub);
      await record("idempotent_route_replay", "execution", {
        first_status: first.statusCode,
        replay_status: replay.statusCode,
        child_count: children.length,
        plan_event_count: events.count,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)) });
    }

    {
      const f = await h.fixture(), foreign = await h.fixture(), p = h.proposal(f, [{ ...h.task("foreign", f.root), from: [foreign.root] }]);
      await installFaultHandler(h, f.hub, "scope_cross_project_accepted", (input: any) => ({
        ...input,
        plan: { ...input.plan, tasks: input.plan.tasks.map((task: any) => ({ ...task, from: [f.root] })) },
      }));
      const response = await h.invoke(f.hub, "submit_plan", p);
      const [events] = await h.sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.hub} AND type='plan'`;
      await record("scope_cross_project_rejected", "scope", {
        http_status: response.statusCode,
        error_code: responseCode(response),
        child_count: (await h.children(f.hub)).length,
        plan_event_count: events.count,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)), foreign_canvas: foreign.canvas });
    }

    {
      const f = await h.fixture(), p = h.proposal(f, [{ ...h.task("system", f.root), role: "hub_reason" }]);
      await installFaultHandler(h, f.hub, "system_role_accepted", (input: any) => ({
        ...input,
        plan: { ...input.plan, tasks: input.plan.tasks.map((task: any) => ({ ...task, role: "explore" })) },
      }));
      const response = await h.invoke(f.hub, "submit_plan", p);
      const [events] = await h.sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.hub} AND type='plan'`;
      await record("system_role_rejected", "system_role", {
        http_status: response.statusCode,
        error_code: responseCode(response),
        child_count: (await h.children(f.hub)).length,
        plan_event_count: events.count,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)) });
    }

    {
      const f = await h.fixture(), firstPlan = h.proposal(f);
      const first = await h.invoke(f.hub, "submit_plan", firstPlan);
      await installFaultHandler(h, f.hub, "stale_route_accepted", (input: any) => ({
        ...input,
        plan: { ...input.plan, route_revision: "2" },
        revision: { ...input.revision, expected_route_revision: "1", expected_plan_sha256: contentSha256(firstPlan.plan) },
      }));
      const stale = await h.invoke(f.hub, "submit_plan", h.proposal(f));
      const [events] = await h.sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.hub} AND type='plan'`;
      await record("stale_route_rejected", "stale_input", {
        first_status: first.statusCode,
        stale_status: stale.statusCode,
        stale_error_code: responseCode(stale),
        child_count: (await h.children(f.hub)).length,
        plan_event_count: events.count,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)) });
    }

    {
      const f = await h.fixture(), firstPlan = h.proposal(f);
      const first = await h.invoke(f.hub, "submit_plan", firstPlan);
      await h.sql`UPDATE canvases SET title='Changed current Canvas input' WHERE id=${f.canvas}`;
      const stale = await h.invoke(f.hub, "submit_plan", firstPlan);
      const [events] = await h.sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.hub} AND type='plan'`;
      await record("stale_canvas_input_rejected", "stale_input", {
        first_status: first.statusCode,
        stale_status: stale.statusCode,
        stale_error_code: responseCode(stale),
        child_count: (await h.children(f.hub)).length,
        plan_event_count: events.count,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)) });
    }

    {
      const f = await h.fixture();
      const historical = Plan.parse({ v: 1, goal: "Retain historical scoped execution evidence", tasks: [h.task("historical", f.root)], completion: {
        mode: "explicit_result", description: "Historical operator completion criterion", required_outputs: [],
      } });
      const audit = mergePlanAudit(null, { source: "submit_plan", raw: historical, trimmed: historical });
      await h.sql`UPDATE canvases SET target_json=target_json-'plan_objective' WHERE id=${f.canvas}`;
      const [canvas] = await h.sql`SELECT title,target_json FROM canvases WHERE id=${f.canvas}`;
      await h.sql`UPDATE jobs SET payload_json=payload_json || ${h.sql.json({ plan_protocol: audit, plan_input_sha256: taskInputSha256(canvas.title, canvas.target_json) })} WHERE id=${f.hub}`;
      await h.sql`INSERT INTO events(job_id,event_id,job_seq,type,payload_json) VALUES(${f.hub},${randomUUID()},1,'plan',${h.sql.json({ plan: historical })})`;
      const submit = await h.invoke(f.hub, "submit_plan", { plan: historical });
      const result = await h.invoke(f.hub, "submit_plan_result", { v: 1, outcome: "complete", summary: "A historical result cannot complete a current-v2 route" });
      const gap = await h.invoke(f.hub, "graph_query", { kind: "plan_gap" });
      const item = responseBody(gap).items?.[0];
      await record("historical_v1_refused", "historical_v1", {
        submit_status: submit.statusCode,
        submit_error_code: responseCode(submit),
        result_status: result.statusCode,
        result_error_code: responseCode(result),
        historical_readable: item?.historical === true,
        child_count: (await h.children(f.hub)).length,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)), historical_plan_sha256: item?.plan_sha256 ?? null });
    }

    {
      const f = await h.fixture(), p = h.proposal(f, [h.task("collect", f.root)]);
      await installFaultHandler(h, f.hub, "unproven_completion_accepted");
      const submitted = await h.invoke(f.hub, "submit_plan", p), child = (await h.children(f.hub))[0];
      const output = await h.emit(String(child.id));
      const done = await h.invoke(String(child.id), "mark_job_done", { summary: "The current task produced and finalized its retained output" });
      assert.equal(done.statusCode, 200, done.payload);
      const completedState = await h.state(f.canvas);
      assert.equal(completedState.plan_execution?.stop_reason, "complete");
      assert.equal(completedState.plan_objective?.status, "completed");
      const gapResponse = await h.invoke(f.hub, "graph_query", { kind: "plan_gap" });
      const gap = responseBody(gapResponse).items?.[0];
      const completion = await h.invoke(f.hub, "submit_hub_decision", {
        complete: { from: [f.root], description: "Claim completion before current operator authorization" },
        plan_basis: completionBasis(gap, f.hub),
      });
      const trace = await sqlTrace(h, String(child.id), output);
      assert.equal(trace.job_status, "succeeded");
      assert.equal(trace.attempt_status, "succeeded");
      await record("output_unbound_not_completion", "semantic_gate", {
        output_status: submitted.statusCode,
        criterion_state: gap?.criteria?.[0]?.state ?? "unknown",
        completion_status: completion.statusCode,
        completion_error_code: responseCode(completion),
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)), child: trace, done_status: done.statusCode,
        execution_stop_reason: completedState.plan_execution?.stop_reason ?? null,
        objective_status: completedState.plan_objective?.status ?? null });
    }

    {
      const f = await h.fixture(), p = h.proposal(f, [h.task("collect", f.root), h.task("verify", f.root, ["collect"])]);
      await h.invoke(f.hub, "submit_plan", p);
      const first = (await h.children(f.hub))[0], firstOutput = await h.emit(String(first.id));
      await h.finish(String(first.id));
      const second = (await h.children(f.hub)).find((item: any) => item.id !== first.id);
      assert.ok(second, "operator gate fixture must release the dependent v2 task");
      const secondOutput = await h.emit(String(second.id));
      await h.finish(String(second.id));
      const outputs = [firstOutput, secondOutput];
      const detail = async (factId: string) => responseBody(await h.app.inject({ method: "GET", url: `/canvases/${f.canvas}/facts/${factId}` }));
      const bind = async (criterion: string, output: any) => {
        const source = (await detail(output.node_id)).plan_criterion_source;
        return h.app.inject({ method: "PATCH", url: `/canvases/${f.canvas}/facts/${output.node_id}/verification`, payload: {
        status: "verified", note: "Operator explicitly authorizes the current v2 criterion", plan_binding: {
          plan_job_id: f.hub, plan_sha256: contentSha256(p.plan), criterion_id: criterion,
          expected_source_sha256: source?.source_sha256, expected_binding_id: null,
          assessment: "satisfies", observation: "positive",
        },
        } });
      };
      const before = responseBody(await h.invoke(f.hub, "graph_query", { kind: "plan_gap" })).items?.[0];
      const criteria = Array.isArray(before?.criteria) ? before.criteria.map((item: any) => String(item.id)) : [];
      const bindings = [];
      for (const [index, criterion] of criteria.entries()) bindings.push(await bind(criterion, outputs[index % outputs.length]));
      const seen = await h.invoke(f.hub, "graph_query", { kind: "node", ids: outputs.map((item) => item.node_id) });
      assert.equal(seen.statusCode, 200, seen.payload);
      const gapResponse = await h.invoke(f.hub, "graph_query", { kind: "plan_gap" });
      const gap = responseBody(gapResponse).items?.[0];
      const completion = await h.invoke(f.hub, "submit_hub_decision", {
        complete: { from: [f.root, ...outputs.map((item) => item.node_id)], description: "Operator explicitly authorizes every current v2 criterion" },
        plan_basis: completionBasis(gap, f.hub),
      });
      await record("operator_authorized_completion", "operator_gate", {
        completion_status: completion.statusCode,
        receipt_status: responseBody(completion).receipt_status ?? null,
        operator_commit_count: (await h.sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.hub} AND type='hub_decision'`)[0].count,
        criteria_all_satisfied: Boolean(gap?.criteria?.length) && gap.criteria.every((item: any) => item.state === "satisfied"),
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)), fact_ids: outputs.map((item) => item.node_id), binding_statuses: bindings.map((item: any) => item.statusCode), completion_error_code: responseCode(completion) });
    }

    {
      const f = await h.fixture(), p = h.proposal(f);
      await h.invoke(f.hub, "submit_plan", p);
      const child = (await h.children(f.hub))[0], output = await h.emit(String(child.id));
      await h.sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status) VALUES(${output.attempt},${child.id},'replay-unknown-effect','execution','unknown')`;
      const [effectBefore] = await h.sql`SELECT effect_id,status FROM job_attempt_effects WHERE job_id=${child.id} AND effect_id='replay-unknown-effect'`;
      if (fault === "unknown_effect_replayed") await h.sql`UPDATE job_attempt_effects SET status='settled' WHERE effect_id='replay-unknown-effect'`;
      const done = await h.invoke(String(child.id), "mark_job_done", { summary: "Unknown effects must never be repaired as success" });
      if (fault !== "unknown_effect_replayed") {
        await h.sql.begin(async (tx: any) => {
          await tx`SELECT id FROM canvases WHERE id=${f.canvas} FOR UPDATE`;
          await tx`UPDATE jobs SET status='orphan' WHERE id=${child.id}`;
          await tx`UPDATE job_attempts SET status='unknown',phase='terminal' WHERE job_id=${child.id}`;
          await h.core.advancePlanTaskAfterTerminalJob(tx as any, String(child.id));
        });
      }
      const finalTarget = await h.state(f.canvas);
      const [effectAfter] = await h.sql`SELECT effect_id,status FROM job_attempt_effects WHERE job_id=${child.id} AND effect_id='replay-unknown-effect'`;
      await record("unknown_effect_stops", "unknown_effect", {
        done_status: done.statusCode,
        error_code: responseCode(done),
        stop_reason: finalTarget.plan_execution?.stop_reason ?? null,
        objective_status: finalTarget.plan_objective?.status ?? null,
      }, { owner_job_id: f.hub, effect_status_before: effectBefore?.status ?? null, effect_status_after: effectAfter?.status ?? null,
        ...(await sqlTrace(h, String(child.id), output)) });
    }

    {
      const f = await h.fixture(), p = h.proposal(f, [h.task("single", f.root)]);
      await h.invoke(f.hub, "submit_plan", p);
      const child = (await h.children(f.hub))[0];
      await h.start(String(child.id));
      const done = await h.invoke(String(child.id), "mark_job_done", { summary: "No retained output was produced" });
      const target = await h.state(f.canvas);
      await record("missing_output_stops", "stop", {
        done_status: done.statusCode,
        stop_reason: target.plan_execution?.stop_reason ?? null,
        objective_status: target.plan_objective?.status ?? null,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, String(child.id))) });
    }

    for (const [status, id] of [["timeout", "terminal_timeout_stops"], ["cancelled", "terminal_cancelled_stops"], ["orphan", "terminal_orphan_stops"]] as const) {
      const f = await h.fixture(), p = h.proposal(f, [h.task("single", f.root)]);
      await h.invoke(f.hub, "submit_plan", p);
      const child = (await h.children(f.hub))[0], runtime = await h.start(String(child.id));
      await h.sql.begin(async (tx: any) => {
        await tx`SELECT id FROM canvases WHERE id=${f.canvas} FOR UPDATE`;
        await tx`UPDATE jobs SET status=${status} WHERE id=${child.id}`;
        await tx`UPDATE job_attempts SET status='failed',phase='terminal',finished_at=now() WHERE id=${runtime.attempt}`;
        await h.core.advancePlanTaskAfterTerminalJob(tx as any, String(child.id));
      });
      const target = await h.state(f.canvas);
      await record(id, "stop", {
        stop_reason: target.plan_execution?.stop_reason ?? null,
        job_status: (await h.sql`SELECT status FROM jobs WHERE id=${child.id}`)[0].status,
        attempt_status: (await h.sql`SELECT status FROM job_attempts WHERE id=${runtime.attempt}`)[0].status,
        objective_status: target.plan_objective?.status ?? null,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, String(child.id))) });
    }

    {
      const f = await h.fixture(), p = h.proposal(f, [h.task("single", f.root)]);
      await h.invoke(f.hub, "submit_plan", p);
      const child = (await h.children(f.hub))[0], runtime = await h.start(String(child.id));
      await h.sql.begin(async (tx: any) => {
        await tx`SELECT id FROM canvases WHERE id=${f.canvas} FOR UPDATE`;
        await tx`UPDATE jobs SET status='failed' WHERE id=${child.id}`;
        await tx`UPDATE job_attempts SET status='failed',phase='terminal',finished_at=now() WHERE id=${runtime.attempt}`;
        await h.core.advancePlanTaskAfterTerminalJob(tx as any, String(child.id));
      });
      const target = await h.state(f.canvas);
      await record("terminal_failure_stops", "stop", {
        stop_reason: target.plan_execution?.stop_reason ?? null,
        job_status: (await h.sql`SELECT status FROM jobs WHERE id=${child.id}`)[0].status,
        attempt_status: (await h.sql`SELECT status FROM job_attempts WHERE id=${runtime.attempt}`)[0].status,
        objective_status: target.plan_objective?.status ?? null,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, String(child.id))) });
    }

    {
      const objective = executionObjective(); objective.completion.mode = "explicit_result"; objective.budget.max_no_progress_rounds = 0;
      const f = await h.fixture(objective), p = h.proposal(f, [h.task("single", f.root)]);
      await h.invoke(f.hub, "submit_plan", p);
      const child = (await h.children(f.hub))[0]; await h.emit(String(child.id)); await h.finish(String(child.id));
      const result = await h.invoke(f.hub, "submit_plan_result", planResult(f, p, "continue", "No further task or output has been proposed"));
      const target = await h.state(f.canvas);
      await record("no_progress_stops", "stop", {
        result_status: result.statusCode,
        stop_reason: target.plan_execution?.stop_reason ?? null,
        objective_status: target.plan_objective?.status ?? null,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, f.hub)) });
    }

    {
      const f = await h.fixture(), p = h.proposal(f, [h.task("single", f.root)]);
      await h.invoke(f.hub, "submit_plan", p);
      const child = (await h.children(f.hub))[0];
      await installFaultHandler(h, f.hub, "stop_bypass_accepted", (input: any) => ({
        ...input, outcome: "continue", summary: "Continue after the test-only stop bypass",
      }));
      const result = await h.invoke(f.hub, "submit_plan_result", planResult(f, p, "needs_human", "Authorized human input is required"));
      const target = await h.state(f.canvas);
      await record("explicit_human_stop", "human_stop", {
        result_status: result.statusCode,
        stop_reason: target.plan_execution?.stop_reason ?? null,
        objective_status: target.plan_objective?.status ?? null,
        child_count: (await h.children(f.hub)).length,
      }, { owner_job_id: f.hub, ...(await sqlTrace(h, String(child.id))) });
    }

    const [database] = await h.sql`SELECT current_database() AS name`;
    if (outputPath) await appendFile(outputPath, `${JSON.stringify({
      kind: "meta", schema: "deepsonar.plan-offline-observations/v2", fixture_completed: true,
      real_sql_http: true, database_isolated: typeof database.name === "string" && database.name.startsWith("plan_execution_"),
      case_count: rows.length, fault,
    })}\n`, { encoding: "utf8" });
  } finally {
    await h.close();
  }
});
