/**
 * Live proof that dispatcher provision/cancel owns OpenSandbox Job resources:
 * revoke tokens, destroy sandbox, remove frozen shared assets. leftover=0.
 * Tokens are minted by preparePlatformCapability inside runJob; this script
 * never calls host.run or executeReal itself. PTY close is covered by the
 * Reaper harness on the same runner.destroy path. Requires OPEN_SANDBOX_POC=1.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  freezeAgentCliRuntime,
  shouldRunOpenSandboxPoc,
} from "@deepsonar/runtime-sandbox";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox dispatch PoC (set OPEN_SANDBOX_POC=1)");
  process.exit(0);
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const apiKey = process.env.OPEN_SANDBOX_API_KEY?.trim();
const runtimeImage = process.env.OPEN_SANDBOX_POC_RUNTIME_IMAGE?.trim();
if (!databaseUrl || !apiKey || !runtimeImage) {
  console.error("TEST_DATABASE_URL, OPEN_SANDBOX_API_KEY, and OPEN_SANDBOX_POC_RUNTIME_IMAGE are required");
  process.exit(1);
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const admin = postgres(adminUrl.toString(), { max: 1 });
const databaseName = `deepsonar_os_dispatch_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
const targetUrl = new URL(databaseUrl);
targetUrl.pathname = `/${databaseName}`;
targetUrl.search = "";

const projectId = randomUUID();
const canvasId = randomUUID();
const jobId = randomUUID();
let endSql: (() => Promise<unknown>) | null = null;
let databaseCreated = false;
let blobDir: string | null = null;
let assets: Awaited<typeof import("./runtime.js")>["sharedAssetsVolumeManager"] | null = null;
let runner: Awaited<typeof import("./runtime.js")>["runner"] | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  blobDir = await mkdtemp(path.join(os.tmpdir(), "os-dispatch-blobs-"));
  process.env.DATABASE_URL = targetUrl.toString();
  process.env.AGENT_MODE = "real";
  process.env.SANDBOX_PROVIDER = "opensandbox";
  process.env.OPEN_SANDBOX_API_KEY = apiKey;
  process.env.OPEN_SANDBOX_DOMAIN = process.env.OPEN_SANDBOX_DOMAIN?.trim() || "127.0.0.1:8080";
  process.env.DEEPSONAR_API_SANDBOX_URL = "http://deepsonar-gateway-proxy:3100/control/v1";
  process.env.DEEPSONAR_GATEWAY_PROXY_UPSTREAM_URL = "http://host.docker.internal:3100/gateway";
  process.env.BLOB_STORE = "fs";
  process.env.BLOB_DIR = blobDir;

  const [
    dbModule,
    runtimeModule,
    { dispatchOnce },
    { createSqlJobLifecycleApplication },
    { createSharedAsset, resolveSharedAssetSelection, recordJobSharedAssets },
  ] = await Promise.all([
    import("./db.js"),
    import("./runtime.js"),
    import("./dispatcher.js"),
    import("./domains/job-lifecycle/index.js"),
    import("./domains/shared-assets/index.js"),
  ]);
  runner = runtimeModule.runner;
  assets = runtimeModule.sharedAssetsVolumeManager;
  const { sql, migrate } = dbModule;
  endSql = () => sql.end({ timeout: 5 });
  await migrate();

  await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'OpenSandbox dispatch')`;
  await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'OpenSandbox dispatch')`;
  await createSharedAsset({
    scope: "project",
    projectId,
    key: "poc/seed.txt",
    contentType: "text/plain",
    bytes: Buffer.from("dispatch-seed\n"),
    origin: "system",
    actor: "opensandbox-dispatch-poc",
  });
  const frozen = await resolveSharedAssetSelection(sql, projectId, []);
  if (frozen.assets.length !== 1) throw new Error(`expected 1 frozen shared asset, got ${frozen.assets.length}`);
  const snapshot = {
    name: "audit",
    platform_tools: ["emit_fact", "emit_finding", "mark_job_done"],
    agent_cli: "claude-code",
    agent_runtime: freezeAgentCliRuntime(AGENT_CLI_RUNTIME_ADAPTERS["claude-code"]),
    sandbox_limits: { cpu: 1, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true },
    runtime_image: { image_ref: runtimeImage, contract_version: "deepsonar.runtime.contract/v1" },
    network_policy: { allow_egress: false },
    shared_assets_revision: frozen.revision,
    shared_assets: frozen.assets,
  };
  await sql`
    INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, timeout_sec)
    VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'pending', ${sql.json(JSON.parse(JSON.stringify(snapshot)))}, 3600)`;
  await recordJobSharedAssets(sql, jobId, frozen.assets);

  const claimed = await dispatchOnce();
  if (claimed !== 1) throw new Error(`dispatchOnce claimed ${claimed}, expected 1`);

  const lifecycle = createSqlJobLifecycleApplication();
  let provisioned = false;
  let cancelled = false;
  let lastStatus = "pending";
  let sandboxId: string | null = null;
  let jobError = "";
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const [job] = await sql`SELECT status, sandbox_id, error FROM jobs WHERE id = ${jobId}`;
    lastStatus = String(job?.status ?? "");
    sandboxId = typeof job?.sandbox_id === "string" && job.sandbox_id ? job.sandbox_id : sandboxId;
    if (typeof job?.error === "string") jobError = job.error;
    if (sandboxId) provisioned = true;
    if (!cancelled && (sandboxId || lastStatus === "running")) {
      const row = await lifecycle.cancelJob(jobId, "opensandbox-dispatch-poc");
      cancelled = Boolean(row);
    }
    if (["failed", "succeeded", "timeout", "orphan"].includes(lastStatus)) break;
    if (lastStatus === "cancelled" && provisioned) break;
    await sleep(400);
  }
  for (let i = 0; i < 20; i++) {
    const leftovers = await runner.listResources({ jobId });
    if (leftovers.length === 0) {
      if (!provisioned) throw new Error(`dispatcher never provisioned an OpenSandbox (status=${lastStatus} error=${jobError.slice(0, 240)})`);
      if (!["cancelled", "failed"].includes(lastStatus)) {
        throw new Error(`expected terminal status after provision, status=${lastStatus} sandbox=${sandboxId ?? "none"}`);
      }
      const tokens = await sql`SELECT revoked_at, revoke_reason FROM job_capability_tokens WHERE job_id = ${jobId}`;
      if (tokens.length === 0 || tokens.some((row) => !row.revoked_at)) {
        throw new Error("cancel/terminal must revoke capability tokens");
      }
      let volumeGone = false;
      for (let retry = 0; retry < 20; retry++) {
        const managed = await assets!.listManaged();
        if (!managed.some((item) => item.jobId === jobId)) {
          volumeGone = true;
          break;
        }
        await sleep(250);
      }
      if (!volumeGone) throw new Error("cancel/terminal must remove shared assets volume");
      console.log(`OK: OpenSandbox dispatch claimed=1 provisioned=true cancelled=${cancelled} leftover=0 tokens=revoked assets=0 status=${lastStatus}`);
      break;
    }
    if (i === 19) {
      throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    }
    await sleep(500);
  }
} finally {
  if (runner) await runner.listResources({ jobId }).then(async (leftovers) => {
    for (const item of leftovers) await runner!.destroy({ sandboxId: item.resourceId }).catch(() => {});
  }).catch(() => {});
  if (assets) await assets.removeForJob(jobId).catch(() => {});
  if (endSql) await endSql().catch(() => {});
  if (blobDir) await rm(blobDir, { recursive: true, force: true }).catch(() => {});
  if (databaseCreated) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end({ timeout: 5 }).catch(() => {});
}
