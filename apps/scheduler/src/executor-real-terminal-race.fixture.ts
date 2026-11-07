import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import type { PlatformRuntimeHandlerContext } from "./domains/platform-api/registry.js";
import type { EventEnvelopeInput } from "@deepsonar/shared-types";
import type { RealAgentResult } from "@deepsonar/runtime-sandbox";

// Only transport/storage boundaries are replaced. executeReal and the registry
// retain their production semantic state, validation and terminal selection.
const runtime = await import("@deepsonar/runtime-sandbox");
const database = await import("./db.js");
const { DEFAULT_FINDING_PROTOCOL } = await import("./finding-protocol.js");
const { config } = await import("./config.js");
export const jobId = randomUUID();
export const attemptId = randomUUID();
const projectId = randomUUID();
const canvasId = randomUUID();
export const rootId = randomUUID();
const operations = ["mark_job_done", "request_human", "submit_hub_decision"];
const snapshot = {
  name: "audit", role_kind: "role", agent_cli: "claude-code",
  model_budget: undefined as import("@deepsonar/shared-types").ModelTokenBudget | undefined,
  agent_runtime: runtime.freezeAgentCliRuntime(runtime.AGENT_CLI_RUNTIME_ADAPTERS["claude-code"]),
  platform_tools: operations, network_policy: { allow_egress: false },
  env_vars: {}, env_keys: [], config_files: [], skills: [], commands: [], mcps: [], subagents: [],
  instructions_markdown: "Offline terminal race verification.",
  runtime_image: { image_key: "default", image_ref: "offline:fixture", image_digest: "sha256:offline" },
};
const job = { id: jobId, project_id: projectId, canvas_id: canvasId, sandbox_id: "offline-sandbox",
  payload_json: {}, agent_snapshot_json: snapshot };
let scenario: () => Promise<void | RealAgentResult>;
let preflight: (type: string) => Promise<void> = async () => {};
let events: EventEnvelopeInput[] = [];
let runnerCalls = 0;
let bundleCalls = 0;
let omitRunnerDispose = false;
let gate: (() => boolean) | undefined;
let recoveryGuard: Parameters<typeof runtime.runRealAgent>[1]["recoveryGuard"];
let runtimeBudget: Parameters<typeof runtime.runRealAgent>[1]["modelBudget"];
let diagnosticRows: Record<string, unknown>[] = [];
const fakeSql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?").replace(/\s+/g, " ").trim();
  if (query.startsWith("SELECT * FROM jobs")) return [job];
  if (query === "SELECT c.target_json FROM jobs j JOIN canvases c ON c.id = j.canvas_id AND c.project_id = j.project_id WHERE j.id = ? AND j.canvas_id = ? AND c.id = ?") {
    assert.deepEqual(values, [jobId, canvasId, canvasId]);
    return [{ target_json: { effective_finding_protocol: DEFAULT_FINDING_PROTOCOL } }];
  }
  if (query.startsWith("SELECT id, attempt_no, snapshot_identity_json FROM job_attempts")) return [{ id: attemptId, attempt_no: 1 }];
  if (query.startsWith("UPDATE jobs SET payload_json") || query.startsWith("UPDATE jobs SET transcript_uri")) return [];
  if (query.startsWith("SELECT j.id FROM jobs j JOIN job_attempts")) { assert.deepEqual(values, [jobId, attemptId]); return [{ id: jobId }]; }
  if (query.includes("AS artifacts")) return [{ artifacts: "0", findings: "0", facts: "0", unattributed_job_artifacts: "0" }];
  if (query.startsWith("SELECT event_id,payload_json FROM events")) return [];
  throw new Error(`Unexpected executor database access: ${query}`);
}, { json: (value: unknown) => value });
mock.module(new URL("./db.js", import.meta.url), { namedExports: { ...database, sql: fakeSql } });
const runtimeModule = await import("./runtime.js");
const host = {};
mock.module(new URL("./runtime.js", import.meta.url), { namedExports: { ...runtimeModule,
  runner: { ensureHost: async () => host },
} });
const core = await import("./core.js");
mock.module(new URL("./core.js", import.meta.url), { namedExports: { ...core,
  rolesForProject: async () => [{ name: "audit", title: "Audit", description: "Offline role" }],
  rulesForProject: async () => ({ minVerifySeverity: "low", maxIntentsPerDecision: 8 }),
  preflightDeferredSemanticEvent: async (_job: string, type: string) => {
    assert.ok(type === "human" || type === "hub_decision");
    await preflight(type);
  },
  ingestEvent: async (_job: string, event: EventEnvelopeInput) => { events.push(event); },
  ingestEventBundle: async (_job: string, bundle: EventEnvelopeInput[]) => { bundleCalls++; events.push(...bundle); },
} });
const graph = await import("./graph.js");
mock.module(new URL("./graph.js", import.meta.url), { namedExports: { ...graph,
  buildGraphSnapshot: async () => ({ scope: "agent", yaml: "root: offline", yamlChars: 13,
    truncated: false, omitted: {}, nodeCounts: {}, projectedReferableIds: [rootId] }),
} });
const images = await import("./runtime-images.js");
mock.module(new URL("./runtime-images.js", import.meta.url), { namedExports: { ...images,
  listHubRuntimeImageCatalog: async () => [],
} });
const graphQuery = await import("./graph-query.js");
mock.module(new URL("./graph-query.js", import.meta.url), { namedExports: { ...graphQuery,
  seedGraphQueryProjectedIds: async () => [],
} });
const context = await import("./domains/context/index.js");
mock.module(new URL("./domains/context/index.js", import.meta.url), { namedExports: { ...context,
  persistJobRuntimeContext: async () => {},
} });
const humanMessages = await import("./domains/canvas/human-messages.js");
mock.module(new URL("./domains/canvas/human-messages.js", import.meta.url), { namedExports: { ...humanMessages,
  registerHumanMessageRuntime: async () => async () => {},
} });
const canvasUpdates = await import("./canvas-updates.js");
mock.module(new URL("./canvas-updates.js", import.meta.url), { namedExports: { ...canvasUpdates,
  subscribeCanvasUpdates: async () => async () => {},
} });
const evidence = await import("./evidence.js");
mock.module(new URL("./evidence.js", import.meta.url), { namedExports: { ...evidence,
  JobEvidenceWriter: class {
    attemptId = attemptId;
    setSession() {}
    async appendNormalized(event: Record<string, unknown>) { diagnosticRows.push(event); return diagnosticRows.length; }
    async finalize() { return { uri: "offline:transcript" }; }
  },
} });
mock.module("@deepsonar/runtime-sandbox", { namedExports: { ...runtime,
  runRealAgent: async (actualHost: unknown, options: Parameters<typeof runtime.runRealAgent>[1]) => {
    assert.equal(actualHost, host);
    runnerCalls++;
    gate = options.completionGate;
    recoveryGuard = options.recoveryGuard; runtimeBudget = options.modelBudget;
    const dispose = await options.onRunReady!({
      sendMessage: async () => {}, writeWorkspaceFile: async () => {},
      readWorkspaceFile: async () => { throw new Error("No workspace reads in terminal race test"); },
    } as Parameters<NonNullable<typeof options.onRunReady>>[0]);
    try { return await scenario() ?? { text: "", files: {} }; } finally {
      if (omitRunnerDispose) assert.ok(listRuntimeHandlers(jobId).length > 0, "handler remains live before executor fallback cleanup");
      else await dispose?.();
    }
  },
} });
const { executeReal } = await import("./executor-real.js");
const { invokeRuntimeHandler, listRuntimeHandlers } = await import("./domains/platform-api/registry.js");

export function completionReady() { return gate?.(); }
export async function piRecoveryAllowed() { assert.ok(recoveryGuard); return recoveryGuard(); }
export function frozenRuntimeBudget() { return runtimeBudget; }
export function setPreflight(callback: (type: string) => Promise<void>) { preflight = callback; }
export function call(operationId: string, input: unknown, options: Partial<PlatformRuntimeHandlerContext> = {}) {
  return invokeRuntimeHandler({ jobId, projectId, canvasId, operationId, input,
    eventId: randomUUID(), tokenId: "offline-token", idempotencyKey: null,
    completionAttemptId: attemptId, ...options });
}
export function terminalEvents() { return events.filter(event => ["human", "done", "hub_decision"].includes(event.type)); }
export function terminalBundleCalls() { return bundleCalls; }
export function completionDiagnosticEvidence() { return diagnosticRows.filter(row => row.type === "run.completion_diagnostic"); }
export async function runExecutor(act: () => Promise<void | RealAgentResult>, roleKind = "role", skipRunnerDispose = false,
  agentCli: "claude-code" | "pi" = "claude-code", modelBudget?: import("@deepsonar/shared-types").ModelTokenBudget) {
  omitRunnerDispose = skipRunnerDispose;
  snapshot.role_kind = roleKind;
  snapshot.agent_cli = agentCli; snapshot.agent_runtime = runtime.freezeAgentCliRuntime(runtime.AGENT_CLI_RUNTIME_ADAPTERS[agentCli]);
  snapshot.model_budget = modelBudget; recoveryGuard = undefined; runtimeBudget = undefined;
  events = []; diagnosticRows = []; runnerCalls = 0; bundleCalls = 0; preflight = async () => {}; gate = undefined; scenario = act;
  const token = "offline-capability";
  try { await executeReal(jobId, "audit", { jobId, token, operationIds: operations, env: {
    DEEPSONAR_JOB_ID: jobId, DEEPSONAR_API_TOKEN: token,
    DEEPSONAR_API_BASE_URL: `${config.platformApi.sandboxUrl.replace(/\/$/, "")}/jobs/${jobId}`,
  } } as Parameters<typeof executeReal>[2]);
  } finally {
    assert.equal(runnerCalls, 1);
    assert.equal(listRuntimeHandlers(jobId).length, 0, "executor unregisters its live handler even when the runner throws");
  }
  return events.filter(event => event.type === "human" || event.type === "done" || event.type === "hub_decision");
}
