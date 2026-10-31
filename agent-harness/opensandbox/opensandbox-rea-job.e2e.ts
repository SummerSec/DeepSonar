/**
 * Required live #718 acceptance. Production dispatchOnce -> OpenSandbox ->
 * executeReal -> installed Claude Code -> real REA/Ghidra -> Control API ->
 * immutable shared asset -> normalized Fact/Artifact -> independent Verify.
 * Only model planning is a deterministic loopback Anthropic responder.
 * Missing services are a failure, never a skipped/fixture-only success.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startReaJobModel } from "./rea-job-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schedulerRequire = createRequire(path.join(root, "apps/scheduler/package.json"));
const reportDir = process.env.REA_JOB_REPORT_DIR?.trim() || await mkdtemp(path.join(os.tmpdir(), "rea-job-report-"));
await mkdir(reportDir, { recursive: true });
const report: Record<string, any> = {
  schema: "deepsonar.rea-job-acceptance/v1", source_revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), started_at: new Date().toISOString(), status: "running",
  model: "deterministic-loopback-anthropic", runtime: "production-dispatcher-opensandbox",
  requested_coverage: ["real-tool-output", "job-control-api", "durable-archive", "fact-artifact", "independent-verify-gate", "job-cancel-timeout-cleanup"],
  does_not_prove: ["vendor-model-reasoning", "production-project-enablement", "registry-admission-or-publication", "docker-host-bridge-ip-deny-under-dns-egress", "hub-wake-after-verify"], jobs: [],
};
const saveReport = () => writeFile(path.join(reportDir, "job-acceptance.json"), JSON.stringify(report, null, 2) + "\n");
let sql: any;
let admin: any;
let app: any;
let runner: any;
let model: Awaited<ReturnType<typeof startReaJobModel>> | undefined;
let databaseName: string | undefined;
let drainJobs: (() => Promise<void>) | undefined;
let cancelJob: ((id: string) => Promise<unknown>) | undefined;
const jobIds: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const missing = ["TEST_DATABASE_URL", "OPEN_SANDBOX_API_KEY", "REA_JOB_IMAGE"].filter((key) => !process.env[key]?.trim());
  assert.equal(missing.length, 0, `REA_JOB_RUNTIME_UNAVAILABLE: required environment missing: ${missing.join(", ")}`);
  const imageRef = process.env.REA_JOB_IMAGE!.trim();
  assert.match(imageRef, /^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/, "REA_JOB_IMAGE must be immutable");
  const image = JSON.parse(execFileSync("docker", ["image", "inspect", imageRef], { encoding: "utf8" }))[0];
  assert.equal(image.Config.Labels["io.deepsonar.image-key"], "deepsonar-reverse");
  const nativeArch = os.arch() === "arm64" ? "arm64" : os.arch() === "x64" ? "amd64" : os.arch();
  assert.equal(image.Architecture, nativeArch, "live Job must use native execution, not emulation");
  const imageDigest = imageRef.includes("@") ? imageRef.split("@")[1]! : image.Id;
  const manifestBytes = execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", imageRef, "/opt/deepsonar/tool-manifest.json"]);
  const toolManifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(toolManifest.imageKey, "deepsonar-reverse");
  assert.equal(toolManifest.contract, "deepsonar.runtime.contract/v1");
  assert.ok(toolManifest.manual?.version && toolManifest.manual?.sha256 && toolManifest.manual?.count > 0, "official runtime must have frozen manual metadata");
  const toolManifestSha = createHash("sha256").update(manifestBytes).digest("hex");
  report.tool_manifest = { sha256: toolManifestSha, manual: toolManifest.manual };
  report.image = { requested: imageRef, inspected_id: image.Id, architecture: image.Architecture, identity_kind: imageRef.includes("@") ? "published-manifest" : "local-config-id" };

  // Independent Verify materializes shared-assets via DockerSharedAssetsVolumeManager,
  // which inspects the helper with --pull=never. Provision the same pin deploy/CI use.
  const helperImage = (process.env.DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE?.trim()
    || "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23");
  try {
    execFileSync("docker", ["image", "inspect", helperImage], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    execFileSync("docker", ["pull", helperImage], { encoding: "utf8", stdio: "inherit" });
  }
  execFileSync("docker", ["image", "inspect", helperImage], { encoding: "utf8" });
  process.env.DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE = helperImage;
  report.shared_assets_helper = { image: helperImage };

  const postgres = (await import(schedulerRequire.resolve("postgres"))).default;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL!);
  adminUrl.pathname = "/postgres"; adminUrl.search = "";
  admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `deepsonar_rea_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  databaseName = name;
  const targetUrl = new URL(process.env.TEST_DATABASE_URL!);
  targetUrl.pathname = `/${name}`; targetUrl.search = "";
  Object.assign(process.env, {
    DATABASE_URL: targetUrl.toString(), AGENT_MODE: "real", SANDBOX_PROVIDER: "opensandbox",
    OPEN_SANDBOX_DOMAIN: process.env.OPEN_SANDBOX_DOMAIN || "127.0.0.1:18081",
    DEEPSONAR_MASTER_KEY: "00".repeat(32), BLOB_STORE: "fs", BLOB_DIR: path.join(reportDir, "blobs"),
    DEEPSONAR_API_SANDBOX_URL: "http://deepsonar-gateway-proxy:3100/control/v1",
    DEEPSONAR_GATEWAY_PROXY_UPSTREAM_URL: "http://host.docker.internal:3100/gateway",
  });
  model = await startReaJobModel();
  const [{ default: Fastify }, database, runtime, dispatcher, platform, gateway, credentials, snapshotHelpers,
    { DEFAULT_FINDING_PROTOCOL }, assets, { scanSkillSourceRepo }, { admitCliCapabilities }, lifecycle, { reapOnce }, workers,
    platformTokens] = await Promise.all([
    import(schedulerRequire.resolve("fastify")), import("../../apps/scheduler/src/db.js"), import("../../apps/scheduler/src/runtime.js"),
    import("../../apps/scheduler/src/dispatcher.js"), import("../../apps/scheduler/src/domains/platform-api/index.js"),
    import("../../apps/scheduler/src/gateway.js"), import("../../apps/scheduler/src/credentials.js"),
    import(schedulerRequire.resolve("@deepsonar/runtime-sandbox")), import("../../apps/scheduler/src/finding-protocol.js"),
    import("../../apps/scheduler/src/domains/shared-assets/index.js"), import("../../apps/scheduler/src/skill-sources.js"),
    import("../../apps/scheduler/src/domains/cli-capability/admit.js"),
    import("../../apps/scheduler/src/domains/job-lifecycle/index.js"), import("../../apps/scheduler/src/reaper.js"),
    import("../../apps/scheduler/src/domains/worker-nodes/index.js"),
    import("../../apps/scheduler/src/domains/platform-api/tokens.js"),
  ]);
  sql = database.sql; runner = runtime.runner;
  drainJobs = () => dispatcher.drainInFlight(60_000);
  // Mirror POST /jobs/:id/cancel: lifecycle status change alone does not destroy
  // the OpenSandbox or revoke tokens; production route side effects do.
  const cancelJobWithCleanup = async (id: string, reason: string) => {
    const job = await lifecycle.createSqlJobLifecycleApplication().cancelJob(id, reason);
    if (job?.sandbox_id) {
      await runner.destroy({ sandboxId: String(job.sandbox_id) }).catch(() => undefined);
    }
    await gateway.revokeJobTokens(id, "cancelled").catch(() => undefined);
    await platformTokens.revokeJobCapabilityTokens(id, "cancelled").catch(() => undefined);
    return job;
  };
  cancelJob = (id) => cancelJobWithCleanup(id, "rea-acceptance-cleanup");
  await database.migrate();
  // Match Scheduler boot: an empty isolated DB has no local execution worker
  // until the production bootstrap registers the configured OpenSandbox.
  const localWorker = await workers.seedLocalWorkerNode();
  assert.ok(localWorker, "REA_JOB_RUNTIME_UNAVAILABLE: configured local OpenSandbox worker was not seeded");
  const dispatchable = (await workers.listWorkerNodes()).find((worker) => worker.id === localWorker.id);
  assert.ok(dispatchable && workers.workerIsDispatchable(dispatchable, Date.now(), 60_000, { requireLocal: true }),
    "REA_JOB_RUNTIME_UNAVAILABLE: local worker has no dispatchable capacity");
  report.worker = { id: localWorker.id, kind: localWorker.kind, capacity: localWorker.capacity };
  app = Fastify({ logger: false });
  platform.registerPlatformControlRoutes(app);
  gateway.registerGateway(app);
  // Marker is only used to prove the Gateway proxy does not forward a denied
  // path. OpenSandbox Docker DNS-mode egress does not block raw host-bridge
  // IPs (ingress.mode=direct), so host:port probes are not an honest deny check.
  const egressProbeMarker = randomUUID();
  await app.listen({ port: 3100, host: "0.0.0.0" });
  const projectId = randomUUID();
  await sql`INSERT INTO projects (id,name,config_json) VALUES (${projectId},'REA live isolated acceptance',
    ${sql.json({ rules: { hubEnabled: false, minVerifySeverity: "critical", maxVerificationRounds: 3 } })})`;
  const credentialId = randomUUID();
  const secret = `rea-local-test-${randomUUID()}`;
  const encrypted = credentials.encryptSecret(secret);
  await sql`INSERT INTO credentials (id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,status,agent_cli,public_metadata_json)
    VALUES (${credentialId},'Disposable local model fixture','llm_provider','anthropic',${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},
      ${credentials.fingerprintOf(secret)},${credentials.last4Of(secret)},'active','claude-code',${sql.json({ base_url: model.url })})`;
  const { persistSkillSourceManifest, freezeJobSkillCatalog } = await import("../../apps/scheduler/src/job-skill-catalog.js");
  const { freezeProjectKnowledgeCatalog } = await import("../../apps/scheduler/src/domains/project-knowledge/catalog-snapshot.js");
  const sourceId = randomUUID();
  const catalog = scanSkillSourceRepo(path.join(root, "skills"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const sourceManifest = await persistSkillSourceManifest(sql, { sourceId, commitSha: commit, catalog });
  await sql`INSERT INTO skill_sources (id,name,repo_url,trust_status,enabled,catalog_json,last_commit_sha,catalog_snapshot_hash)
    VALUES (${sourceId},'REA acceptance source','https://github.com/SummerSec/DeepSonar','trusted',true,${sql.json(catalog)},${commit},${sourceManifest})`;
  const skill = await readFile(path.join(root, "skills/deepsonar-rea-cli/SKILL.md"), "utf8");
  const worker = await readFile(path.join(root, "agent-harness/opensandbox/rea-job-actor.py"), "utf8");
  const samplePath = path.join(reportDir, "sample_elf");
  execFileSync("cc", ["-O0", "-g", "-fno-inline", "-o", samplePath, path.join(root, "agent-harness/fixtures/reverse-sample/sample.c")]);
  const sample = await readFile(samplePath);
  const sampleSha = createHash("sha256").update(sample).digest("hex");
  report.sample = { sha256: sampleSha, source: "agent-harness/fixtures/reverse-sample/sample.c", architecture: nativeArch };
  const admitted = admitCliCapabilities({ ids: ["binary.rea.cli"], imageKey: "deepsonar-reverse" });
  assert.ok(admitted.ok);
  const file = (name: string, content: string) => ({ path: name, content, content_sha256: createHash("sha256").update(content).digest("hex") });
  const makeSnapshot = (mode: string, extra: Record<string, unknown> = {}) => ({
    name: mode === "verify" ? "verify" : "audit", role_kind: mode === "verify" ? "system" : "role",
    agent_cli: "claude-code", agent_runtime: snapshotHelpers.freezeAgentCliRuntime(snapshotHelpers.AGENT_CLI_RUNTIME_ADAPTERS["claude-code"]),
    credential_id: credentialId, credential_provider: "anthropic", model: "claude-sonnet-4-5", upstream_model: "claude-sonnet-4-5",
    env_vars: {}, env_keys: [], skills: [], commands: [], mcps: [], subagents: [], modules: [], module_selectors: [],
    expanded_modules: [], missing_modules: [], module_content_hash: "", skill_revisions: [], config_files: [
      file("rea-job-actor.py", worker), file("sample_elf.base64", sample.toString("base64")),
      file("rea-job-input.json", JSON.stringify({ mode, image_digest: imageDigest, sample_sha256: sampleSha, egress_probe_marker: egressProbeMarker, skill_sha256: createHash("sha256").update(skill).digest("hex"), ...extra })),
    ], settings_config_json: {}, pi_extensions: [], role_description: "Real REA runtime acceptance", instructions_markdown: null,
    context_window_tokens: 200000, platform_tools: mode === "verify" ? ["emit_progress", "mark_job_done"] : [
      "search_skills", "pull_skill", "describe_capability", "emit_progress", "publish_shared_asset", "emit_fact", "emit_finding", "mark_job_done",
    ], cli_capabilities: admitted.frozen, cli_capability_pack: admitted.pack,
    network_policy: { allow_egress: false }, sandbox_limits: { cpu: 2, memoryMiB: 4096, pidsLimit: 512, capDropAll: true, noNewPrivileges: true },
    // CI trusts the locally built, inspected image for this disposable test only.
    // This does not create registry versions, scans, admission, or project pins.
    runtime_image: { image_key: "deepsonar-reverse", image_ref: imageRef, image_digest: imageDigest,
      runtime_image_id: null, runtime_image_version_id: null, admission_scan_id: null, tools_manifest_sha256: toolManifestSha, manual: toolManifest.manual,
      contract_version: "deepsonar.runtime.contract/v1" },
  });
  const newJob = async (mode: string, extra: Record<string, unknown> = {}, finding?: any, shared?: any) => {
    const id = randomUUID(); const canvasId = finding?.canvas_id || randomUUID();
    if (!finding) {
      await sql`INSERT INTO canvases (id,project_id,title,target_json) VALUES (${canvasId},${projectId},${`REA ${mode}`},
        ${sql.json({
          network_policy: { allow_egress: false }, effective_finding_protocol: DEFAULT_FINDING_PROTOCOL,
          // Verify rework/failure force-wakes Hub, which needs a trusted Hub runtime
          // (deepsonar-base) this disposable DB never admits. Hub is out of scope:
          // pause it through the production convergence control instead of faking admission.
          convergence: { hub_paused: true, auto_stopped: false, paused_reason: "rea_acceptance_hub_out_of_scope" },
        })})`;
      await sql`INSERT INTO canvas_nodes (canvas_id,node_type,title,status,body_json) VALUES (${canvasId},'root','REA acceptance','active','{}')`;
    }
    const snapshot: any = { ...makeSnapshot(mode, extra),
      job_skill_catalog: await freezeJobSkillCatalog(sql, projectId),
      project_knowledge_catalog: await freezeProjectKnowledgeCatalog(sql, projectId),
    };
    if (shared) Object.assign(snapshot, { shared_assets: shared.assets, shared_assets_revision: shared.revision });
    await sql`INSERT INTO jobs (id,project_id,canvas_id,finding_id,type,status,agent_snapshot_json,payload_json,timeout_sec)
      VALUES (${id},${projectId},${canvasId},${finding?.id ?? null},${mode === "verify" ? "verify_finding" : "audit"},'pending',
        ${sql.json(snapshot)},${sql.json(finding ? { finding, verification_attempt: 1 } : { intent: { prompt: "Run the deterministic REA acceptance actor; all observations must use Job Control API." } })},600)`;
    if (shared) await assets.recordJobSharedAssets(sql, id, shared.assets);
    jobIds.push(id);
    return { id, canvasId };
  };
  const run = async (id: string, mode: string) => {
    assert.equal(await dispatcher.dispatchOnce(), 1, `expected only ${mode} Job to dispatch`);
    const deadline = Date.now() + 600_000;
    let interrupted = false;
    let redispatchCalls = 0;
    let redispatched = 0;
    let row: any;
    while (Date.now() < deadline) {
      [row] = await sql`SELECT * FROM jobs WHERE id=${id}`;
      // This harness drives dispatchOnce directly, without the production LISTEN
      // loop. Consume legal kernel requeues through that same dispatcher rather
      // than stranding a pre-start retry until the unchanged acceptance deadline.
      if (row.status === "pending") {
        redispatchCalls++;
        redispatched += await dispatcher.dispatchOnce();
      }
      if (!interrupted && ["cancel", "timeout"].includes(mode)) {
        const [checkpoint] = await sql`SELECT id,payload_json FROM events WHERE job_id=${id} AND payload_json->>'message' LIKE 'REA_CHECKPOINT_READY%'`;
        if (checkpoint) {
          const pid = /pid=(\d+)/.exec(String(checkpoint.payload_json.message))?.[1];
          assert.ok(pid && row.sandbox_id, "live checkpoint must identify its REA process and sandbox");
          const host = await runner.ensureHost({ sandboxId: row.sandbox_id });
          assert.equal((await host.run(`kill -0 ${pid}`)).exitCode, 0, "must interrupt a still-running REA process");
          interrupted = true;
          if (mode === "cancel") await cancelJobWithCleanup(id, "rea-acceptance");
          else {
            // Expire the real Scheduler deadline only after durable checkpoint.
            await sql`UPDATE jobs SET timeout_sec=1,started_at=now()-interval '5 minutes' WHERE id=${id}`;
            await reapOnce();
          }
        }
      }
      if (["succeeded", "failed", "timeout", "cancelled", "orphan"].includes(row.status)) break;
      await sleep(300);
    }
    assert.ok(row, "Job disappeared");
    // Terminal status precedes the dispatcher's asynchronous finally cleanup.
    // Drain before asserting the outcome, including expected test failures.
    await drainJobs!();
    const attempts = await sql`SELECT id,status,phase,sandbox_id,created_at,finished_at,
      outcome_json->>'reason' AS reason, outcome_json->>'retry_scheduled' AS retry_scheduled
      FROM job_attempts WHERE job_id=${id} ORDER BY created_at,id LIMIT 16`;
    const jobReport: Record<string, unknown> = {
      id, mode, status: row.status, error: row.error ?? null, attempts,
      redispatch_calls: redispatchCalls, redispatched,
    };
    report.jobs.push(jobReport);
    await saveReport();
    const expectedStatus = mode === "cancel" ? "cancelled" : mode === "timeout" ? "timeout" : mode === "failure" ? "failed" : "succeeded";
    if (row.status !== expectedStatus) {
      const [actorFail] = await sql`SELECT payload_json FROM events WHERE job_id=${id}
        AND payload_json->>'message' LIKE 'REA_ACTOR_FAILED%'
        ORDER BY created_at DESC LIMIT 1`;
      const detail = JSON.stringify({ actor: actorFail?.payload_json?.message ?? null, error: row.error ?? null, status: row.status });
      assert.equal(row.status, expectedStatus, `${mode}: ${detail}`);
    }
    assert.equal((await runner.listResources({ jobId: id })).length, 0, `${mode}: sandbox leaked`);
    const tokens = await sql`SELECT revoked_at FROM job_capability_tokens WHERE job_id=${id}`;
    assert.ok(tokens.length > 0 && tokens.every((token: any) => token.revoked_at), "terminal Job tokens must be revoked");
    const modelTokens = await sql`SELECT status FROM job_tokens WHERE job_id=${id}`;
    assert.ok(modelTokens.length > 0 && modelTokens.every((token: any) => token.status !== "active"), "model tokens must be revoked too");
    assert.ok(!(await runtime.sharedAssetsVolumeManager.listManaged()).some((volume) => volume.jobId === id), "shared-assets mount leaked");
    assert.ok(attempts.some((attempt: any) => attempt.sandbox_id && attempt.status !== "active"));
    Object.assign(jobReport, { attempts, resources_remaining: 0 });
    await saveReport();
    return row;
  };
  const archiveFor = async (id: string) => {
    const [asset] = await sql`SELECT v.id,v.bytes,v.content_sha256,b.blob_uri,s.logical_key
      FROM shared_assets s JOIN shared_asset_versions v ON v.asset_id=s.id AND v.version=s.current_version
      JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256 WHERE s.created_by_job_id=${id}`;
    assert.ok(asset, "actual tool archive missing after cleanup");
    const bytes = await assets.readSharedAssetBlob(asset.blob_uri);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.content_sha256);
    await writeFile(path.join(reportDir, `${id}-observation.json`), bytes);
    const archive = JSON.parse(bytes.toString("utf8"));
    assert.equal(archive.job_id, id);
    const facts = await sql`SELECT n.id,n.verification_status,a.id AS artifact_id,a.extensions_json
      FROM canvas_nodes n JOIN artifacts a ON a.node_id=n.id WHERE n.job_id=${id} AND n.node_type='fact'`;
    assert.equal(facts.length, 1, "production emit_fact must persist both Fact and Artifact");
    assert.equal(facts[0].verification_status, "unverified");
    const extension = facts[0].extensions_json['binary.rea-cli'];
    assert.equal(extension.evidence_version_id, asset.id);
    assert.equal(extension.evidence_sha256, asset.content_sha256);
    const claims = await sql`SELECT status FROM artifact_claims WHERE artifact_id=${facts[0].artifact_id}`;
    assert.ok(claims.length && claims.every((claim: any) => claim.status === "unknown"));
    return { asset, archive, extension };
  };
  const maker = await newJob("success");
  await run(maker.id, "success");
  const observed = await archiveFor(maker.id);
  assert.equal(observed.archive.exit_code, 0);
  assert.equal(observed.extension.inconclusive, false);
  assert.match(observed.archive.stdout, /strcpy/);
  const [finding] = await sql`SELECT f.*,j.canvas_id FROM findings f JOIN jobs j ON j.id=f.job_id WHERE f.job_id=${maker.id}`;
  assert.ok(finding && finding.verify_status !== "confirmed");
  const frozen = await assets.resolveSharedAssetSelection(sql, projectId, []);
  const archived = frozen.assets.find((asset) => asset.version_id === observed.asset.id);
  assert.ok(archived);
  const verifier = await newJob("verify", { archive_read_path: archived.mount_path, archive_sha256: archived.sha256 }, finding, frozen);
  assert.notEqual(verifier.id, maker.id);
  await run(verifier.id, "verify");
  const [round] = await sql`SELECT proposed_verdict,final_outcome,status,evidence_snapshot_json FROM finding_verification_rounds WHERE verify_job_id=${verifier.id}`;
  assert.ok(round, "independent Verify result must be durable");
  const [archiveRead] = await sql`SELECT id FROM events WHERE job_id=${verifier.id} AND payload_json->>'message' LIKE 'REA_VERIFY_ARCHIVE_READ%'`;
  assert.ok(archiveRead, "independent verifier must actually read retained archive bytes");
  assert.equal(round.proposed_verdict, "confirmed");
  assert.equal(round.final_outcome, "rework", "raw maker observations must fail the production confirmation gate");
  report.verify = round;
  const [{ hubs }] = await sql`SELECT count(*)::int AS hubs FROM jobs WHERE project_id=${projectId} AND type='hub_reason'`;
  assert.equal(hubs, 0, "paused acceptance canvas must not dispatch Hub");
  for (const mode of ["failure", "cancel", "timeout"]) {
    const job = await newJob(mode);
    await run(job.id, mode);
    const result = await archiveFor(job.id);
    assert.equal(result.extension.inconclusive, true, `${mode}: incomplete output must not become successful evidence`);
    if (mode === "failure") assert.notEqual(result.archive.exit_code, 0);
    else assert.equal(result.archive.exit_code, null, "the durable prefix must remain explicitly unfinished");
  }
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM findings WHERE title='REA_HOSTILE_STDOUT_MUST_NOT_INGEST'`;
  assert.equal(count, 0, "ordinary stdout must not become a semantic control event");
  report.model_requests = model.calls();
  assert.ok(report.model_requests >= 8, "real CLI must talk through the Model Gateway");
  report.proves = report.requested_coverage;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  // Keep Control, Gateway and DB alive while cancellation/finalizers revoke
  // tokens, archive sessions and release Worker-plane leases.
  if (cancelJob) for (const id of jobIds) await cancelJob(id).catch((error) => {
    (report.cleanup_errors ??= []).push(`cancel ${id}: ${String(error)}`);
  });
  if (drainJobs) await drainJobs().catch((error) => {
    (report.cleanup_errors ??= []).push(`drain: ${String(error)}`);
  });
  if (runner) for (const id of jobIds) {
    for (const resource of await runner.listResources({ jobId: id }).catch(() => [])) {
      await runner.destroy({ sandboxId: resource.resourceId }).catch(() => undefined);
    }
  }
  if (app) await app.close().catch(() => undefined);
  if (model) await model.close().catch(() => undefined);
  if (sql) await sql.end({ timeout: 5 }).catch(() => undefined);
  if (admin) {
    if (databaseName) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
  if (report.cleanup_errors?.length) {
    report.status = "failed";
    delete report.proves;
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  await saveReport();
  console.log(JSON.stringify({ status: report.status, report: path.join(reportDir, "job-acceptance.json"), error: report.error }));
}
