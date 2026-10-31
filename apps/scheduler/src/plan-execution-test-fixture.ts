import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { SubmitPlanPayload } from "@deepsonar/shared-types";
import type { PlatformRuntimeHandler } from "./domains/platform-api/index.js";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { contentSha256 } from "./domains/plan-protocol/criterion-model.js";

export const executionObjective = (expected_revision: string | null = null) => ({
  expected_revision,
  goal: "Collect and verify the scoped execution evidence",
  completion: { mode: "all_tasks" as "all_tasks" | "explicit_result", description: "Every planned task must have a retained output", required_outputs: [] },
  budget: { max_tasks: 8, max_rounds: 4, max_no_progress_rounds: 2, max_parallel_tasks: 1 },
});

/** Offline fixture. The only admin statements create/drop this fixture's DB. */
export async function createPlanExecutionFixture() {
  const source = new URL(process.env.TEST_DATABASE_URL!);
  const adminUrl = new URL(source); adminUrl.pathname = "/postgres"; adminUrl.search = "";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `plan_execution_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const databaseUrl = new URL(source); databaseUrl.pathname = `/${databaseName}`; databaseUrl.search = "";
  const blob = await mkdtemp(path.join(os.tmpdir(), "plan-v2-"));
  const jobs: string[] = [];
  let drop = false;
  let closeApp: (() => Promise<unknown>) | undefined;
  let closeSql: (() => Promise<unknown>) | undefined;
  let unregister: ((job: string) => void) | undefined;
  const close = async () => {
    jobs.forEach((job) => unregister?.(job));
    await closeApp?.(); await closeSql?.();
    if (drop) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    assert.ok(path.resolve(blob).startsWith(path.resolve(os.tmpdir(), "plan-v2-")));
    await rm(blob, { recursive: true, force: true });
  };
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`); drop = true;
    process.env.DATABASE_URL = databaseUrl.toString(); process.env.BLOB_DIR = blob;
    process.env.AGENT_MODE = "fake"; process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
    process.env.DEEPSONAR_AUTH_REQUIRED = "false";
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }, core, api, { createAttempt }, { executeGraphQuery }, { ControlInputError }, { createSqlJobLifecycleApplication }] = await Promise.all([
      import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"),
      import("./core.js"), import("./domains/platform-api/index.js"), import("./domains/job-attempt/application.js"),
      import("./graph-query.js"), import("./control-input.js"), import("./domains/job-lifecycle/application.js"),
    ]);
    closeSql = () => sql.end({ timeout: 5 }); unregister = api.unregisterRuntimeHandler;
    await migrate();
    const lifecycle = createSqlJobLifecycleApplication(sql);
    const app: FastifyInstance = Fastify({ logger: false }); await app.register(websocket); registerRoutes(app); await app.ready();
    closeApp = () => app.close();
    const runtimes = new Map<string, { token: string; attempt: string }>();
    const holdPlanCommit = new Set<string>();
    const handlers = new Map<string, PlatformRuntimeHandler>();
    const operations = ["submit_plan", "submit_plan_result", "submit_hub_decision", "graph_query", "emit_fact", "mark_job_done", "request_human"];
    const start = async (job: string) => {
      assert.ok(await lifecycle.claimPendingJob(job), "fixture start must claim a pending Job once");
      assert.ok(await lifecycle.transitionJob(job, "provisioning"), "fixture provisioning must pass lifecycle CAS");
      const attempt = String((await createAttempt(sql, job)).id);
      const grant = await api.mintJobCapabilityToken(job);
      const startedAt = new Date();
      assert.ok(await lifecycle.transitionJob(job, "running", {
        started_at: startedAt, lease_expires_at: new Date(startedAt.getTime() + 10 * 60 * 1000),
      }), "fixture running must pass lifecycle CAS");
      await api.activateProvisionedJobCapabilityTokens(job);
      const handler: PlatformRuntimeHandler = async (context) => {
        if (context.planPhase === "abort") return {};
        if (context.planPhase === "prepare") return { plan_prepared: true };
        if (context.operationId === "mark_job_done" && context.completionPhase !== "commit") {
          return { completion_prepared: context.completionPhase === "prepare" };
        }
        const [meta] = await sql`SELECT canvas_id FROM jobs WHERE id=${job}`;
        if (context.operationId === "graph_query") return executeGraphQuery({ jobId: job, canvasId: String(meta.canvas_id), payload: context.input, maxCalls: 100, maxBytes: 1024 * 1024 });
        const type = ({ submit_plan: "plan", submit_plan_result: "plan_result", submit_hub_decision: "hub_decision", emit_fact: "fact", mark_job_done: "done", request_human: "human" } as Record<string, string>)[context.operationId];
        try {
          if (type === "hub_decision" || type === "human") {
            if (context.planPhase !== "commit") await core.preflightDeferredSemanticEvent(job, type, context.input);
            if (context.planPhase === "validate") return {};
            if (context.planPhase === "commit" && holdPlanCommit.has(job)) throw new Error("Offline fixture lost executor before ingestion");
          }
          await core.ingestEvent(job, { v: 1, event_id: context.eventId, type, payload: context.input } as never);
          return { accepted: true, event_id: context.eventId };
        } catch (error) {
          if (error instanceof ControlInputError) throw new api.PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, {
            statusCode: error.retryable ? 422 : 409, errorCode: error.code, retryable: error.retryable, path: error.path,
          });
          throw error;
        }
      };
      handlers.set(job, handler); api.registerRuntimeHandler(job, handler, operations);
      jobs.push(job); runtimes.set(job, { token: grant.token, attempt });
      return { token: grant.token, attempt };
    };
    const invoke = (job: string, operation: string, payload: unknown, key = randomUUID()): Promise<LightMyRequestResponse> => app.inject({
      method: "POST", url: `/control/v1/jobs/${job}/operations/${operation}`,
      headers: { authorization: `Bearer ${runtimes.get(job)!.token}`, "idempotency-key": key,
        ...(operation === "mark_job_done" ? { "x-deepsonar-proposal-revision": "0" } : {}) }, payload: payload as never,
    });
    const fixture = async (objectivePatch = executionObjective()) => {
      const project = randomUUID(), canvas = randomUUID(), hub = randomUUID(), root = randomUUID();
      await sql`INSERT INTO projects(id,name,config_json) VALUES(${project},'Plan v2 fixture',${sql.json({ rules: { hubEnabled: false, maxIntentsPerDecision: 8 } })})`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvas},${project},'Scoped execution',${sql.json({ network_policy: { allow_egress: false } })})`;
      await sql`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,body_json) VALUES(${root},${canvas},'root','Scoped execution','active','{}')`;
      const patched = await app.inject({ method: "PATCH", url: `/tasks/${canvas}`, payload: { plan_objective: objectivePatch } });
      assert.equal(patched.statusCode, 200, patched.payload);
      const objective = patched.json().plan_objective;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
        VALUES(${hub},${project},${canvas},'hub_reason','pending',${sql.json({ name: "hub_reason", role_kind: "hub", platform_tools: operations, network_policy: { allow_egress: false } })},
          ${sql.json({ graph_query: { projected_node_ids: [root] } })})`;
      await start(hub);
      return { project, canvas, hub, root, objective };
    };
    const task = (id: string, root: string, depends_on: string[] = []): SubmitPlanPayload["plan"]["tasks"][number] => ({
      id, title: `${id} retained output`, role: "explore", description: `Execute bounded ${id} method and retain output`,
      prompt: "Read only the authorized Canvas scope and retain a concrete output for the next task.",
      from: [root], depends_on, inputs: [], expected_outputs: [`${id} output`],
    });
    const proposal = (f: Awaited<ReturnType<typeof fixture>>, tasks: SubmitPlanPayload["plan"]["tasks"] = [task("collect", f.root), task("verify", f.root, ["collect"])], previous?: SubmitPlanPayload["plan"]) => SubmitPlanPayload.parse({
      plan: { v: 2, objective_id: f.objective.objective_id, objective_revision: f.objective.revision,
        route_revision: String(BigInt(previous?.route_revision ?? "0") + 1n), goal: f.objective.goal,
        assumptions: [], tasks, completion: f.objective.completion, budget: f.objective.budget, open_questions: [] },
      revision: { v: 2, kind: "execution_route", plan_job_id: f.hub, objective_id: f.objective.objective_id,
        expected_objective_revision: f.objective.revision, expected_route_revision: previous?.route_revision ?? "0",
        expected_plan_sha256: previous ? contentSha256(previous) : null, rationale: "Execute the bounded current route" },
    });
    const children = (hub: string) => sql`SELECT id,payload_json,agent_snapshot_json,status FROM jobs WHERE parent_job_id=${hub} ORDER BY created_at,id`;
    const emit = async (job: string, options: { outputs?: string[]; revision?: string; retain?: boolean; corrupt?: boolean } = {}) => {
      const runtime = runtimes.get(job) ?? await start(job);
      const [row] = await sql`SELECT payload_json FROM jobs WHERE id=${job}`;
      const context = row.payload_json.plan_context;
      const uri = `attempts/${runtime.attempt}/execution.txt`, bytes = Buffer.from("Offline fixture retained execution evidence");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (options.retain !== false) {
        await mkdir(path.join(blob, "jobs", job, `attempts/${runtime.attempt}`), { recursive: true });
        await writeFile(path.join(blob, "jobs", job, uri), options.corrupt ? Buffer.from("tampered retained bytes") : bytes);
        await writeFile(path.join(blob, "jobs", job, "manifest.json"), JSON.stringify({ job_id: job, finalized_at: new Date().toISOString(), files: [{ path: uri, bytes: bytes.length, sha256 }] }));
      }
      const response = await invoke(job, "emit_fact", { title: "Scoped fake execution output", description: "The offline worker retained bounded execution evidence without using a product model.",
        artifact: { artifact_key: `plan/${job}/output`, evidence: [{ statement: "Retained execution record", uri, sha256 }], extensions: { "plan.output": {
          v: 2, objective_id: context.objective_id, objective_revision: options.revision ?? context.objective_revision,
          task_id: context.task_id, task_sha256: context.task_sha256, expected_outputs: options.outputs ?? row.payload_json.intent.expected_outputs,
        } } } });
      assert.equal(response.statusCode, 200, response.payload);
      const [artifact] = await sql`SELECT id,node_id FROM artifacts WHERE job_id=${job} AND source_operation='emit_fact'`;
      return { id: String(artifact.id), node_id: String(artifact.node_id), uri, attempt: runtime.attempt };
    };
    const finish = async (job: string) => {
      if (!runtimes.has(job)) await start(job);
      const response = await invoke(job, "mark_job_done", { summary: "Offline worker completed its bounded execution" });
      assert.equal(response.statusCode, 200, response.payload);
    };
    const state = async (canvas: string) => (await sql`SELECT target_json FROM canvases WHERE id=${canvas}`)[0].target_json;
    const rebind = (job: string) => api.registerRuntimeHandler(job, handlers.get(job)!, operations);
    return { sql, app, api, core, blob, start, rebind, invoke, fixture, task, proposal, children, emit, finish, state, holdPlanCommit, close };
  } catch (error) { await close(); throw error; }
}
