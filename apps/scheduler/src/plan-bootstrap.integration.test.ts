import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PlanObjective } from "@deepsonar/shared-types";
import { PlatformRuntimeHandlerError } from "./domains/platform-api/registry.js";
import {
  createPlanExecutionFixture,
  executionObjective,
} from "./plan-execution-test-fixture.js";

type PlanFixture = Awaited<ReturnType<typeof createPlanExecutionFixture>>;
type FixtureCanvas = Awaited<ReturnType<PlanFixture["fixture"]>>;
type JsonObject = Record<string, unknown>;

const FIXTURE_GRAPH_MAX_BYTES = 1024 * 1024;
const GRAPH_QUERY_RESPONSE_LIMIT = 512_000;

function maximumObjective() {
  const objective = executionObjective();
  objective.goal = "g" + "\u0001".repeat(3_999);
  objective.completion.description = "c" + "\u0002".repeat(3_999);
  (objective.completion.required_outputs as unknown as string[]) = Array.from({ length: 32 }, (_, index) => {
    const prefix = `required-output-${index}-`;
    return prefix + "\u0003".repeat(500 - prefix.length);
  });
  return objective;
}

function responseBody(response: { json(): unknown }): JsonObject {
  return response.json() as JsonObject;
}

async function readCurrentObjective(h: PlanFixture, jobId: string): Promise<{
  response: Awaited<ReturnType<PlanFixture["invoke"]>>;
  body: JsonObject;
  objective: PlanObjective;
}> {
  const response = await h.invoke(jobId, "graph_query", { kind: "plan_objective" });
  assert.equal(response.statusCode, 200, response.payload);
  const body = responseBody(response);
  const items = body.items;
  assert.ok(Array.isArray(items) && items.length === 1, response.payload);
  return { response, body, objective: items[0] as PlanObjective };
}

async function assertNoPlanWork(h: PlanFixture, fixture: FixtureCanvas): Promise<void> {
  assert.equal((await h.children(fixture.hub)).length, 0, "rejected bootstrap must not admit a child Job");
  const [row] = await h.sql`
    SELECT count(*)::int AS count
    FROM events e
    JOIN jobs j ON j.id = e.job_id
    WHERE j.canvas_id = ${fixture.canvas} AND e.type = 'plan'`;
  assert.equal(Number(row?.count ?? 0), 0, "rejected bootstrap must not persist a Plan event");
}

async function postGraphQuery(
  h: PlanFixture,
  jobId: string,
  token: string | undefined,
  payload: unknown,
) {
  const headers: Record<string, string> = { "idempotency-key": randomUUID() };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return h.app.inject({
    method: "POST",
    url: `/control/v1/jobs/${jobId}/operations/graph_query`,
    headers,
    payload: payload as never,
  });
}

async function addHubOverviewFiller(h: PlanFixture, canvasId: string): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await h.sql`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,verification_status,body_json)
      VALUES(${randomUUID()},${canvasId},'fact',${`bootstrap filler ${index}`},'active','unverified','{}')`;
  }
}

function assertRejectedGraphQuery(response: { statusCode: number; json(): unknown }, expectedCode?: string): JsonObject {
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, JSON.stringify(response.json()));
  const body = responseBody(response);
  assert.notEqual(body.accepted, true);
  assert.equal(body.items, undefined);
  assert.equal(body.target, undefined);
  assert.equal(body.catalog, undefined);
  if (expectedCode !== undefined) assert.equal(body.error_code, expectedCode, JSON.stringify(body));
  return body;
}

function assertCompleteObjectiveEnvelope(body: JsonObject, wireBytes: number): PlanObjective {
  assert.equal(body.accepted, true);
  assert.equal(body.operation, "graph_query");
  assert.equal(body.kind, "plan_objective");
  assert.equal(body.truncated, false);
  assert.deepEqual(body.omitted, {});
  assert.deepEqual(body.referable_ids, []);
  assert.equal(body.next_cursor, undefined);
  assert.equal(body.plan_read, undefined);
  assert.equal(body.refs, undefined);
  assert.equal(body.counters, undefined);
  assert.deepEqual(
    Object.keys(body).sort(),
    ["accepted", "budget", "items", "kind", "omitted", "operation", "referable_ids", "truncated"].sort(),
  );
  assert.ok(Array.isArray(body.items) && body.items.length === 1);
  const item = body.items[0] as PlanObjective;
  assert.deepEqual(
    Object.keys(item).sort(),
    ["v", "objective_id", "revision", "goal", "completion", "budget", "input_sha256", "status", "updated_at"].sort(),
  );
  const budget = body.budget as { calls_left: number | null; bytes_left: number | null };
  assert.equal(budget.calls_left, 99);
  assert.equal(typeof budget.bytes_left, "number");
  assert.ok(wireBytes <= FIXTURE_GRAPH_MAX_BYTES - (budget.bytes_left as number));
  assert.ok(wireBytes < GRAPH_QUERY_RESPONSE_LIMIT);
  return item;
}

test(
  "Plan bootstrap reads the complete maximum objective and admits exactly one first route",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const h = await createPlanExecutionFixture();
    try {
      const objectivePatch = maximumObjective();
      const fixture = await h.fixture(objectivePatch);

      // Force the actual Hub bootstrap projection through its L0 overview
      // branch. The objective remains a handle here; the full tuple must come
      // from the authenticated Job-scoped read below.
      await addHubOverviewFiller(h, fixture.canvas);
      const { buildGraphSnapshot } = await import("./graph.js");
      const initial = await buildGraphSnapshot(fixture.canvas, "hub", { maxYamlChars: 512 });
      assert.equal(initial.truncated, true);
      assert.ok(initial.yamlChars <= 512, `initial Hub projection exceeded its bound: ${initial.yamlChars}`);
      const handleLine = initial.yaml.split("\n").find((line) => line.startsWith("plan_objective: "));
      assert.ok(handleLine, initial.yaml);
      const handle = JSON.parse(handleLine.slice("plan_objective: ".length)) as JsonObject;
      assert.deepEqual(handle, {
        kind: "plan_objective",
        available: true,
        objective_id: handle.objective_id,
        revision: "1",
        status: "active",
      });
      assert.equal(typeof handle.objective_id, "string");
      assert.ok(!initial.yaml.includes(objectivePatch.completion.description));

      const [beforePlan] = await h.sql`
        SELECT count(*)::int AS count
        FROM events e JOIN jobs j ON j.id=e.job_id
        WHERE j.canvas_id=${fixture.canvas} AND e.type='plan'`;
      assert.equal(Number(beforePlan?.count ?? 0), 0);

      // The accepted-Plan criteria reader is intentionally separate from the
      // current-objective bootstrap reader and must refuse before any Plan
      // exists, without creating a plan_read proof or spending a successful
      // graph-query budget unit.
      const prePlanGap = await h.invoke(fixture.hub, "graph_query", { kind: "plan_gap" });
      const prePlanGapBody = assertRejectedGraphQuery(prePlanGap, "invalid_payload");
      assert.equal(prePlanGapBody.plan_read, undefined);
      const [prePlanGapStateRow] = await h.sql`SELECT payload_json->'graph_query' AS state FROM jobs WHERE id=${fixture.hub}`;
      const prePlanGapState = (prePlanGapStateRow?.state ?? {}) as JsonObject;
      assert.equal(Number(prePlanGapState.calls ?? 0), 0);
      assert.equal(Number(prePlanGapState.bytes ?? 0), 0);

      // Add large unrelated task text after the first objective write, then
      // refresh the objective through its authorized CAS. The objective
      // reader must expose the current tuple without leaking a bounded target
      // preview or replacing the objective goal with target.goal/content.
      const unrelatedMarker = "UNRELATED_TARGET_SENTINEL";
      const unrelatedContent = "unrelated-content-" + "x".repeat(2_400) + unrelatedMarker;
      const unrelatedGoal = "unrelated-goal-" + "y".repeat(2_400) + unrelatedMarker;
      await h.sql`UPDATE canvases
        SET target_json = target_json || ${h.sql.json({ content: unrelatedContent, goal: unrelatedGoal } as never)}
        WHERE id=${fixture.canvas}`;
      const refreshed = await h.app.inject({
        method: "PATCH",
        url: `/tasks/${fixture.canvas}`,
        payload: {
          plan_objective: {
            expected_revision: "1",
            goal: objectivePatch.goal,
            completion: objectivePatch.completion,
            budget: objectivePatch.budget,
          },
        },
      });
      assert.equal(refreshed.statusCode, 200, refreshed.payload);
      const refreshedSnapshot = await buildGraphSnapshot(fixture.canvas, "hub", { maxYamlChars: 12_000 });
      assert.equal(refreshedSnapshot.goal, objectivePatch.goal);
      assert.equal(refreshedSnapshot.yaml.includes(unrelatedMarker), false);
      const refreshedHandleLine = refreshedSnapshot.yaml.split("\n").find((line) => line.startsWith("plan_objective: "));
      assert.ok(refreshedHandleLine, refreshedSnapshot.yaml);
      const refreshedHandle = JSON.parse(refreshedHandleLine.slice("plan_objective: ".length)) as JsonObject;

      const read = await readCurrentObjective(h, fixture.hub);
      const wireBytes = Buffer.byteLength(read.response.payload, "utf8");
      const discovered = assertCompleteObjectiveEnvelope(read.body, wireBytes);
      assert.equal(discovered.objective_id, handle.objective_id);
      assert.equal(refreshedHandle.objective_id, discovered.objective_id);
      assert.equal(refreshedHandle.revision, discovered.revision);
      assert.equal(refreshedHandle.status, discovered.status);
      assert.deepEqual(discovered.goal, objectivePatch.goal);
      assert.deepEqual(discovered.completion, objectivePatch.completion);
      assert.deepEqual(discovered.budget, objectivePatch.budget);
      assert.equal(discovered.status, "active");
      assert.equal(discovered.revision, "2");
      assert.equal(JSON.stringify(read.body).includes(unrelatedMarker), false);
      assert.equal(JSON.stringify(read.body).includes(fixture.canvas), false);
      assert.equal(JSON.stringify(read.body).includes(fixture.project), false);
      const [httpStateRow] = await h.sql`SELECT payload_json->'graph_query' AS state FROM jobs WHERE id=${fixture.hub}`;
      const httpState = (httpStateRow?.state ?? {}) as JsonObject;
      assert.equal(Number(httpState.bytes ?? 0), wireBytes);

      // This is intentionally constructed only from the Job read result. The
      // fixture's management PATCH response is not used as Plan authority.
      const submitted = await h.invoke(
        fixture.hub,
        "submit_plan",
        h.proposal({ ...fixture, objective: discovered }),
      );
      assert.equal(submitted.statusCode, 200, submitted.payload);
      const children = await h.children(fixture.hub);
      assert.equal(children.length, 1, "the first accepted route admits exactly one ready Worker Job");
      assert.equal(children[0]?.payload_json.plan_context.objective_id, discovered.objective_id);
      assert.equal(children[0]?.payload_json.plan_context.objective_revision, discovered.revision);
      const [afterPlan] = await h.sql`
        SELECT count(*)::int AS count
        FROM events e JOIN jobs j ON j.id=e.job_id
        WHERE j.canvas_id=${fixture.canvas} AND e.type='plan'`;
      assert.equal(Number(afterPlan?.count ?? 0), 1);

      // Exercise the same SQL reader's explicit call/byte bounds. A positive
      // response is accepted only when the final serialized result fits; an
      // insufficient positive budget is reported as budget exhaustion.
      const overviewFixture = await h.fixture(executionObjective());
      await addHubOverviewFiller(h, overviewFixture.canvas);
      const shortOverview = await buildGraphSnapshot(overviewFixture.canvas, "hub", { maxYamlChars: 2_000 });
      assert.match(shortOverview.yaml, /projection_mode: "L0_overview"/);
      const budgetFixture = await h.fixture(maximumObjective());
      const { executeGraphQuery: directExecute } = await import("./graph-query.js");
      await assert.rejects(
        () => directExecute({
          jobId: budgetFixture.hub,
          canvasId: budgetFixture.canvas,
          payload: { kind: "plan_objective" },
          maxCalls: 1,
          maxBytes: 1,
        }),
        (error: unknown) => {
          assert.ok(error instanceof PlatformRuntimeHandlerError);
          assert.equal(error.rejection?.errorCode, "graph_query_budget_exceeded");
          return true;
        },
      );
      const [smallBudgetStateRow] = await h.sql`SELECT payload_json->'graph_query' AS state FROM jobs WHERE id=${budgetFixture.hub}`;
      const smallBudgetState = (smallBudgetStateRow?.state ?? {}) as JsonObject;
      assert.equal(Number(smallBudgetState.calls ?? 0), 0);
      assert.equal(Number(smallBudgetState.bytes ?? 0), 0);
      const direct = await directExecute({
        jobId: budgetFixture.hub,
        canvasId: budgetFixture.canvas,
        payload: { kind: "plan_objective" },
        maxCalls: 1,
        maxBytes: GRAPH_QUERY_RESPONSE_LIMIT,
      });
      const directBytes = Buffer.byteLength(JSON.stringify(direct), "utf8");
      assert.equal(direct.truncated, false);
      assert.deepEqual(direct.referable_ids, []);
      assert.equal(direct.budget.calls_left, 0);
      assert.equal(direct.budget.bytes_left, GRAPH_QUERY_RESPONSE_LIMIT - directBytes);
      assert.ok(directBytes <= GRAPH_QUERY_RESPONSE_LIMIT);
      const [directStateRow] = await h.sql`SELECT payload_json->'graph_query' AS state FROM jobs WHERE id=${budgetFixture.hub}`;
      const directState = (directStateRow?.state ?? {}) as JsonObject;
      assert.equal(Number(directState.bytes ?? 0), directBytes);

      await runNegativeBootstrapMatrix(h);
    } finally {
      await h.close();
    }
  },
);

async function runNegativeBootstrapMatrix(h: PlanFixture): Promise<void> {
  const fixture = await h.fixture(executionObjective());
  const other = await h.fixture(executionObjective());
  const ownerGrant = await h.api.mintJobCapabilityToken(fixture.hub);
  const otherGrant = await h.api.mintJobCapabilityToken(other.hub);

  const before = await readCurrentObjective(h, fixture.hub);
  const staleProposal = h.proposal({ ...fixture, objective: before.objective });
  const revisedGoal = "A revised objective must invalidate the previously read route";
  const revised = await h.app.inject({
    method: "PATCH",
    url: `/tasks/${fixture.canvas}`,
    payload: {
      plan_objective: {
        expected_revision: before.objective.revision,
        goal: revisedGoal,
        completion: before.objective.completion,
        budget: before.objective.budget,
      },
    },
  });
  assert.equal(revised.statusCode, 200, revised.payload);
  const staleSubmit = await h.invoke(fixture.hub, "submit_plan", staleProposal);
  assertRejectedGraphQuery(staleSubmit, "plan_stale_revision");
  await assertNoPlanWork(h, fixture);
  const afterCas = await readCurrentObjective(h, fixture.hub);
  assert.equal(afterCas.objective.revision, "2");
  assert.equal(afterCas.objective.objective_id, before.objective.objective_id);
  assert.equal(afterCas.objective.goal, revisedGoal);

  const drift = await h.fixture(executionObjective());
  await h.sql`UPDATE canvases SET title=${"drifted task title"} WHERE id=${drift.canvas}`;
  const driftRead = await h.invoke(drift.hub, "graph_query", { kind: "plan_objective" });
  assertRejectedGraphQuery(driftRead, "plan_stale_revision");
  await assertNoPlanWork(h, drift);

  const invalid = await h.fixture(executionObjective());
  const invalidObjective = {
    ...(await readCurrentObjective(h, invalid.hub)).objective,
    revision: "0",
  };
  await h.sql`UPDATE canvases
    SET target_json = target_json || ${h.sql.json({ plan_objective: invalidObjective } as never)}
    WHERE id=${invalid.canvas}`;
  const invalidRead = await h.invoke(invalid.hub, "graph_query", { kind: "plan_objective" });
  assertRejectedGraphQuery(invalidRead, "invalid_payload");
  await assertNoPlanWork(h, invalid);

  const oversized = await h.fixture(executionObjective());
  const oversizedObjective = {
    ...(await readCurrentObjective(h, oversized.hub)).objective,
    updated_at: `2026-10-31T00:00:00.${"1".repeat(50)}Z`,
  };
  await h.sql`UPDATE canvases
    SET target_json = target_json || ${h.sql.json({ plan_objective: oversizedObjective } as never)}
    WHERE id=${oversized.canvas}`;
  const oversizedRead = await h.invoke(oversized.hub, "graph_query", { kind: "plan_objective" });
  assertRejectedGraphQuery(oversizedRead, "invalid_payload");
  await assertNoPlanWork(h, oversized);

  const selectors: Array<[string, unknown]> = [
    ["id", fixture.root],
    ["project_id", other.project],
    ["canvas_id", other.canvas],
    ["node_type", "root"],
    ["status", "active"],
    ["since", new Date().toISOString()],
    ["cursor", fixture.root],
    ["limit", 1],
    ["ids", [fixture.root]],
    ["direction", "both"],
    ["edge_type", "from"],
    ["verify_status", "pending"],
    ["unconverged_only", true],
    ["finding_id", fixture.root],
  ];
  for (const [field, value] of selectors) {
    const response = await postGraphQuery(h, fixture.hub, ownerGrant.token, { kind: "plan_objective", [field]: value });
    assertRejectedGraphQuery(response);
  }

  const missingToken = await postGraphQuery(h, fixture.hub, undefined, { kind: "plan_objective" });
  const missingBody = assertRejectedGraphQuery(missingToken);
  assert.equal(missingToken.statusCode, 401);
  assert.equal(missingBody.error_code, "CAPABILITY_TOKEN_REQUIRED");

  const nonJobBearer = await postGraphQuery(h, fixture.hub, "not-a-job-capability-token", { kind: "plan_objective" });
  const nonJobBody = assertRejectedGraphQuery(nonJobBearer);
  assert.equal(nonJobBearer.statusCode, 401);
  assert.equal(nonJobBody.error_code, "CAPABILITY_TOKEN_INVALID");

  const otherJobBearer = await postGraphQuery(h, fixture.hub, otherGrant.token, { kind: "plan_objective" });
  const otherJobBody = assertRejectedGraphQuery(otherJobBearer);
  assert.equal(otherJobBearer.statusCode, 401);
  assert.equal(otherJobBody.error_code, "CAPABILITY_TOKEN_INVALID");

  await h.sql`UPDATE job_capability_tokens
    SET issued_at=now()-interval '2 seconds', expires_at=now()-interval '1 second'
    WHERE id=${ownerGrant.id}`;
  const expired = await postGraphQuery(h, fixture.hub, ownerGrant.token, { kind: "plan_objective" });
  const expiredBody = assertRejectedGraphQuery(expired);
  assert.equal(expired.statusCode, 401);
  assert.equal(expiredBody.error_code, "CAPABILITY_TOKEN_EXPIRED");

  const { executeGraphQuery: directExecute } = await import("./graph-query.js");
  await assert.rejects(
    () => directExecute({
      jobId: fixture.hub,
      canvasId: other.canvas,
      payload: { kind: "plan_objective" },
      maxCalls: 0,
      maxBytes: GRAPH_QUERY_RESPONSE_LIMIT,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PlatformRuntimeHandlerError);
      assert.equal(error.rejection?.errorCode, "invalid_payload");
      return true;
    },
  );

  // A matching Canvas id is not sufficient: the Job and Canvas must remain
  // in the same project for the authoritative SQL read.
  await h.sql`UPDATE jobs SET project_id=${other.project} WHERE id=${fixture.hub}`;
  await assert.rejects(
    () => directExecute({
      jobId: fixture.hub,
      canvasId: fixture.canvas,
      payload: { kind: "plan_objective" },
      maxCalls: 0,
      maxBytes: GRAPH_QUERY_RESPONSE_LIMIT,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PlatformRuntimeHandlerError);
      assert.equal(error.rejection?.errorCode, "invalid_payload");
      return true;
    },
  );
}
