import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Plan, normalizeTaskContract, deriveTaskGoalCriteria } from "@deepsonar/shared-types";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test("task review to Plan completion requires isolated PostgreSQL", { skip: "TEST_DATABASE_URL unset; refusing default database" }, () => {});
} else {
  test("explicit operator mappings connect independent goal reviews to governed Plan completion", async (t) => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const name = `task_plan_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`;
    const blob = await mkdtemp(path.join(os.tmpdir(), "task-plan-review-"));
    let created = false; let close: (() => Promise<unknown>) | undefined; let end: (() => Promise<unknown>) | undefined;
    const registered: string[] = [];
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
      process.env.DATABASE_URL = dbUrl.toString(); process.env.BLOB_DIR = blob; process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "true"; process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      const [{ sql, migrate }, core, api, { executeGraphQuery }, { ControlInputError }, { createAttempt }, { taskContractDigest }, decision] = await Promise.all([
        import("./db.js"), import("./core.js"), import("./domains/platform-api/index.js"), import("./graph-query.js"),
        import("./control-input.js"), import("./domains/job-attempt/index.js"), import("./task-outcome-snapshot.js"), import("./domains/plan-protocol/decision.js"),
      ]);
      end = () => sql.end({ timeout: 5 }); await migrate();
      const [{ default: Fastify }, { default: websocket }, { registerRoutes }, { generateToken }] = await Promise.all([
        import("fastify"), import("@fastify/websocket"), import("./routes.js"), import("./auth.js"),
      ]);
      const app = Fastify({ logger: false }); close = () => app.close(); await app.register(websocket); registerRoutes(app); await app.ready();
      const operator = generateToken(), reader = generateToken();
      await sql`INSERT INTO api_tokens(name,token_prefix,token_hash,scopes) VALUES
        ('mapping operator',${operator.prefix},${operator.hash},${["tasks:read", "tasks:write", "jobs:read", "jobs:control"]}),
        ('read-only observer',${reader.prefix},${reader.hash},${["tasks:read", "jobs:read"]})`;
      const headers = { authorization: `Bearer ${operator.plaintext}` };
      const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
        objective: "Deliver a scoped parser investigation", targets: ["fixture-parser"], scope: ["Local parser fixture"],
        evidence: ["Retained test matrix output"], acceptance: ["Specified crash is absent in the executed matrix"], required_actions: ["read"], allowed_actions: ["read"] });
      const contractSha = taskContractDigest(contract), ids = deriveTaskGoalCriteria(contract).map((item) => item.id);
      const operations = ["emit_fact", "mark_job_done", "submit_plan", "graph_query", "submit_hub_decision", "request_human"];
      const snapshot = { name: "audit", role_kind: "role", task_contract: contract, platform_tools: operations, network_policy: { allow_egress: false } };
      type Runtime = { id: string; project: string; canvas: string; attempt: string; token: string; hold: boolean; commits: number; rejectedCommits: string[]; fileInput?: unknown };
      const runtime = async (id: string, project: string, canvas: string): Promise<Runtime> => {
        await sql`UPDATE jobs SET status='provisioning' WHERE id=${id}`;
        const attempt = String((await createAttempt(sql, id)).id), grant = await api.mintJobCapabilityToken(id);
        await sql`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '10 minutes' WHERE id=${id}`;
        await api.activateProvisionedJobCapabilityTokens(id);
        const run: Runtime = { id, project, canvas, attempt, token: grant.token, hold: false, commits: 0, rejectedCommits: [] };
        const handler: import("./domains/platform-api/index.js").PlatformRuntimeHandler = async (context) => {
          if (context.planPhase === "resolve") return { resolved_plan_input: run.fileInput };
          if (context.planPhase === "abort") return {};
          if (context.planPhase === "prepare") return { plan_prepared: true };
          if (context.operationId === "mark_job_done" && context.completionPhase !== "commit") return { completion_prepared: context.completionPhase === "prepare" };
          if (context.operationId === "graph_query") return executeGraphQuery({ jobId: id, canvasId: canvas, payload: context.input, maxCalls: 100, maxBytes: 1024 * 1024 });
          const type = ({ emit_fact: "fact", mark_job_done: "done", submit_plan: "plan", submit_hub_decision: "hub_decision", request_human: "human" } as Record<string, string>)[context.operationId];
          try {
            if (type === "hub_decision" || type === "human") {
              if (context.planPhase !== "commit") await core.preflightDeferredSemanticEvent(id, type, context.input);
              if (context.planPhase === "validate") return {};
              if (context.planPhase === "commit" && run.hold) throw new Error("Fixture executor unavailable after durable acceptance");
            }
            await core.ingestEvent(id, { v: 1, event_id: context.eventId, type, payload: context.input } as never);
            if (context.planPhase === "commit") run.commits++;
            return { accepted: true, event_id: context.eventId };
          } catch (error) {
            if (error instanceof ControlInputError) {
              if (context.planPhase === "commit") run.rejectedCommits.push(error.code);
              throw new api.PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, { statusCode: error.retryable ? 422 : 409, errorCode: error.code, retryable: error.retryable, path: error.path });
            }
            throw error;
          }
        };
        api.registerRuntimeHandler(id, handler, operations); registered.push(id); return run;
      };
      const invoke = (run: Runtime, operation: string, input: unknown, key = randomUUID()) => app.inject({ method: "POST",
        url: `/control/v1/jobs/${run.id}/operations/${operation}`, headers: { authorization: `Bearer ${run.token}`, "idempotency-key": key,
          ...(operation === "mark_job_done" ? { "x-deepsonar-proposal-revision": "0" } : {}) }, payload: input as never });
      const emit = async (run: Runtime, artifact: object) => {
        const key = randomUUID(), response = await invoke(run, "emit_fact", { title: "Scoped parser observation", description: "This isolated parser observation records the declared method and retained execution output.", artifact }, key);
        assert.equal(response.statusCode, 200, response.payload);
        const [row] = await sql`SELECT id,node_id FROM artifacts WHERE job_id=${run.id} AND source_event_id=${key}`;
        return { artifact: String(row.id), fact: String(row.node_id) };
      };
      const proof = async (run: Runtime) => {
        const relative = `attempts/${run.attempt}/result.txt`, bytes = Buffer.from("Executed isolated parser matrix: specified crash absent.\n");
        const sha256 = createHash("sha256").update(bytes).digest("hex"), root = path.join(blob, "jobs", run.id), file = path.join(root, relative);
        await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
        await writeFile(path.join(root, "manifest.json"), JSON.stringify({ job_id: run.id, finalized_at: new Date().toISOString(), files: [{ path: relative, bytes: bytes.length, sha256 }] }));
        return { ...await emit(run, { evidence: [{ kind: "runtime.result", statement: "Retained parser matrix output", uri: `jobs/${run.id}/${relative}`, sha256 }] }), file, bytes };
      };
      const done = async (run: Runtime) => {
        const response = await invoke(run, "mark_job_done", { summary: "Completed this isolated execution and retained its evidence" });
        assert.equal(response.statusCode, 200, response.payload);
        assert.equal((await sql`SELECT status FROM jobs WHERE id=${run.id}`)[0].status, "succeeded");
      };
      const seed = async (project: string, canvas: string, hub = false) => {
        const id = randomUUID(); await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
          VALUES(${id},${project},${canvas},${hub ? "hub_reason" : "audit"},'pending',${sql.json(hub ? { ...snapshot, name: "hub_reason", role_kind: "hub" } : snapshot)},'{}'::jsonb)`;
        await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${canvas},${id},'intent','Isolated execution','pending')`;
        return runtime(id, project, canvas);
      };
      const plan = Plan.parse({ v: 1, goal: "Deliver a scoped parser investigation", tasks: [{ id: "review", title: "Review retained output", role: "audit",
        description: "Scoped parser review", prompt: "Review the scoped parser execution and retain evidence.", expected_outputs: ["Parser matrix record"] }],
        completion: { mode: "explicit_result", description: "Scoped parser criterion evaluated", required_outputs: ["Parser matrix record"] } });
      const fixture = async (kind: "delivery" | "negative_result" = "delivery") => {
        const project = randomUUID(), canvas = randomUUID();
        await sql`INSERT INTO projects(id,name,config_json) VALUES(${project},'Task Plan mapping fixture',${sql.json({ rules: { hubEnabled: false }, enabled_credential_ids: [] })})`;
        await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvas},${project},'Scoped parser investigation',${sql.json({ task_contract: contract, network_policy: { allow_egress: false } } as never)})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvas},'root','Scoped parser investigation','active')`;
        const maker = await seed(project, canvas), raw = await proof(maker);
        const result = await emit(maker, { task_result: { schema_version: 1, kind, task_contract_sha256: contractSha, target: "fixture-parser", criterion_ids: ids,
          method: "Execute the isolated matrix", observed: "Specified crash not observed in executed matrix", limitations: [], evidence_refs: [raw.fact] } }); await done(maker);
        const request = { schema_version: 1, fact_id: result.fact, candidate_artifact_id: result.artifact, task_contract_sha256: contractSha, criterion_ids: ids };
        const review = async (assessment: "satisfied" | "contradicted" = "satisfied") => {
          const response = await app.inject({ method: "POST", url: "/jobs", headers, payload: { project_id: project, type: "audit",
            payload: { goal_review: request, prompt: "Independently execute the scoped parser matrix and evaluate the entire criteria." } } });
          assert.equal(response.statusCode, 201, response.payload);
          const run = await runtime(String(response.json().id), project, canvas), evidence = await proof(run);
          const [row] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${run.id}`;
          const evaluation = await emit(run, { goal_review: { schema_version: 1, assignment_sha256: row.agent_snapshot_json.task_goal_review.assignment_sha256,
            criteria: ids.map((criterion_id) => ({ criterion_id, scope: "entire_criterion", assessment, expected: "Entire scoped criterion is met",
              actual: "Isolated matrix execution retained", rationale: "Retained evidence supports the scoped assessment", limitations: [], evidence_refs: [evidence.fact] })) } });
          await done(run); return { run, evidence, evaluation };
        };
        const evaluated = await review(), owner = await seed(project, canvas, true);
        const submitted = await invoke(owner, "submit_plan", { plan }); assert.equal(submitted.statusCode, 200, submitted.payload);
        const detail = async () => {
          const response = await app.inject({ method: "GET", url: `/canvases/${canvas}/facts/${evaluated.evidence.fact}`, headers });
          assert.equal(response.statusCode, 200, response.payload); return response.json();
        };
        const mapping = async () => {
          const option = (await detail()).goal_review_options.options.find((item: { review_artifact_id: string }) => item.review_artifact_id === evaluated.evaluation.artifact);
          assert.ok(option); const { status, reasons, ...reference } = option; assert.equal(status, "available", JSON.stringify(reasons)); return reference;
        };
        const bind = async (criterion: string, reference: unknown = undefined, token = operator.plaintext) => {
          const source = await detail();
          return app.inject({ method: "PATCH", url: `/canvases/${canvas}/facts/${evaluated.evidence.fact}/verification`, headers: { authorization: `Bearer ${token}` },
            payload: { status: "verified", note: "Operator explicitly maps this reviewed execution to the entire selected Plan criterion", plan_binding: {
              plan_job_id: owner.id, plan_sha256: (await import("./domains/plan-protocol/criterion-model.js")).contentSha256(plan), criterion_id: criterion,
              expected_source_sha256: source.plan_criterion_source.source_sha256, expected_binding_id: null,
              assessment: "satisfies", observation: kind === "negative_result" ? "negative" : "positive", ...(reference === undefined ? {} : { goal_review: reference }),
            } } });
        };
        const read = async () => {
          const response = await invoke(owner, "graph_query", { kind: "plan_gap", ids: [evaluated.evidence.fact] });
          assert.equal(response.statusCode, 200, response.payload); return response.json().items[0];
        };
        const completeInput = (gap: any) => ({ complete: { from: [evaluated.evidence.fact], description: "All required Plan criteria have current explicit operator authorization" }, plan_basis: {
          v: 1, plan_job_id: owner.id, plan_sha256: gap.plan_sha256, criterion_id: "completion", expected_revision: gap.revision,
          expected_task_input_sha256: gap.task_input_sha256, expected_projection_sha256: gap.projection_sha256,
          source_refs: gap.source_refs.map((item: any) => ({ fact_id: item.fact_id, source_sha256: item.source_sha256 })),
          outcome: "complete", rationale: "Explicit operator mappings cover all necessary current Plan criteria",
        } });
        const bindAll = async (withMapping = true) => {
          for (const criterion of ["completion", "output-0"]) {
            const response = await bind(criterion, withMapping ? await mapping() : undefined); assert.equal(response.statusCode, 200, response.payload);
          }
        };
        return { project, canvas, maker, raw, result, reviewed: evaluated, owner, review, detail, mapping, bind, bindAll, read, completeInput };
      };
      for (const kind of ["delivery", "negative_result"] as const) await t.test(`${kind}: review alone is insufficient; explicit mapping then fresh read completes exactly once`, async () => {
        const f = await fixture(kind);
        const unproven = await invoke(f.owner, "submit_hub_decision", f.completeInput(await f.read()));
        assert.equal(unproven.statusCode, 422, unproven.payload); assert.equal(unproven.json().error_code, "plan_completion_unproven");
        const unauthorized = await f.bind("completion", await f.mapping(), reader.plaintext); assert.equal(unauthorized.statusCode, 403);
        const first = await f.bind("completion", await f.mapping()); assert.equal(first.statusCode, 200, first.payload);
        const partial = await invoke(f.owner, "submit_hub_decision", f.completeInput(await f.read())); assert.equal(partial.statusCode, 422, partial.payload);
        const second = await f.bind("output-0", await f.mapping()); assert.equal(second.statusCode, 200, second.payload);
        assert.equal((await f.detail()).goal_review_options.options[0].status, "available", "operator annotation must not invalidate execution identity");
        const gap = await f.read(); assert.ok(gap.criteria.every((item: any) => item.state === "satisfied"));
        const input = f.completeInput(gap), key = randomUUID(); f.owner.fileInput = input;
        const request = kind === "negative_result" ? { payload_file: "complete.json" } : input;
        const response = await invoke(f.owner, "submit_hub_decision", request, key); assert.equal(response.statusCode, 200, response.payload);
        assert.equal(response.json().receipt_status, "persisted_deferred"); assert.equal(f.owner.commits, 1);
        assert.equal((await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.owner.id} AND type='hub_decision'`)[0].count, 1);
        assert.deepEqual(await decision.planCompletionBlockers(sql, f.canvas), []);
        api.clearPlatformApiIdempotencyCache();
        const replay = await invoke(f.owner, "submit_hub_decision", request, key); assert.deepEqual(replay.json(), response.json()); assert.equal(f.owner.commits, 1);
      });
      await t.test("existing operator-only Plan binding remains supported without a goal-review mapping", async () => {
        const f = await fixture(); await f.bindAll(false);
        const response = await invoke(f.owner, "submit_hub_decision", f.completeInput(await f.read()));
        assert.equal(response.statusCode, 200, response.payload); assert.equal(f.owner.commits, 1);
      });
      await t.test("wrong review identity, scope and criterion cannot write an operator binding", async () => {
        const f = await fixture(), other = await fixture(), mapping = await f.mapping();
        for (const invalid of [{ ...mapping, expected_review_sha256: `sha256:${"0".repeat(64)}` },
          { ...mapping, criterion_ids: ["acceptance:99"] }, { ...mapping, review_artifact_id: other.reviewed.evaluation.artifact }]) {
          const response = await f.bind("completion", invalid); assert.equal(response.statusCode, 409, response.payload);
        }
        await sql`UPDATE jobs SET agent_snapshot_json=jsonb_set(agent_snapshot_json,'{task_contract,objective}','"Different frozen owner objective"'::jsonb) WHERE id=${f.owner.id}`;
        const wrongContract = await f.bind("completion", mapping);
        assert.equal(wrongContract.statusCode, 409, wrongContract.payload);
        assert.equal(wrongContract.json().error_code, "PLAN_BINDING_GOAL_REVIEW_CONTRACT_MISMATCH");
        assert.equal((await f.detail()).fact.verification_status, "unverified");
        assert.equal((await f.detail()).plan_bindings.records.length, 0);
      });
      await t.test("conflicting independent evaluations cannot be mapped as satisfied", async () => {
        const f = await fixture(), mapping = await f.mapping(); await f.review("contradicted");
        const response = await f.bind("completion", mapping); assert.equal(response.statusCode, 409, response.payload);
        assert.equal((await f.detail()).goal_review_options.options[0].status, "blocked");
      });
      await t.test("unknown effects and evidence read limits invalidate previously accepted mappings", async () => {
        const f = await fixture(); await f.bindAll();
        await sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status)
          VALUES(${f.reviewed.run.attempt},${f.reviewed.run.id},'unknown-fixture','execution','unknown')`;
        const unknown = await invoke(f.owner, "submit_hub_decision", f.completeInput(await f.read()));
        assert.equal(unknown.statusCode, 409, unknown.payload); assert.equal(unknown.json().error_code, "plan_unknown_effect");
        await sql`UPDATE job_attempt_effects SET status='settled' WHERE job_id=${f.reviewed.run.id}`;
        await writeFile(f.reviewed.evidence.file, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
        const bounded = await f.read(); assert.ok(bounded.criteria.every((item: any) => item.state !== "satisfied"));
        const completion = await invoke(f.owner, "submit_hub_decision", f.completeInput(bounded)); assert.notEqual(completion.statusCode, 200);
        assert.equal(f.owner.commits, 0);
      });
      await t.test("legacy proof-binding digest cannot become Plan authority through an existing mapping", async () => {
        const f = await fixture(); await f.bindAll();
        const [artifact] = await sql`SELECT extensions_json FROM artifacts WHERE id=${f.reviewed.evaluation.artifact}`;
        const { submission_sha256: _previous, ...body } = artifact.extensions_json.task_goal_review;
        body.evidence_bindings = body.evidence_bindings.map((binding: Record<string, unknown>) => {
          const { content_schema_version: _version, ...old } = binding;
          return { ...old, content_sha256: `sha256:${"a".repeat(64)}` };
        });
        const { goalReviewDigest } = await import("./task-goal-review-source.js");
        await sql`UPDATE artifacts SET extensions_json=jsonb_set(extensions_json,'{task_goal_review}',${sql.json({ ...body, submission_sha256: goalReviewDigest(body) })}) WHERE id=${f.reviewed.evaluation.artifact}`;
        assert.equal((await f.detail()).goal_review_options.options[0].status, "blocked");
        const gap = await f.read(); assert.ok(gap.criteria.every((item: any) => item.state !== "satisfied"));
        const response = await invoke(f.owner, "submit_hub_decision", f.completeInput(gap)); assert.notEqual(response.statusCode, 200);
        assert.equal(f.owner.commits, 0);
      });
      await t.test("source mutation after durable acceptance blocks settlement while preserving the original receipt", async () => {
        const f = await fixture(); await f.bindAll(); const input = f.completeInput(await f.read()), key = randomUUID();
        f.owner.hold = true;
        const accepted = await invoke(f.owner, "submit_hub_decision", input, key); assert.equal(accepted.statusCode, 200, accepted.payload);
        assert.equal(accepted.json().receipt_status, "persisted_deferred"); assert.equal(f.owner.commits, 0);
        await writeFile(f.raw.file, "changed maker source bytes"); f.owner.hold = false; api.clearPlatformApiIdempotencyCache();
        const replay = await invoke(f.owner, "submit_hub_decision", input, key); assert.deepEqual(replay.json(), accepted.json());
        assert.equal(f.owner.commits, 0); assert.ok(f.owner.rejectedCommits.length > 0);
        assert.equal((await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.owner.id} AND type='hub_decision'`)[0].count, 0);
        api.unregisterRuntimeHandler(f.owner.id);
        const receipt = await app.inject({ method: "GET", url: `/control/v1/jobs/${f.owner.id}/operations/submit_hub_decision?receipt_key=${key}`, headers: { authorization: `Bearer ${f.owner.token}` } });
        assert.equal(receipt.statusCode, 200, receipt.payload); assert.deepEqual(receipt.json(), accepted.json());
        assert.equal(f.owner.commits, 0);
      });
      for (const jobId of registered) api.unregisterRuntimeHandler(jobId);
    } finally {
      if (close) await close().catch(() => undefined); if (end) await end().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }); await rm(blob, { recursive: true, force: true });
    }
  });
}
