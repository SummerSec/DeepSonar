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
import { PI_EXTENSION_REGISTRY } from "../../packages/shared-types/src/pi-extensions.js";
import { createOmFailureDiagnostics, observeOmRuntime } from "./om-provider-headers-diagnostics.js";
import { OM_HEADERS_MODEL, OM_HEADERS_PROVIDER, OM_HEADERS_SECRET, startOmHeaderModel, type OmHeaderCall } from "./om-provider-headers-model.js";

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
let diagnostics: Awaited<ReturnType<typeof createOmFailureDiagnostics>> | undefined;
let runtimeObservation: ReturnType<typeof observeOmRuntime> | undefined;
let unsubscribeRuntime: (() => void) | undefined;
const runtimeEventCounts: Record<string, number> = {};
let model: Awaited<ReturnType<typeof startOmHeaderModel>> | undefined;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  report.stage = "image-and-installed-runtime";
  for (const key of ["TEST_DATABASE_URL", "OPEN_SANDBOX_API_KEY", "OM_PROVIDER_HEADERS_IMAGE", "OM_PROVIDER_HEADERS_EXPECTED_CONFIG_ID"]) assert.ok(process.env[key]?.trim(), `missing ${key}`);
  const imageRef = process.env.OM_PROVIDER_HEADERS_IMAGE!.trim();
  assert.match(imageRef, /^127\.0\.0\.1:15000\/om-provider-base@sha256:[a-f0-9]{64}$/u,
    "acceptance requires the isolated loopback repository and its actual manifest digest");
  const imageDigest = imageRef.slice(imageRef.indexOf("@") + 1);
  const expectedConfigId = process.env.OM_PROVIDER_HEADERS_EXPECTED_CONFIG_ID!.trim();
  assert.match(expectedConfigId, /^sha256:[a-f0-9]{64}$/u, "original locally built config identity is required");
  const image = JSON.parse(execFileSync("docker", ["image", "inspect", imageRef], { encoding: "utf8" }))[0];
  assert.equal(image.Id, expectedConfigId, "pulled manifest must resolve to the originally built base config");
  assert.ok(Array.isArray(image.RepoDigests) && image.RepoDigests.includes(imageRef),
    "Docker must retain the exact pulled loopback repository manifest identity");
  assert.equal(image.Config.Labels["io.deepsonar.image-key"], "deepsonar-base", "base Docker image-key label");
  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  assert.equal(image.Architecture, arch, "native runtime required");
  const manifestBytes = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", imageRef, "/opt/deepsonar/tool-manifest.json"]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.image_key, "deepsonar-base", "base tool manifest image_key contract");
  assert.ok(manifest.manual?.version && manifest.manual?.sha256 && manifest.manual?.count > 0,
    "materialized runtime manual must expose version, sha256 and a positive count");
  // This image was built from the tested checkout, not the last released catalog.
  // Give only the isolated fixture row the current OM contract version; installed
  // bytes are checked below and production preflight/launch remain mandatory.
  const declaredVersion = PI_EXTENSION_REGISTRY["pi-observational-memory"].min_runtime_image_version!;
  assert.match(declaredVersion, /^\d+\.\d+\.\d+$/u, "OM contract must declare an exact minimum image version");
  // Verify installed package versions and wrapper bytes without replacing them.
  const packageVersions = JSON.parse(execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", imageRef, "-e",
    "const fs=require('fs');console.log(JSON.stringify({om:JSON.parse(fs.readFileSync('/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory/package.json')).version,wrapper:require('crypto').createHash('sha256').update(fs.readFileSync('/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts')).digest('hex')}))"], { encoding: "utf8" }));
  assert.equal(packageVersions.om, "3.1.4", "installed canonical OM version");
  assert.equal(packageVersions.wrapper, createHash("sha256").update(await readFile(path.join(root, "agent-harness/pi-observational-memory-governed.ts"))).digest("hex"),
    "installed production wrapper must match this checkout");
  const piVersion = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "pi", imageRef, "--version"], { encoding: "utf8" }).trim();
  assert.match(piVersion, /\b1\.5\.2\b/u, "installed Pi CLI version");
  report.image = { ref: imageRef, manifest_digest: imageDigest, config_id: image.Id, architecture: arch,
    catalog_fixture_version: declaredVersion, catalog_fixture_version_source: "current-om-contract-not-release-metadata",
    installed: { ...packageVersions, pi: piVersion } };

  report.stage = "isolated-database";
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
  const projectId = randomUUID(), credentialId = randomUUID();
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
    VALUES(${catalog.id},${`${declaredVersion}-omfixture`},${imageRef},${imageRef},${imageDigest},${sql.json([`linux/${arch}`])},'trusted',
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
  report.stage = "credential-catalog-discovery";
  const { discoverModelCatalog, testCredential } = await import("../../apps/scheduler/src/credential-test.js");
  const { listHubProviderCatalog } = await import("../../apps/scheduler/src/domains/project-agent-allowlist/catalog.js");
  const beforeDiscovery = await listHubProviderCatalog(sql, projectId);
  assert.equal(beforeDiscovery.find(entry => entry.credential_id === credentialId)?.models.length, 0,
    "settings models do not substitute for the Hub's discovered model catalog");
  const [catalogCredential] = await sql`SELECT * FROM credentials WHERE id=${credentialId}`;
  const discovered = await discoverModelCatalog(catalogCredential);
  assert.equal(discovered.available, true, "production catalog discovery must reach the isolated provider");
  assert.deepEqual(discovered.models, [OM_HEADERS_MODEL]); assert.ok(discovered.fetched_at);
  assert.equal(model.catalogCalls.length, 1, "one real selected-provider catalog request must succeed");
  // Credential setup is a fixture, but its catalog is the actual production
  // discovery result. Never enable passthrough or substitute settings models.
  // The tested child is still created only by the Control API below.
  report.stage = "credential-inference-probe";
  const health = await testCredential(catalogCredential);
  assert.equal(health.ok, true, "formal readiness requires the actual inference probe");
  assert.equal(health.probe_path, "inference"); assert.equal(model.probeCalls.length, 1);
  report.readiness = { ok: health.ok, probe_path: health.probe_path, requests: model.probeCalls };
  await sql`UPDATE credentials SET model_catalog_json=${sql.json(discovered.models)},
    model_catalog_fetched_at=${discovered.fetched_at},last_tested_at=${health.fetched_at},health_status='ok'
    WHERE id=${credentialId}`;
  const availableProviders = await listHubProviderCatalog(sql, projectId);
  assert.ok(availableProviders.find(entry => entry.credential_id === credentialId)?.models.some(entry => entry.model_id === OM_HEADERS_MODEL),
    "formal Hub catalog must authorize the discovered model before any Job is created");
  report.catalog = { available: discovered.available, models: discovered.models, requests: model.catalogCalls };
  for (const roleName of ["hub_reason", "audit"]) {
    const [role] = await sql`SELECT id FROM agent_roles WHERE name=${roleName}`; assert.ok(role);
    await sql`DELETE FROM role_configs WHERE role_id=${role.id} AND project_id IS NULL`;
    await sql`INSERT INTO role_configs(role_id,agent_cli,model,runtime_image_key,runtime_knobs_json)
      VALUES(${role.id},'pi',${OM_HEADERS_MODEL},'deepsonar-base',${sql.json({ jobTokenMaxRequests: 0, timeoutSec: 600, stallSec: 180 })})`;
  }
  report.stage = "formal-canvas-create";
  const canvasId = await core.ensureCanvasForTask({ projectId, title: "OM header acceptance",
    target: { network_policy: { allow_egress: false }, convergence: { hub_paused: true, auto_stopped: false, paused_reason: "bootstrap_fixture" } } });
  const [canvas] = await sql`SELECT target_json FROM canvases WHERE id=${canvasId} AND project_id=${projectId}`;
  assert.ok(canvas.target_json.effective_finding_protocol, "formal Canvas creation freezes its required finding protocol");
  const roots = await sql`SELECT id FROM canvas_nodes WHERE canvas_id=${canvasId} AND node_type='root'`;
  assert.equal(roots.length, 1); const rootNode = String(roots[0].id);
  report.stage = "bootstrap-hub-create";
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
  report.bootstrap_phases = [];
  api.registerRuntimeHandler(hubId, async context => {
    let step = "operation-and-attempt-binding";
    const phase = context.planPhase ?? "unphased";
    report.bootstrap_phases.push({ phase, status: "entered" });
    try {
      assert.equal(context.operationId, "submit_hub_decision");
      if (context.planPhase === "resolve") {
        step = "resolve-inline-payload";
        return { resolved_plan_input: await expandWorkspacePayloadFile("submit_hub_decision", context.input, {
          readWorkspaceFile: async () => { throw new Error("bootstrap fixture accepts inline input only; no sandbox filesystem"); },
        }) };
      }
      if (context.planPhase) assert.equal(context.planAttemptId, String(bootstrapAttempt.id));
      if (context.planPhase === "abort") return {};
      if (context.planPhase === "prepare") return { plan_prepared: true };
      if (context.planPhase !== "commit") {
        step = "production-preflight";
        await core.preflightDeferredSemanticEvent(hubId!, "hub_decision", context.input);
      }
      if (context.planPhase === "validate") return {};
      step = "production-ingest";
      await core.ingestEvent(hubId!, { v: 1, event_id: context.eventId, type: "hub_decision", payload: context.input } as never);
      return { accepted: true, event_id: context.eventId };
    } catch (error) {
      // The production registry intentionally replaces arbitrary handler errors
      // with HANDLER_FAILED. Preserve only bounded class/code/path metadata in
      // this isolated fixture, never raw payloads, SQL, credentials or messages.
      const row = error as { name?: unknown; code?: unknown; path?: unknown };
      const symbol = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,160}$/u.test(value) ? value : null;
      const diagnostic = { phase, step, status: "failed", name: symbol(row?.name), code: symbol(row?.code), path: symbol(row?.path) };
      report.bootstrap_phases.push(diagnostic);
      console.error(JSON.stringify({ bootstrap_handler_failure: diagnostic }));
      throw error;
    }
  }, ["submit_hub_decision"]);
  report.stage = "control-api-child-create";
  const creationEventId = randomUUID();
  report.creation_request = { event_id: creationEventId, idempotency_key: creationEventId };
  const inspectCreationOutcome = async () => {
    const events = await sql`SELECT event_id,type FROM events WHERE job_id=${hubId} AND event_id=${creationEventId}`;
    const receipts = await sql`SELECT event_id FROM event_dedup WHERE job_id=${hubId} AND event_id=${creationEventId}`;
    const children = await sql`SELECT id,status FROM jobs WHERE parent_job_id=${hubId}`;
    report.creation_outcome = { events, receipts, children };
    if (children.length === 1) childId = String(children[0].id);
  };
  const response = await fetch(`http://127.0.0.1:3100/control/v1/jobs/${hubId}/operations/submit_hub_decision`, {
    method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json", "idempotency-key": creationEventId, "x-deepsonar-event-id": creationEventId },
    body: JSON.stringify({ intents: [{ role: "audit", from: [rootNode], agent_cli: "pi", provider: "openai", model_ref: OM_HEADERS_MODEL,
      runtime_image_key: "deepsonar-base", pi_extension_ids: ["pi-observational-memory"],
      description: "Exercise real Pi and observational memory with the offline provider header fixture.",
      prompt: "Run the deterministic offline provider-header acceptance. Follow the provider's tool calls to read synthetic source data, let observational memory settle, and mark the Job done through the real Control API." }] }),
  }).catch(async error => { await inspectCreationOutcome(); throw error; });
  // Never retry an uncertain mutation, particularly with a new key. Query the
  // original event/dedup and children before diagnosing either transport or HTTP failure.
  await inspectCreationOutcome();
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
  assert.equal(om.request_budget, undefined, "explicit unlimited request policy has no finite OM allocation");
  assert.deepEqual(snapshot.runtime_profile.native_options.pi?.observational_memory, om);
  assert.deepEqual(snapshot.agent_runtime_launch.native_options.observational_memory, om);
  assert.equal(snapshot.agent_runtime_launch.profile_fingerprint, snapshot.runtime_profile.profile_fingerprint);
  assert.ok(snapshot.agent_runtime_launch); assert.equal(snapshot.runtime_image.image_ref, imageRef);
  assert.equal(snapshot.runtime_image.image_digest, imageDigest);
  const snapshotSha = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  report.creation = { operation: "submit_hub_decision", child_job: childId, snapshot_sha256: snapshotSha,
    pi_provider: snapshot.pi_provider, model: snapshot.upstream_model, om_source_provider: om.source_provider,
    om_source_model: om.source_model, launch_sha256: createHash("sha256").update(JSON.stringify(snapshot.agent_runtime_launch)).digest("hex") };
  await sql.begin((tx: any) => core.finalizeJob(tx, hubId!, "succeeded", { summary: "Bootstrap proposal accepted" }));
  api.unregisterRuntimeHandler(hubId);
  diagnostics = await createOmFailureDiagnostics(root);
  runtimeObservation = observeOmRuntime(runner, diagnostics.summarize);
  const { subscribeStream } = await import("../../apps/scheduler/src/stream-bus.js");
  const allowedRuntimeTypes = new Set(["run.started", "run.completed", "run.settled", "run.agent_end", "run.retrying", "run.retry_skipped",
    "tool.call.started", "tool.call.completed", "text.delta", "reasoning.delta"]);
  unsubscribeRuntime = subscribeStream(childId, item => {
    const type = allowedRuntimeTypes.has(item.type) ? item.type : "other";
    runtimeEventCounts[type] = (runtimeEventCounts[type] ?? 0) + 1;
  });
  report.stage = "real-dispatch-and-om";
  assert.equal(await dispatcher.dispatchOnce(), 1);
  const readOmLedger = async () => sql`SELECT l.*,e.status AS effect_status,e.job_id AS effect_job_id,
      e.attempt_id AS effect_attempt_id,e.resource_identity_json->>'job_token_id' AS effect_token_id,
      e.resource_identity_json->>'request_no' AS effect_request_no,e.intent_json->>'workload' AS effect_workload,
      t.id AS scope_token_id,t.job_id AS token_job_id,t.workload AS token_workload,
      a.id AS scope_attempt_id,a.job_id AS attempt_job_id,a.attempt_no,a.status AS attempt_status
    FROM job_usage_ledger l JOIN job_attempt_effects e ON e.attempt_id=l.attempt_id AND e.effect_id=l.effect_id
    JOIN job_tokens t ON t.id=l.job_token_id JOIN job_attempts a ON a.id=l.attempt_id
    WHERE l.job_id=${childId} AND l.workload='observational_memory' ORDER BY l.request_no`;
  const assertOmLedger = (rows: any[], calls: OmHeaderCall[], terminal: boolean) => {
    assert.equal(rows.length, calls.length);
    assert.equal(new Set(rows.map(row => row.job_token_id)).size, 1, "one issued OM token owns this new-Job request sequence");
    assert.equal(new Set(rows.map(row => row.attempt_id)).size, 1, "one real Attempt owns the executed OM sequence");
    const key = (input: number, output: number, total: number) => `${input}:${output}:${total}`;
    const actualResponses = new Map(calls.map(call => [key(call.inputTokens, call.outputTokens, call.totalTokens), call]));
    assert.equal(actualResponses.size, calls.length, "fixture response usage tuples must uniquely identify exchanges");
    for (const [index, row] of rows.entries()) {
      assert.equal(Number(row.request_no), index + 1, "OM token request numbers are contiguous, without hidden admissions");
      for (const field of ["job_id", "effect_job_id", "token_job_id", "attempt_job_id"]) assert.equal(row[field], childId, field);
      assert.equal(row.attempt_id, row.effect_attempt_id); assert.equal(row.attempt_id, row.scope_attempt_id);
      assert.equal(row.job_token_id, row.effect_token_id); assert.equal(row.job_token_id, row.scope_token_id);
      assert.equal(Number(row.effect_request_no), Number(row.request_no));
      assert.equal(row.effect_id, `gateway_model_request:${row.job_token_id}:${row.request_no}`);
      assert.equal(row.workload, "observational_memory"); assert.equal(row.token_workload, "observational_memory");
      assert.equal(row.effect_workload, "observational_memory"); assert.equal(row.model, OM_HEADERS_MODEL);
      assert.equal(row.provider, "openai"); assert.equal(row.settlement_status, "settled"); assert.equal(row.effect_status, "settled");
      if (terminal) assert.equal(row.attempt_status, "succeeded");
      const tuple = key(Number(row.input_tokens), Number(row.output_tokens), Number(row.total_tokens));
      const response = actualResponses.get(tuple);
      assert.ok(response, "each ledger row must match one actual provider response's complete usage tuple");
      assert.equal(Number(row.input_tokens), response.inputTokens);
      assert.equal(Number(row.output_tokens), response.outputTokens);
      assert.equal(Number(row.total_tokens), response.totalTokens);
      actualResponses.delete(tuple);
    }
    assert.equal(actualResponses.size, 0, "every actual OM response has exactly one attributed ledger row");
  };
  const deadline = Date.now() + 600_000;
  const { reapOnce } = await import("../../apps/scheduler/src/reaper.js");
  let recoveryCursor: string | null = null;
  let final: any;
  while (Date.now() < deadline) {
    [final] = await sql`SELECT status,sandbox_id,error,agent_snapshot_json FROM jobs WHERE id=${childId}`;
    if (["succeeded", "failed", "cancelled", "orphan"].includes(final.status)) break;
    if (final.status === "pending") await dispatcher.dispatchOnce();
    if (model.completionEvidence().status === "pending") {
      // This isolated harness does not start Scheduler timers. Use its real
      // lifecycle pump to refresh recovery evidence after natural settlement;
      // the fixture never reconciles effects or writes recovery state itself.
      recoveryCursor = (await reapOnce(recoveryCursor)).recoveryCursor;
    }
    if (model.observed()) {
      const settled = await readOmLedger();
      const actualOm = model.calls.filter(call => call.stage !== "main");
      if (settled.length === actualOm.length && actualOm.length >= 2
        && settled.every((row: any) => row.settlement_status === "settled" && row.effect_status === "settled")) {
        assertOmLedger(settled, actualOm, false);
        model.allowCompletion();
      }
    }
    await wait(500);
  }
  assert.equal(final?.status, "succeeded", "real dispatched Pi Job must complete; inspect isolated report status for failed stage");
  await drain();
  assert.equal(createHash("sha256").update(JSON.stringify(final.agent_snapshot_json)).digest("hex"), snapshotSha, "no execution-time snapshot backfill");
  assert.deepEqual(model.errors, []); assert.ok(model.observed());
  assert.deepEqual(model.credentialProjectionEvidence(), { main: true, observer: true },
    "real env/auth-file tool output must reach main and OM only as redacted context");
  report.credential_projection = model.credentialProjectionEvidence();
  // After repair, Gateway may correctly reject a further model request once
  // completion is accepted. The final provider turn is not the authority here.
  const completionReceipts = await sql`SELECT payload_json->>'status' AS status,
    payload_json->'result'->'body'->>'accepted' AS accepted,
    payload_json->'result'->'body'->>'receipt_status' AS receipt_status
    FROM events WHERE job_id=${childId} AND type='control_receipt'
      AND payload_json->>'operation'='mark_job_done'
      AND payload_json->>'status'='persisted_deferred'`;
  assert.equal(completionReceipts.length, 1, "real Job requires exactly one durably accepted completion");
  assert.equal(completionReceipts[0].accepted, "true");
  assert.equal(completionReceipts[0].receipt_status, "persisted_deferred");
  report.completion = { durable_receipt_verified: true, receipt_status: "persisted_deferred" };
  const omCalls = model.calls.filter(call => call.stage !== "main"); assert.ok(omCalls.length >= 2);
  const ledger = await readOmLedger();
  assertOmLedger(ledger, omCalls, true);
  assert.equal(model.recallEvidence().current_session_read_verified, true);
  report.observation_readback = model.recallEvidence();
  const [tokens] = await sql`SELECT count(DISTINCT workload)::int AS scopes FROM job_tokens WHERE job_id=${childId}`;
  assert.equal(tokens.scopes, 2, "executor minted distinct main and OM credentials");
  report.status = "passed"; report.calls = model.calls;
  report.om_ledger = ledger.map((row: any) => ({ request_no: Number(row.request_no), attempt_no: row.attempt_no, job_id: row.job_id,
    effect_job_id: row.effect_job_id, token_job_id: row.token_job_id, attempt_job_id: row.attempt_job_id,
    attempt_id: row.attempt_id, effect_id: row.effect_id, job_token_id: row.job_token_id, workload: row.workload,
    settlement_status: row.settlement_status, input_tokens: row.input_tokens, output_tokens: row.output_tokens, total_tokens: row.total_tokens }));
} catch (error) {
  report.status = "failed";
  report.error = { name: "HarnessError", code: "OM_HARNESS_FAILED" };
  try {
    diagnostics ??= await createOmFailureDiagnostics(root);
    const allowedNames = new Set(["Error", "AssertionError", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"]);
    report.error = { name: error instanceof Error && allowedNames.has(error.name) ? error.name : "HarnessError",
      code: "OM_HARNESS_FAILED", summary: diagnostics.summarize(error) };
  } catch {
    report.error = { name: "HarnessError", code: "OM_HARNESS_FAILED", diagnostic_code: "OM_ERROR_SUMMARY_FAILED" };
  }
  console.error(JSON.stringify({ status: report.status, stage: report.stage, error: report.error }));
  process.exitCode = 1;
} finally {
  if (hubId) unregister?.(hubId);
  if (sql && childId && report.status !== "passed") {
    // Read the original execution before cancellation/destruction changes any
    // state. Never requeue, replace its request key, or repair its snapshot.
    try {
      diagnostics ??= await createOmFailureDiagnostics(root);
      report.execution_diagnostics = { ...await diagnostics.read(sql, childId), runtime_method_trace: runtimeObservation?.trace ?? [], runtime_event_counts: runtimeEventCounts,
        cli_start_evidence: runtimeEventCounts["run.started"] ? "observed" : "not_observed_not_proof_of_absence" };
      console.error(JSON.stringify({ stage: report.stage, execution_diagnostics: report.execution_diagnostics }));
    } catch {
      report.execution_diagnostics = { read_failed: true, code: "OM_EXECUTION_DIAGNOSTIC_READ_FAILED" };
    }
    const [row] = await sql`SELECT status,sandbox_id FROM jobs WHERE id=${childId}`.catch(() => []);
    report.child_status = row?.status ?? null;
    await cancelChild?.(childId).catch(() => {});
    if (row?.sandbox_id) await runner?.destroy({ sandboxId: row.sandbox_id }).catch(() => {});
  }
  runtimeObservation?.close();
  unsubscribeRuntime?.();
  await drain?.().catch(() => {});
  await app?.close().catch(() => {}); await model?.close().catch(() => {});
  await sql?.end({ timeout: 5 }).catch(() => {});
  if (databaseName) await admin?.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  await admin?.end().catch(() => {});
  if (model) {
    report.calls = model.calls;
    report.completion = { ...report.completion, tool_result: model.completionEvidence() };
  }
  await writeFile(path.join(reportDir, "om-provider-headers.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: path.join(reportDir, "om-provider-headers.json") }));
}
