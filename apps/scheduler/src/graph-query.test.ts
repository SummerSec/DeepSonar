import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ALL_PLATFORM_TOOLS,
  ControlToolInputSchemasJson,
  GRAPH_QUERY_LIMITS,
  GraphQueryPayload,
  requiredPlatformTools,
  resolvePlatformTools,
  toMcpToolInputSchema,
} from "@deepsonar/shared-types";
import { parseHubDecisionPayload } from "./graph.js";
import {
  executeGraphQuery,
  projectEdges,
  projectIntentFrontier,
  projectNodeBody,
  projectNodeIndex,
  seedProjectedNodeIds,
  type CanvasGraph,
  type GraphQueryState,
  type GraphQueryStore,
} from "./graph-query.js";
import { PlatformRuntimeHandlerError } from "./domains/platform-api/registry.js";
import { PLATFORM_OPERATION_IDS } from "./domains/platform-api/operations.js";
import { controlRuntimeRejection } from "./domains/platform-api/repair.js";

const ROOT = "00000000-0000-4000-8000-000000000001";
const FACT = "00000000-0000-4000-8000-000000000002";
const HIDDEN = "00000000-0000-4000-8000-000000000003";
const FINDING_NODE = "00000000-0000-4000-8000-000000000004";
const FINDING_ID = "00000000-0000-4000-8000-000000000014";
const INTENT = "00000000-0000-4000-8000-000000000005";
const JOB = "00000000-0000-4000-8000-0000000000aa";
const CANVAS = "00000000-0000-4000-8000-0000000000bb";

function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function node(input: {
  id: string;
  type: string;
  title?: string;
  status?: string | null;
  body?: Record<string, unknown>;
  verification_status?: string | null;
  created_at?: string;
}) {
  return {
    id: input.id,
    node_type: input.type,
    title: input.title ?? input.type,
    body_json: input.body ?? {},
    status: input.status ?? "open",
    verification_status: input.verification_status ?? null,
    job_id: null,
    created_at: input.created_at ?? "2026-01-01T00:00:00.000Z",
  };
}

function fixtureGraph(): CanvasGraph {
  return {
    canvasId: CANVAS,
    goal: "confirm platform entry",
    target: { kind: "source", title: "android" },
    promptTarget: { kind: "source", title: "android" },
    nodes: [
      node({ id: ROOT, type: "root", title: "root", status: "running" }),
      node({
        id: FACT,
        type: "fact",
        title: "visible fact",
        body: { description: "entry located", api_key: "sk-live-should-not-leak", password: "hunter2" },
        verification_status: "unverified",
      }),
      node({ id: HIDDEN, type: "fact", title: "hidden fact", body: { description: "not in overview" } }),
      node({
        id: FINDING_NODE,
        type: "finding",
        title: "sample finding",
        body: { summary: "authz gap", location: "Foo.java:12" },
      }),
      node({
        id: INTENT,
        type: "intent",
        title: "continue",
        status: "running",
        body: { role: "explore", description: "keep checking" },
      }),
    ],
    edges: [
      { from_node_id: ROOT, to_node_id: INTENT, edge_type: "from" },
      { from_node_id: FACT, to_node_id: FINDING_NODE, edge_type: "supports" },
    ],
    findings: [
      {
        id: FINDING_ID,
        node_id: FINDING_NODE,
        title: "sample finding",
        severity: "high",
        location: "Foo.java:12",
        summary: "authz gap",
        verify_status: "pending",
        imported: false,
      },
    ],
    verificationSummaries: new Map([[FINDING_ID, { verification_attempt: 1, missing_evidence: ["runtime_test"] }]]),
  };
}

function memoryStore(graph: CanvasGraph, initial?: Partial<GraphQueryState>): GraphQueryStore & { snapshot: () => GraphQueryState } {
  let state: GraphQueryState = {
    calls: 0,
    bytes: 0,
    projected_node_ids: [],
    blocked: false,
    trail: [],
    ...initial,
  };
  return {
    async loadCanvas() { return graph; },
    async loadState() {
      return {
        ...state,
        projected_node_ids: [...state.projected_node_ids],
        trail: state.trail.map((entry) => ({ ...entry })),
      };
    },
    async saveState(_jobId, next) {
      state = {
        ...next,
        projected_node_ids: [...next.projected_node_ids],
        trail: next.trail.map((entry) => ({ ...entry })),
      };
    },
    snapshot() { return state; },
  };
}

test("graph_query MCP schema stays a single strict object and rejects canvas_id/project_id", () => {
  const schema = ControlToolInputSchemasJson.graph_query;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(Array.isArray(schema.anyOf), false);
  assert.equal(Array.isArray(schema.oneOf), false);
  assert.doesNotThrow(() => toMcpToolInputSchema(GraphQueryPayload));
  assert.equal(GraphQueryPayload.safeParse({ kind: "overview" }).success, true);
  assert.equal(GraphQueryPayload.safeParse({ kind: "overview", canvas_id: CANVAS }).success, false);
  assert.equal(GraphQueryPayload.safeParse({ kind: "index", project_id: CANVAS }).success, false);
  assert.equal(GraphQueryPayload.safeParse({ kind: "node" }).success, false);
  assert.equal(GraphQueryPayload.safeParse({ kind: "edges", id: ROOT, limit: GRAPH_QUERY_LIMITS.edges }).success, true);
  assert.equal(GraphQueryPayload.safeParse({ kind: "edges", id: ROOT, limit: GRAPH_QUERY_LIMITS.edges + 1 }).success, false);
  assert.equal(GraphQueryPayload.safeParse({ kind: "index", limit: GRAPH_QUERY_LIMITS.index + 1 }).success, false);
  assert.deepEqual(PLATFORM_OPERATION_IDS, ALL_PLATFORM_TOOLS);
  assert.ok(ALL_PLATFORM_TOOLS.includes("graph_query"));
});

test("Hub cannot disable graph_query", () => {
  assert.deepEqual(requiredPlatformTools("hub"), ["mark_job_done", "ack_human_message", "graph_query"]);
  assert.ok(resolvePlatformTools("hub_reason", "hub", { graph_query: false }).includes("graph_query"));
  assert.equal(requiredPlatformTools("role").includes("graph_query"), false);
});

test("T1 overview then index then node returns bounded envelopes", async () => {
  const store = memoryStore(fixtureGraph());
  const live = new Set<string>();
  const overview = await executeGraphQuery({
    jobId: JOB, canvasId: CANVAS, payload: { kind: "overview" }, store, liveProjectedIds: live,
  });
  assert.equal(overview.accepted, true);
  assert.equal(overview.kind, "overview");
  assert.equal(overview.truncated, false);
  assert.deepEqual(overview.referable_ids, [ROOT]);
  assert.equal(overview.budget.calls_left, 39);
  assert.ok(overview.budget.bytes_left < 512_000);

  const index = await executeGraphQuery({
    jobId: JOB, canvasId: CANVAS, payload: { kind: "index", node_type: "fact", limit: 50 }, store, liveProjectedIds: live,
  });
  assert.equal(index.kind, "index");
  assert.ok(index.items.some((item) => (item as { id: string }).id === FACT));
  assert.ok(index.referable_ids.includes(FACT));

  const body = await executeGraphQuery({
    jobId: JOB, canvasId: CANVAS, payload: { kind: "node", ids: [FACT] }, store, liveProjectedIds: live,
  });
  assert.equal(body.kind, "node");
  assert.equal((body.items[0] as { id: string }).id, FACT);
  assert.ok(live.has(ROOT));
  assert.ok(live.has(FACT));
  assert.equal(store.snapshot().calls, 3);
});

test("T3 index truncation reports omitted and next_cursor", () => {
  const nodes = Array.from({ length: 60 }, (_, index) => node({
    id: id(index + 20),
    type: "fact",
    title: "fact-" + index,
    created_at: "2026-01-01T00:00:" + String(index).padStart(2, "0") + ".000Z",
  }));
  const projection = projectNodeIndex(nodes, { limit: 50 });
  assert.equal(projection.items.length, 50);
  assert.equal(projection.truncated, true);
  assert.equal(projection.omitted.nodes, 10);
  assert.equal(projection.next_cursor, nodes[49]!.id);
});

test("T4 per-Job call budget returns graph_query_budget_exceeded", async () => {
  const store = memoryStore(fixtureGraph());
  await executeGraphQuery({
    jobId: JOB, canvasId: CANVAS, payload: { kind: "overview" }, store, maxCalls: 1, maxBytes: 512_000,
  });
  await assert.rejects(
    () => executeGraphQuery({
      jobId: JOB, canvasId: CANVAS, payload: { kind: "overview" }, store, maxCalls: 1, maxBytes: 512_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PlatformRuntimeHandlerError);
      assert.equal(error.rejection?.errorCode, "graph_query_budget_exceeded");
      assert.equal(error.rejection?.retryable, true);
      const details = error.rejection?.details as { remaining?: { calls: number } };
      assert.equal(details.remaining?.calls, 0);
      const body = controlRuntimeRejection({
        operation: "graph_query",
        code: error.rejection!.errorCode,
        message: error.message,
        retryable: true,
        details: error.rejection?.details,
      });
      assert.equal(body.error_code, "graph_query_budget_exceeded");
      assert.equal(body.repair.category, "model_correctable");
      assert.match(body.repair.next_action ?? "", /停止 graph_query/);
      return true;
    },
  );
  assert.equal(store.snapshot().blocked, true);
  assert.equal(store.snapshot().calls, 1);
});

test("T5 Hub from-ref rejects ids that this Job has not projected", () => {
  const projected = new Set([ROOT, FACT]);
  const ok = parseHubDecisionPayload(
    { complete: { from: [ROOT], description: "当前目标已经由引用证据完整覆盖" } },
    projected,
  );
  assert.equal(ok.complete?.from[0], ROOT);
  assert.throws(
    () => parseHubDecisionPayload(
      { complete: { from: [HIDDEN], description: "当前目标已经由引用证据完整覆盖" } },
      projected,
    ),
    (error: unknown) => error instanceof Error && error.message.includes("invalid_node_ref"),
  );
});

test("T6 node projection strips secret-shaped keys", () => {
  const projection = projectNodeBody(
    [node({
      id: FACT,
      type: "fact",
      title: "visible fact",
      body: { description: "entry located", api_key: "sk-live-should-not-leak", token: "secret-token" },
    })],
    [],
    [FACT],
  );
  const encoded = JSON.stringify(projection);
  assert.equal(encoded.includes("sk-live"), false);
  assert.equal(encoded.includes("secret-token"), false);
  assert.equal((projection.items[0] as { summary: string }).summary.includes("entry located"), true);
});

test("T9 all seven kinds carry kind/truncated/omitted/referable_ids/budget", async () => {
  const store = memoryStore(fixtureGraph());
  const payloads = [
    { kind: "overview" },
    { kind: "index", node_type: "fact" },
    { kind: "node", ids: [FACT] },
    { kind: "edges", id: ROOT, direction: "out" },
    { kind: "findings", unconverged_only: true },
    { kind: "evidence", finding_id: FINDING_ID },
    { kind: "intents", status: "running" },
  ] as const;
  for (const payload of payloads) {
    const result = await executeGraphQuery({ jobId: JOB, canvasId: CANVAS, payload, store });
    assert.equal(result.kind, payload.kind);
    assert.equal(typeof result.truncated, "boolean");
    assert.equal(typeof result.omitted, "object");
    assert.ok(Array.isArray(result.items));
    assert.ok(Array.isArray(result.referable_ids));
    assert.ok(Number.isInteger(result.budget.calls_left));
    assert.ok(Number.isInteger(result.budget.bytes_left));
  }
});

test("edges and intents stay bounded", () => {
  const edges = Array.from({ length: 250 }, (_, index) => ({
    from_node_id: ROOT, to_node_id: id(index + 30), edge_type: "from",
  }));
  const edgePage = projectEdges(edges, ROOT, "out", undefined, 200);
  assert.equal(edgePage.items.length, 200);
  assert.equal(edgePage.truncated, true);
  assert.equal(edgePage.omitted.edges, 50);
  const intents = Array.from({ length: 80 }, (_, index) => node({
    id: id(index + 80), type: "intent", status: "pending", body: { role: "explore", description: "more work" },
  }));
  const frontier = projectIntentFrontier(intents, [], { limit: 50 });
  assert.equal(frontier.items.length, 50);
  assert.equal(frontier.truncated, true);
});

test("T10 seedProjectedNodeIds unions YAML ids with later query ids", () => {
  assert.deepEqual(
    seedProjectedNodeIds({ graph_query: { projected_node_ids: [ROOT] } }, [FACT, "not-a-uuid"]),
    [ROOT, FACT],
  );
});

test("phase 1 keeps YAML injection and short-circuits graph_query before unknown operations", () => {
  const executor = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(executor, /await buildGraphSnapshot\(canvasId, graphScope/);
  assert.doesNotMatch(executor, /DEEPSONAR_GRAPH_ON_DEMAND|graph\.onDemand/);
  const queryAt = executor.indexOf('if (operation === "graph_query")');
  const unknownAt = executor.indexOf("unknown platform operation");
  assert.ok(queryAt > 0 && unknownAt > queryAt);
  assert.match(executor, /parseHubDecisionPayload\(payload, graph \? hubProjectedIds/);
  assert.match(executor, /liveProjectedIds: hubProjectedIds/);
  assert.match(executor, /seedGraphQueryProjectedIds\(jobId, graph\.projectedReferableIds\)/);
});
