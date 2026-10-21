/** Live authorization smoke: real Dispatcher/OpenSandbox/Claude Code/Control API. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startKnowledgeJobModel } from "./project-knowledge-job-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schedulerRequire = createRequire(path.join(root, "apps/scheduler/package.json"));
const reportDir = process.env.KNOWLEDGE_JOB_REPORT_DIR?.trim() || await mkdtemp(path.join(os.tmpdir(), "knowledge-job-report-"));
await mkdir(reportDir, { recursive: true });
const report: Record<string, any> = { schema: "deepsonar.project-knowledge-job-smoke/v1",
  started_at: new Date().toISOString(), status: "running", model: "deterministic-loopback-anthropic",
  requested_coverage: ["real-sandbox-control-api", "cross-project-no-grant", "exact-skill-grant", "foreign-memory-denial", "revocation-after-snapshot", "usage-ledger"],
  does_not_prove: ["maker-trial-evaluator-reviewer-lifecycle", "feedback-enqueue", "vendor-model-reasoning"], jobs: [] };
const save = () => writeFile(path.join(reportDir, "knowledge-job-smoke.json"), JSON.stringify(report, null, 2) + "\n");
let sql: any, admin: any, app: any, runner: any, model: Awaited<ReturnType<typeof startKnowledgeJobModel>> | undefined;
let databaseName: string | undefined, drain: (() => Promise<void>) | undefined;
const jobIds: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const missing = ["TEST_DATABASE_URL", "OPEN_SANDBOX_API_KEY", "PROJECT_KNOWLEDGE_JOB_IMAGE"]
    .filter((key) => !process.env[key]?.trim());
  assert.equal(missing.length, 0, `KNOWLEDGE_JOB_RUNTIME_UNAVAILABLE: missing ${missing.join(", ")}`);
  const imageRef = process.env.PROJECT_KNOWLEDGE_JOB_IMAGE!.trim();
  assert.match(imageRef, /^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/, "image must be immutable");
  const image = JSON.parse(execFileSync("docker", ["image", "inspect", imageRef], { encoding: "utf8" }))[0];
  assert.equal(image.Config.Labels["io.deepsonar.image-key"], "deepsonar-reverse");
  const nativeArch = os.arch() === "x64" ? "amd64" : os.arch() === "arm64" ? "arm64" : os.arch();
  assert.equal(image.Architecture, nativeArch);
  const imageDigest = imageRef.includes("@") ? imageRef.split("@")[1]! : image.Id;
  const manifestBytes = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", imageRef,
    "/opt/deepsonar/tool-manifest.json"]);
  const toolManifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
  report.image = { id: image.Id, architecture: image.Architecture, tool_manifest_sha256: manifestSha };
  const helperImage = process.env.DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE?.trim()
    || "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";
  try { execFileSync("docker", ["image", "inspect", helperImage], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch { execFileSync("docker", ["pull", helperImage], { stdio: "inherit" }); }
  process.env.DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE = helperImage;
  report.shared_assets_helper = helperImage;
  const postgres = (await import(schedulerRequire.resolve("postgres"))).default;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL!); adminUrl.pathname = "/postgres"; adminUrl.search = "";
  admin = postgres(adminUrl.toString(), { max: 1 });
  databaseName = `deepsonar_knowledge_smoke_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const targetUrl = new URL(process.env.TEST_DATABASE_URL!); targetUrl.pathname = `/${databaseName}`; targetUrl.search = "";
  Object.assign(process.env, { DATABASE_URL: targetUrl.toString(), AGENT_MODE: "real", SANDBOX_PROVIDER: "opensandbox",
    OPEN_SANDBOX_DOMAIN: process.env.OPEN_SANDBOX_DOMAIN || "127.0.0.1:18081",
    DEEPSONAR_MASTER_KEY: "00".repeat(32), BLOB_STORE: "fs", BLOB_DIR: path.join(reportDir, "blobs"),
    DEEPSONAR_API_SANDBOX_URL: "http://deepsonar-gateway-proxy:3100/control/v1",
    DEEPSONAR_GATEWAY_PROXY_UPSTREAM_URL: "http://host.docker.internal:3100/gateway" });
  model = await startKnowledgeJobModel();
  const [{ default: Fastify }, database, runtime, dispatcher, platform, gateway, credentials, snapshots, workers,
    { freezeProjectKnowledgeCatalog, projectSkillSelector }, { freezeJobSkillCatalog }, blobs,
    { admitCliCapabilities }, { assertFrozenCliCapabilities }, { DEFAULT_FINDING_PROTOCOL }] = await Promise.all([
    import(schedulerRequire.resolve("fastify")), import("../../apps/scheduler/src/db.js"), import("../../apps/scheduler/src/runtime.js"),
    import("../../apps/scheduler/src/dispatcher.js"), import("../../apps/scheduler/src/domains/platform-api/index.js"),
    import("../../apps/scheduler/src/gateway.js"), import("../../apps/scheduler/src/credentials.js"),
    import(schedulerRequire.resolve("@deepsonar/runtime-sandbox")), import("../../apps/scheduler/src/domains/worker-nodes/index.js"),
    import("../../apps/scheduler/src/domains/project-knowledge/catalog-snapshot.js"), import("../../apps/scheduler/src/job-skill-catalog.js"),
    import("../../apps/scheduler/src/domains/project-knowledge/blobs.js"),
    import("../../apps/scheduler/src/domains/cli-capability/admit.js"),
    import("../../apps/scheduler/src/domains/cli-capability/frozen.js"),
    import("../../apps/scheduler/src/finding-protocol.js"),
  ]);
  sql = database.sql; runner = runtime.runner; drain = () => dispatcher.drainInFlight(60_000);
  await database.migrate();
  const localWorker = await workers.seedLocalWorkerNode();
  assert.ok(localWorker);
  const dispatchable = (await workers.listWorkerNodes()).find((worker) => worker.id === localWorker.id);
  assert.ok(dispatchable && workers.workerIsDispatchable(dispatchable, Date.now(), 60_000, { requireLocal: true }));
  app = Fastify({ logger: false }); platform.registerPlatformControlRoutes(app); gateway.registerGateway(app);
  await app.listen({ port: 3100, host: "0.0.0.0" });
  const owner = randomUUID(), consumer = randomUUID();
  await sql`INSERT INTO projects(id,name,config_json) VALUES(${owner},'Knowledge owner smoke','{}'),(${consumer},'Knowledge consumer smoke','{}')`;
  const credentialId = randomUUID(), secret = `knowledge-local-test-${randomUUID()}`;
  const encrypted = credentials.encryptSecret(secret);
  await sql`INSERT INTO credentials(id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,status,agent_cli,public_metadata_json)
    VALUES(${credentialId},'Disposable model','llm_provider','anthropic',${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},
      ${credentials.fingerprintOf(secret)},${credentials.last4Of(secret)},'active','claude-code',${sql.json({ base_url: model.url })})`;
  const provenanceCanvas = randomUUID(), provenanceJob = randomUUID(), provenanceAttempt = randomUUID();
  await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${provenanceCanvas},${owner},'provenance','{}')`;
  await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
    VALUES(${provenanceJob},${owner},${provenanceCanvas},'analyze','succeeded','{}','{}')`;
  await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${provenanceAttempt},${provenanceJob},1,'succeeded','terminal')`;
  const skillContent = "# Exact granted skill\nUse only current Job scope.\n";
  const skillBody = { kind: "skill", logical_key: "knowledge-smoke", title: "Exact Knowledge Smoke", keywords: ["knowledge-smoke"],
    files: { "SKILL.md": skillContent } };
  const memoryBody = { kind: "memory", logical_key: "private-memory", title: "Private Knowledge Smoke", keywords: ["private"],
    content: "Owner-only memory." };
  const createVersion = async (kind: string, key: string, title: string, body: object) => {
    const blob = await blobs.writeKnowledgeBlob(sql, body); await blobs.registerKnowledgeBlob(sql, blob.hash, blob.bytes);
    const [item] = await sql`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title)
      VALUES(${owner},${kind},${key},${title}) RETURNING id`;
    const [version] = await sql`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${owner},${item.id},1,${blob.hash},${provenanceJob},${provenanceAttempt},'[]',${"a".repeat(64)}) RETURNING id`;
    await sql`UPDATE project_knowledge_items SET status='active',active_version_id=${version.id} WHERE id=${item.id}`;
    return { itemId: String(item.id), versionId: String(version.id), hash: blob.hash };
  };
  const skill = await createVersion("skill", "knowledge-smoke", skillBody.title, skillBody);
  const memory = await createVersion("memory", "private-memory", memoryBody.title, memoryBody);
  const selector = projectSkillSelector({ item_id: skill.itemId, version: 1 } as never);
  const actor = await readFile(path.join(root, "agent-harness/opensandbox/knowledge-job-actor.py"), "utf8");
  const admitted = admitCliCapabilities({ ids: [], imageKey: "deepsonar-reverse" });
  assert.ok(admitted.ok);
  const file = (name: string, content: string) => ({ path: name, content,
    content_sha256: createHash("sha256").update(content).digest("hex") });
  const createJob = async (mode: string) => {
    const id = randomUUID(), canvasId = randomUUID();
    const catalog = await freezeProjectKnowledgeCatalog(sql, consumer), jobSkillCatalog = await freezeJobSkillCatalog(sql, consumer);
    const config = { mode, job_id: id, selector, skill_hash: skill.hash, skill_title: skillBody.title,
      skill_content: skillContent, memory_item_id: memory.itemId, memory_hash: memory.hash, memory_title: memoryBody.title };
    const snapshot = {
      name: "analyze", role_kind: "role", agent_cli: "claude-code",
      agent_runtime: snapshots.freezeAgentCliRuntime(snapshots.AGENT_CLI_RUNTIME_ADAPTERS["claude-code"]),
      credential_id: credentialId, credential_provider: "anthropic", model: "claude-sonnet-4-5", upstream_model: "claude-sonnet-4-5",
      env_vars: {}, env_keys: [], skills: [], commands: [], mcps: [], subagents: [], modules: [], module_selectors: [],
      expanded_modules: [], missing_modules: [], module_content_hash: "", skill_revisions: [],
      config_files: [file("knowledge-job-actor.py", actor), file("knowledge-job-input.json", JSON.stringify(config))],
      settings_config_json: {}, pi_extensions: [], role_description: "Real project knowledge smoke", instructions_markdown: null,
      context_window_tokens: 200000, platform_tools: ["search_skills", "pull_skill", "search_project_knowledge", "read_project_memory",
        "emit_progress", "mark_job_done"], cli_capabilities: admitted.frozen, cli_capability_pack: admitted.pack,
      project_knowledge_catalog: catalog, job_skill_catalog: jobSkillCatalog,
      network_policy: { allow_egress: false }, sandbox_limits: { cpu: 2, memoryMiB: 4096, pidsLimit: 512, capDropAll: true, noNewPrivileges: true },
      runtime_image: { image_key: "deepsonar-reverse", image_ref: imageRef, image_digest: imageDigest,
        runtime_image_id: null, runtime_image_version_id: null, admission_scan_id: null, tools_manifest_sha256: manifestSha,
        manual: toolManifest.manual, contract_version: "deepsonar.runtime.contract/v1" },
    };
    assertFrozenCliCapabilities(snapshot);
    await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${consumer},${`Knowledge ${mode}`},
      ${sql.json({ network_policy: { allow_egress: false }, effective_finding_protocol: DEFAULT_FINDING_PROTOCOL,
        convergence: { hub_paused: true, auto_stopped: false,
        paused_reason: "knowledge_smoke_hub_out_of_scope" } })})`;
    await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json) VALUES(${canvasId},'root','Knowledge smoke','active','{}')`;
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json,timeout_sec)
      VALUES(${id},${consumer},${canvasId},'analyze','pending',${sql.json(snapshot)},
        ${sql.json({ intent: { prompt: `Run the deterministic knowledge smoke actor for ${mode}.` } })},600)`;
    jobIds.push(id); return id;
  };
  const run = async (id: string, mode: string) => {
    assert.equal(await dispatcher.dispatchOnce(), 1, `expected one ${mode} Job`);
    const deadline = Date.now() + 600_000;
    let row: any;
    while (Date.now() < deadline) {
      [row] = await sql`SELECT id,status,error,sandbox_id FROM jobs WHERE id=${id}`;
      if (["succeeded", "failed", "timeout", "cancelled", "orphan"].includes(row.status)) break;
      await sleep(300);
    }
    await drain!();
    const [failure] = await sql`SELECT payload_json FROM events WHERE job_id=${id}
      AND payload_json->>'message' LIKE 'KNOWLEDGE_ACTOR_FAILED%' ORDER BY id DESC LIMIT 1`;
    assert.equal(row?.status, "succeeded", `${mode}: ${failure?.payload_json?.message ?? row?.error ?? "timeout"}`);
    const [marker] = await sql`SELECT payload_json FROM events WHERE job_id=${id}
      AND payload_json->>'message' LIKE ${`KNOWLEDGE_${mode.toUpperCase()}_%`} ORDER BY id DESC LIMIT 1`;
    assert.ok(marker, `${mode}: actor did not emit durable Control API proof`);
    assert.equal((await runner.listResources({ jobId: id })).length, 0, `${mode}: sandbox leak`);
    report.jobs.push({ id, mode, status: row.status, proof: marker.payload_json.message }); await save();
  };
  const noGrant = await createJob("no_grant"); await run(noGrant, "no_grant");
  const [grant] = await sql`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
    VALUES(${owner},${skill.itemId},${skill.versionId},${consumer},'smoke') RETURNING id`;
  const granted = await createJob("granted"); await run(granted, "granted");
  const [usageCount] = await sql`SELECT COUNT(*)::int AS n FROM project_knowledge_usages WHERE job_id=${granted}`;
  assert.equal(usageCount.n, 1, "real pull_skill did not persist usage");
  const revoked = await createJob("revoked");
  await sql`UPDATE project_knowledge_grants SET revoked_at=now() WHERE id=${grant.id}`;
  await run(revoked, "revoked");
  const [deniedUsages] = await sql`SELECT COUNT(*)::int AS n FROM project_knowledge_usages
    WHERE job_id IN (${noGrant},${revoked})`;
  assert.equal(deniedUsages.n, 0, "denied Jobs must not create usage records");
  report.model_requests = model.calls(); assert.ok(report.model_requests >= 6);
  report.proves = report.requested_coverage; report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  if (drain) await drain().catch((error) => (report.cleanup_errors ??= []).push(`drain: ${String(error)}`));
  if (runner) for (const id of jobIds) for (const resource of await runner.listResources({ jobId: id }).catch(() => []))
    await runner.destroy({ sandboxId: resource.resourceId }).catch(() => undefined);
  if (app) await app.close().catch((error: unknown) => (report.cleanup_errors ??= []).push(`app: ${String(error)}`));
  if (model) await model.close().catch((error: unknown) => (report.cleanup_errors ??= []).push(`model: ${String(error)}`));
  if (sql) await sql.end({ timeout: 5 }).catch((error: unknown) => (report.cleanup_errors ??= []).push(`sql: ${String(error)}`));
  if (admin) { if (databaseName) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
    .catch((error: unknown) => (report.cleanup_errors ??= []).push(`database: ${String(error)}`));
    await admin.end({ timeout: 5 }).catch((error: unknown) => (report.cleanup_errors ??= []).push(`admin: ${String(error)}`)); }
  if (report.cleanup_errors?.length) { report.status = "failed"; delete report.proves; process.exitCode = 1; }
  report.finished_at = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, report: path.join(reportDir, "knowledge-job-smoke.json"), error: report.error }));
}
