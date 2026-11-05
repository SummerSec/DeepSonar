/** New-Job acceptance only: Control HTTP -> production ingestion/freeze ->
 * dispatcher/executeReal -> installed Pi + canonical OM -> SQL Gateway -> provider.
 * The bootstrap Hub is a host-side fixture; its handler invokes the production
 * preflight/ingestion functions. It never inserts or patches the tested child.
 * This is not recovery, registry-promotion, or real-vendor reasoning evidence. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OM_HEADERS_MODEL, OM_HEADERS_PROVIDER, OM_HEADERS_SECRET, startOmHeaderModel } from "./om-provider-headers-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireScheduler = createRequire(path.join(root, "apps/scheduler/package.json"));
const reportDir = process.env.OM_PROVIDER_HEADERS_REPORT_DIR?.trim() || await mkdtemp(path.join(os.tmpdir(), "om-provider-headers-"));
await mkdir(reportDir, { recursive: true });
const report: Record<string, any> = { schema: "deepsonar.om-provider-headers/v1", status: "running",
  source_revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  boundary: "new Control API child Job; real Pi/OM and production launch; synthetic provider only",
  exclusions: ["rerun-current", "resume", "registry admission/publication", "vendor reasoning"] };
let sql: any, admin: any, app: any, runner: any;
let databaseName: string | undefined, childId: string | undefined, hubId: string | undefined;
let drain: (() => Promise<void>) | undefined;
let unregister: ((id: string) => void) | undefined;
let cancelChild: ((id: string) => Promise<unknown>) | undefined;
let model: Awaited<ReturnType<typeof startOmHeaderModel>> | undefined;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (const key of ["TEST_DATABASE_URL", "OPEN_SANDBOX_API_KEY", "OM_PROVIDER_HEADERS_IMAGE"]) assert.ok(process.env[key]?.trim(), `missing ${key}`);
  const imageRef = process.env.OM_PROVIDER_HEADERS_IMAGE!.trim();
  assert.match(imageRef, /^sha256:[a-f0-9]{64}$/u, "acceptance consumes the inspected local immutable image id");
  const image = JSON.parse(execFileSync("docker", ["image", "inspect", imageRef], { encoding: "utf8" }))[0];
  assert.equal(image.Id, imageRef);
  assert.equal(image.Config.Labels["io.deepsonar.image-key"], "deepsonar-base");
  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  assert.equal(image.Architecture, arch, "native runtime required");
  const manifestBytes = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", imageRef, "/opt/deepsonar/tool-manifest.json"]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.imageKey, "deepsonar-base"); assert.ok(manifest.manual?.sha256);
  const registry = JSON.parse(await readFile(path.join(root, "deploy/runtime-image-registry.json"), "utf8"));
  const declaredVersion = registry.images.find((entry: any) => entry.image_key === "deepsonar-base")?.versions[0]?.version;
  assert.match(declaredVersion, /^\d+\.\d+\.\d+/u);
  // Verify installed package versions and wrapper bytes without replacing them.
  const packageVersions = JSON.parse(execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", imageRef, "-e",
    "const fs=require('fs');console.log(JSON.stringify({om:JSON.parse(fs.readFileSync('/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory/package.json')).version,wrapper:require('crypto').createHash('sha256').update(fs.readFileSync('/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts')).digest('hex')}))"], { encoding: "utf8" }));
  assert.equal(packageVersions.om, "3.1.4");
  assert.equal(packageVersions.wrapper, createHash("sha256").update(await readFile(path.join(root, "agent-harness/pi-observational-memory-governed.ts"))).digest("hex"));
  const piVersion = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "pi", imageRef, "--version"], { encoding: "utf8" }).trim();
  assert.match(piVersion, /\b1\.4\.0\b/u);
  report.image = { id: imageRef, architecture: arch, catalog_fixture_version: declaredVersion, installed: { ...packageVersions, pi: piVersion } };

  const postgres = (await import(requireScheduler.resolve("postgres"))).default;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL!); adminUrl.pathname = "/postgres"; adminUrl.search = "";
  admin = postgres(adminUrl.toString(), { max: 1 });
  databaseName = `om_headers_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
  Object.assign(process.env, { DATABASE_URL: databaseUrl.toString(), AGENT_MODE: "real", SANDBOX_PROVIDER: "opensandbox",
    OPEN_SANDBOX_DOMAIN: process.env.OPEN_SANDBOX_DOMAIN || "127.0.0.1:18081", DEEPSONAR_MASTER_KEY: "00".repeat(32),
    BLOB_STORE: "fs", BLOB_DIR: path.join(reportDir, "blobs"), DEEPSONAR_AUTH_REQUIRED: "false",
    DEEPSONAR_API_SANDBOX_URL: "http://deepsonar-gateway-proxy:3100/control/v1",
    DEEPSONAR_GATEWAY_PROXY_UPSTREAM_URL: "http://host.docker.internal:3100/gateway",
    DEEPSONAR_JOB_TOKEN_MAX_REQUESTS: "0" });
  model = await startOmHeaderModel();
  const [{ default: Fastify }, db, runtime, dispatcher, api, gateway, credentials, core, attempts, workers, lifecycleModule] = await Promise.all([
    import(requireScheduler.resolve("fastify")), import("../../apps/scheduler/src/db.js"), import("../../apps/scheduler/src/runtime.js"),
    import("../../apps/scheduler/src/dispatcher.js"), import("../../apps/scheduler/src/domains/platform-api/index.js"),
    import("../../apps/scheduler/src/gateway.js"), import("../../apps/scheduler/src/credentials.js"), import("../../apps/scheduler/src/core.js"),
    import("../../apps/scheduler/src/domains/job-attempt/application.js"), import("../../apps/scheduler/src/domains/worker-nodes/index.js"),
    import("../../apps/scheduler/src/domains/job-lifecycle/index.js"),
  ]);
  sql = db.sql; runner = runtime.runner; drain = () => dispatcher.drainInFlight(60_000); unregister = api.unregisterRuntimeHandler;
  await db.migrate(); assert.ok(await workers.seedLocalWorkerNode());
  app = Fastify({ logger: false }); api.registerPlatformControlRoutes(app); gateway.registerGateway(app);
  await app.listen({ host: "0.0.0.0", port: 3100 });
  const projectId = randomUUID(), canvasId = randomUUID(), rootNode = randomUUID(), credentialId = randomUUID();
  await sql`INSERT INTO projects(id,name,config_json) VALUES(${projectId},'OM header acceptance',${sql.json({
    enabled_agent_clis: ["pi"], default_agent_cli: "pi", default_credential_id: credentialId, default_model_ref: OM_HEADERS_MODEL,
    rules: { hubEnabled: false, maxIntentsPerDecision: 1, jobTokenMaxRequests: 0 },
  })})`;
  // Isolated local-catalog fixture: actual inspected bytes, not a claimed scan or
  // registry promotion. The production image resolver and launch still run.
  const [catalog] = await sql`SELECT id FROM runtime_images WHERE image_key='deepsonar-base'`;
  assert.ok(catalog);
  await sql`UPDATE runtime_images SET official=false,source_kind='third_party',enabled=true,visible_project_ids=${[projectId]} WHERE id=${catalog.id}`;
  await sql`INSERT INTO project_runtime_images(project_id,runtime_image_id,enabled) VALUES(${projectId},${catalog.id},true)`;
  await sql`UPDATE runtime_image_versions SET trust_status='disabled' WHERE runtime_image_id=${catalog.id}`;
  await sql`INSERT INTO runtime_image_versions(runtime_image_id,version,image_ref,resolved_ref,digest,platforms_json,trust_status,tools_manifest_sha256,scan_summary_json,promoted_at)
    VALUES(${catalog.id},${`${declaredVersion}-omfixture`},${imageRef},${imageRef},${imageRef},${sql.json([`linux/${arch}`])},'trusted',
      ${createHash('sha256').update(manifestBytes).digest('hex')},${sql.json({ source: "isolated-local-image-fixture", manual: manifest.manual })},now())`;
  const selectedModel = { id: OM_HEADERS_MODEL, name: OM_HEADERS_MODEL, reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { "x-fixture-model": "selected-model" } };
  const settings = { providers: {
    [OM_HEADERS_PROVIDER]: { baseUrl: `${model.url}/v1`, api: "openai-completions", apiKey: "server-owned-placeholder",
      headers: { "x-fixture-provider": "selected-provider", "x-fixture-model": "provider-default" }, models: [selectedModel] },
    unselected: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused-placeholder",
      headers: { "x-fixture-unselected": "must-not-leak" }, models: [{ ...selectedModel, id: "unselected-model", headers: { "x-fixture-model": "wrong-model" } }] },
  } };
  const encrypted = credentials.encryptSecret(OM_HEADERS_SECRET);
  await sql`INSERT INTO credentials(id,name,kind,provider,project_id,status,agent_cli,ciphertext,nonce,auth_tag,fingerprint,last4,settings_config_json,public_metadata_json)
    VALUES(${credentialId},'Offline Pi provider','llm_provider','openai',${projectId},'active','pi',${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},
      ${credentials.fingerprintOf(OM_HEADERS_SECRET)},${credentials.last4Of(OM_HEADERS_SECRET)},${sql.json(settings)},${sql.json({ base_url: `${model.url}/v1` })})`;
  for (const roleName of ["hub_reason", "audit"]) {
    const [role] = await sql`SELECT id FROM agent_roles WHERE name=${roleName}`; assert.ok(role);
    await sql`DELETE FROM role_configs WHERE role_id=${role.id} AND project_id IS NULL`;
    await sql`INSERT INTO role_configs(role_id,agent_cli,model,runtime_image_key,runtime_knobs_json)
      VALUES(${role.id},'pi',${OM_HEADERS_MODEL},'deepsonar-base',${sql.json({ jobTokenMaxRequests: 0, timeoutSec: 600, stallSec: 180 })})`;
  }
  await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'OM header acceptance',
    ${sql.json({ network_policy: { allow_egress: false }, convergence: { hub_paused: true, auto_stopped: false, paused_reason: "bootstrap_fixture" } })})`;
  await sql`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,body_json) VALUES(${rootNode},${canvasId},'root','Offline scope','active','{}')`;
  const parent = await core.createJob({ projectId, canvasId, type: "hub_reason", maxRequests: 0,
    payload: { graph_query: { projected_node_ids: [rootNode] } } });
  assert.ok(parent.job); hubId = String(parent.job.id);
  const lifecycle = lifecycleModule.createSqlJobLifecycleApplication();
  cancelChild = id => lifecycle.cancelJob(id, "offline OM acceptance cleanup");
  assert.ok(await lifecycle.claimPendingJob(hubId)); assert.ok(await lifecycle.transitionJob(hubId, "provisioning"));
  const bootstrapAttempt = await attempts.createAttempt(sql, hubId);
  const { expandWorkspacePayloadFile } = await import("../../apps/scheduler/src/executor-real.js");
  const grant = await api.mintJobCapabilityToken(hubId);
  assert.ok(await lifecycle.transitionJob(hubId, "running", { started_at: new Date(), lease_expires_at: new Date(Date.now() + 600_000) }));
  await api.activateProvisionedJobCapabilityTokens(hubId);
  // Fixture transport wiring only; all proposal validation, snapshot generation
  // and child INSERT occur inside production preflight/ingestEvent.
  api.registerRuntimeHandler(hubId, async context => {
    assert.equal(context.operationId, "submit_hub_decision");
    if (context.planPhase === "resolve") return { resolved_plan_input: await expandWorkspacePayloadFile("submit_hub_decision", context.input, {
      readWorkspaceFile: async () => { throw new Error("bootstrap fixture accepts inline input only; no sandbox filesystem"); },
    }) };
    if (context.planPhase) assert.equal(context.planAttemptId, String(bootstrapAttempt.id));
    if (context.planPhase === "abort") return {};
    if (context.planPhase === "prepare") return { plan_prepared: true };
    if (context.planPhase !== "commit") await core.preflightDeferredSemanticEvent(hubId!, "hub_decision", context.input);
    if (context.planPhase === "validate") return {};
    await core.ingestEvent(hubId!, { v: 1, event_id: context.eventId, type: "hub_decision", payload: context.input } as never);
    return { accepted: true, event_id: context.eventId };
  }, ["submit_hub_decision"]);
  const response = await fetch(`http://127.0.0.1:3100/control/v1/jobs/${hubId}/operations/submit_hub_decision`, {
    method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ intents: [{ role: "audit", from: [rootNode], agent_cli: "pi", provider: "openai", model_ref: OM_HEADERS_MODEL,
      runtime_image_key: "deepsonar-base", pi_extension_ids: ["pi-observational-memory"],
      description: "Exercise real Pi and observational memory with the offline provider header fixture.",
      prompt: "Run the deterministic offline provider-header acceptance. Follow the provider's tool calls to read synthetic source data, let observational memory settle, and mark the Job done through the real Control API." }] }),
  });
  const accepted = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(accepted)); assert.equal(accepted.accepted, true);
  const children = await sql`SELECT * FROM jobs WHERE parent_job_id=${hubId}`;
  assert.equal(children.length, 1, "only production Control ingestion creates the tested child");
  const child = children[0]; childId = String(child.id); const snapshot = child.agent_snapshot_json;
  assert.equal(child.status, "pending"); assert.equal(snapshot.agent_cli, "pi"); assert.equal(snapshot.pi_provider, OM_HEADERS_PROVIDER);
  assert.equal(snapshot.upstream_model, OM_HEADERS_MODEL); assert.ok(snapshot.gateway_provider_binding);
  assert.ok(snapshot.runtime_knobs); assert.equal(snapshot.runtime_knobs.job_token_max_requests, 0);
  const om = snapshot.pi_extensions.find((extension: any) => extension.id === "pi-observational-memory")?.observational_memory;
  assert.ok(om); assert.equal(om.source_provider, OM_HEADERS_PROVIDER); assert.equal(om.source_model, OM_HEADERS_MODEL);
  assert.equal(om.observeAfterTokens, 10000, "no test-only threshold or plugin override");
  assert.ok(snapshot.agent_runtime_launch); assert.equal(snapshot.runtime_image.image_ref, imageRef);
  const snapshotSha = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  report.creation = { operation: "submit_hub_decision", child_job: childId, snapshot_sha256: snapshotSha,
    pi_provider: snapshot.pi_provider, model: snapshot.upstream_model, om_source_provider: om.source_provider,
    om_source_model: om.source_model, launch_sha256: createHash("sha256").update(JSON.stringify(snapshot.agent_runtime_launch)).digest("hex") };
  await sql.begin((tx: any) => core.finalizeJob(tx, hubId!, "succeeded", { summary: "Bootstrap proposal accepted" }));
  api.unregisterRuntimeHandler(hubId);
  assert.equal(await dispatcher.dispatchOnce(), 1);
  const deadline = Date.now() + 600_000;
  let final: any;
  while (Date.now() < deadline) {
    [final] = await sql`SELECT status,sandbox_id,error,agent_snapshot_json FROM jobs WHERE id=${childId}`;
    if (["succeeded", "failed", "cancelled", "orphan"].includes(final.status)) break;
    if (final.status === "pending") await dispatcher.dispatchOnce();
    if (model.observed()) {
      const actualOm = model.calls.filter(call => call.stage !== "main");
      const [settled] = await sql`SELECT count(*)::int AS requests,COALESCE(sum(l.total_tokens),0)::bigint AS tokens
        FROM job_usage_ledger l JOIN job_attempt_effects e ON e.attempt_id=l.attempt_id AND e.effect_id=l.effect_id
        WHERE l.job_id=${childId} AND l.workload='observational_memory' AND l.settlement_status='settled' AND e.status='settled'`;
      if (Number(settled.requests) === actualOm.length && actualOm.length >= 2
        && Number(settled.tokens) === actualOm.reduce((sum, call) => sum + call.totalTokens, 0)) model.allowCompletion();
    }
    await wait(500);
  }
  assert.equal(final?.status, "succeeded", "real dispatched Pi Job must complete; inspect isolated report status for failed stage");
  await drain();
  assert.equal(createHash("sha256").update(JSON.stringify(final.agent_snapshot_json)).digest("hex"), snapshotSha, "no execution-time snapshot backfill");
  assert.deepEqual(model.errors, []); assert.ok(model.observed());
  const omCalls = model.calls.filter(call => call.stage !== "main"); assert.ok(omCalls.length >= 2);
  const ledger = await sql`SELECT l.*,e.status AS effect_status,t.workload AS token_workload,a.attempt_no,a.status AS attempt_status
    FROM job_usage_ledger l JOIN job_attempt_effects e ON e.attempt_id=l.attempt_id AND e.effect_id=l.effect_id
    JOIN job_tokens t ON t.id=l.job_token_id JOIN job_attempts a ON a.id=l.attempt_id
    WHERE l.job_id=${childId} AND l.workload='observational_memory' ORDER BY l.created_at`;
  assert.equal(ledger.length, omCalls.length);
  assert.ok(ledger.every((entry: any) => entry.settlement_status === "settled" && entry.effect_status === "settled"
    && entry.token_workload === "observational_memory" && entry.attempt_status === "succeeded"));
  assert.equal(ledger.reduce((sum: number, row: any) => sum + Number(row.total_tokens), 0), omCalls.reduce((sum, call) => sum + call.totalTokens, 0));
  const [tokens] = await sql`SELECT count(DISTINCT workload)::int AS scopes FROM job_tokens WHERE job_id=${childId}`;
  assert.equal(tokens.scopes, 2, "executor minted distinct main and OM credentials");
  report.status = "passed"; report.calls = model.calls;
  report.om_ledger = ledger.map((row: any) => ({ attempt_no: row.attempt_no, workload: row.workload,
    settlement_status: row.settlement_status, input_tokens: row.input_tokens, output_tokens: row.output_tokens, total_tokens: row.total_tokens }));
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? { name: error.name, message: error.message.replace(/http:\/\/[^\s]+/gu, "[loopback]") } : { name: "HarnessError" };
  process.exitCode = 1;
} finally {
  if (hubId) unregister?.(hubId);
  if (sql && childId && report.status !== "passed") {
    const [row] = await sql`SELECT status,sandbox_id FROM jobs WHERE id=${childId}`.catch(() => []);
    report.child_status = row?.status ?? null;
    await cancelChild?.(childId).catch(() => {});
    if (row?.sandbox_id) await runner?.destroy({ sandboxId: row.sandbox_id }).catch(() => {});
  }
  await drain?.().catch(() => {});
  await app?.close().catch(() => {}); await model?.close().catch(() => {});
  await sql?.end({ timeout: 5 }).catch(() => {});
  if (databaseName) await admin?.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  await admin?.end().catch(() => {});
  if (model) report.calls = model.calls;
  await writeFile(path.join(reportDir, "om-provider-headers.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: path.join(reportDir, "om-provider-headers.json") }));
}
