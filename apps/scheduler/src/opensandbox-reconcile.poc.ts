/**
 * Live proof that Scheduler boot reconcile owns OpenSandbox leftovers.
 * effect_pending / running crash must orphan and destroy, never auto-replay.
 * Requires OPEN_SANDBOX_POC=1, TEST_DATABASE_URL, and a reachable server.
 * Kubernetes/Kata server additionally needs OPEN_SANDBOX_KUBERNETES=1
 * so provision omits Docker-only ResourceName=pids. The smoke script
 * rebuilds @deepsonar/runtime-sandbox so Scheduler imports the current dist.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  freezeAgentCliRuntime,
  shouldRunOpenSandboxPoc,
} from "@deepsonar/runtime-sandbox";
import { buildAttemptState } from "./domains/job-attempt/model.js";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox reconcile PoC (set OPEN_SANDBOX_POC=1)");
  process.exit(0);
}

process.env.DEEPSONAR_MASTER_KEY ??= "00".repeat(32);

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
const databaseName = `deepsonar_os_reconcile_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
const targetUrl = new URL(databaseUrl);
targetUrl.pathname = `/${databaseName}`;
targetUrl.search = "";

const kubernetes = ["1", "true", "yes", "on"].includes((process.env.OPEN_SANDBOX_KUBERNETES ?? "").toLowerCase());
/** Kata nodes also run system pods; two `cpu:1` sandboxes fail scheduling on a 2-core node. */
const sandboxCpu = kubernetes ? 0.4 : 1;
console.log(`OpenSandbox reconcile kubernetes=${kubernetes} cpu=${sandboxCpu} domain=${process.env.OPEN_SANDBOX_DOMAIN ?? ""}`);

const projectId = randomUUID();
const canvasId = randomUUID();
const requeueJobId = randomUUID();
const pendingJobId = randomUUID();
const runningJobId = randomUUID();
const requeueAttemptId = randomUUID();
const pendingAttemptId = randomUUID();
const runningAttemptId = randomUUID();
let endSql: (() => Promise<unknown>) | null = null;
let databaseCreated = false;
let runner: Awaited<typeof import("./runtime.js")>["runner"] | null = null;
const provisioned: Array<{ jobId: string; sandboxId: string }> = [];

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  process.env.DATABASE_URL = targetUrl.toString();
  process.env.AGENT_MODE = "real";
  process.env.SANDBOX_PROVIDER = "opensandbox";
  process.env.OPEN_SANDBOX_API_KEY = apiKey;
  process.env.OPEN_SANDBOX_DOMAIN = process.env.OPEN_SANDBOX_DOMAIN?.trim() || "127.0.0.1:8080";

  const [dbModule, runtimeModule, { reconcileOnBoot }] = await Promise.all([
    import("./db.js"),
    import("./runtime.js"),
    import("./reconcile.js"),
  ]);
  runner = runtimeModule.runner;
  const sandboxRunner = runtimeModule.runner;
  const { sql, migrate } = dbModule;
  endSql = () => sql.end({ timeout: 5 });
  await migrate();

  const snapshot = {
    name: "audit",
    platform_tools: ["emit_fact", "emit_finding", "mark_job_done"],
    agent_cli: "claude-code",
    agent_runtime: freezeAgentCliRuntime(AGENT_CLI_RUNTIME_ADAPTERS["claude-code"]),
    sandbox_limits: { cpu: sandboxCpu, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true },
    runtime_image: { image_ref: runtimeImage, contract_version: "deepsonar.runtime.contract/v1" },
    network_policy: { allow_egress: false },
  };
  const snapshotJson = JSON.parse(JSON.stringify(snapshot));
  await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'OpenSandbox reconcile')`;
  await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'OpenSandbox reconcile')`;

  const leftovers = await sandboxRunner.listResources();
  for (const resource of leftovers) {
    await sandboxRunner.destroyResource(resource).catch(() => {});
  }
  const remaining = await sandboxRunner.listResources();
  if (remaining.length > 0) {
    throw new Error(`OPENSANDBOX_POC_DIRTY: ${remaining.map((item) => item.resourceId).join(",")}`);
  }

  const provision = async (jobId: string, attemptId: string) => {
    const handle = await sandboxRunner.provision({
      jobId,
      attemptId,
      image: runtimeImage,
      network: "none",
      limits: snapshot.sandbox_limits,
      expectedContract: "deepsonar.runtime.contract/v1",
    });
    provisioned.push({ jobId, sandboxId: handle.sandboxId });
    return handle.sandboxId;
  };

  const pendingSandbox = await provision(pendingJobId, pendingAttemptId);
  const runningSandbox = await provision(runningJobId, runningAttemptId);

  await sql`
    INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, timeout_sec)
    VALUES
      (${requeueJobId}, ${projectId}, ${canvasId}, 'audit', 'provisioning', ${sql.json(snapshotJson)}, 3600),
      (${pendingJobId}, ${projectId}, ${canvasId}, 'audit', 'provisioning', ${sql.json(snapshotJson)}, 3600),
      (${runningJobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(snapshotJson)}, 3600)`;
  await sql`UPDATE jobs SET sandbox_id = ${pendingSandbox} WHERE id = ${pendingJobId}`;
  await sql`UPDATE jobs SET sandbox_id = ${runningSandbox} WHERE id = ${runningJobId}`;
  const attemptState = (id: string, jobId: string, phase: "preparing" | "provision.effect_pending" | "agent.ready", sandboxId: string | null) => {
    const state = buildAttemptState({ attemptId: id, jobId, attemptNo: 1, phase });
    return JSON.parse(JSON.stringify({ ...state, sandbox_id: sandboxId }));
  };
  await sql`
    INSERT INTO job_attempts (id, job_id, attempt_no, status, phase, started_at, sandbox_id, state_json)
    VALUES
      (${requeueAttemptId}, ${requeueJobId}, 1, 'active', 'preparing', now(), NULL, ${sql.json(attemptState(requeueAttemptId, requeueJobId, "preparing", null))}),
      (${pendingAttemptId}, ${pendingJobId}, 1, 'active', 'provision.effect_pending', now(), ${pendingSandbox}, ${sql.json(attemptState(pendingAttemptId, pendingJobId, "provision.effect_pending", pendingSandbox))}),
      (${runningAttemptId}, ${runningJobId}, 1, 'active', 'agent.ready', now(), ${runningSandbox}, ${sql.json(attemptState(runningAttemptId, runningJobId, "agent.ready", runningSandbox))})`;
  await sql`
    INSERT INTO job_attempt_effects (
      attempt_id, job_id, effect_id, effect_kind, status, replay_policy, resource_identity_json
    ) VALUES (
      ${pendingAttemptId}, ${pendingJobId}, 'provision:1', 'provision', 'effect_pending', 'never',
      ${sql.json(JSON.parse(JSON.stringify({ sandbox_id: pendingSandbox })))}
    )`;

  const jobsBefore = await sql`SELECT id, status FROM jobs ORDER BY id`;
  await reconcileOnBoot();
  const jobsAfter = await sql`SELECT id, status FROM jobs`;
  const statusOf = (id: string) => String(jobsAfter.find((row) => String(row.id) === id)?.status ?? "");
  const leftoverPending = await sandboxRunner.listResources({ jobId: pendingJobId });
  const leftoverRunning = await sandboxRunner.listResources({ jobId: runningJobId });
  const leftoverRequeue = await sandboxRunner.listResources({ jobId: requeueJobId });
  const seeded = new Set<string>([requeueJobId, pendingJobId, runningJobId]);
  const extraJobs = jobsAfter.filter((row) => !seeded.has(String(row.id)));

  if (statusOf(requeueJobId) !== "pending") {
    throw new Error(`expected untouched provision to requeue, got ${statusOf(requeueJobId)}`);
  }
  if (statusOf(pendingJobId) !== "orphan") {
    throw new Error(`effect_pending must orphan, got ${statusOf(pendingJobId)}`);
  }
  if (statusOf(runningJobId) !== "orphan") {
    throw new Error(`running crash must orphan, got ${statusOf(runningJobId)}`);
  }
  if (leftoverPending.length + leftoverRunning.length + leftoverRequeue.length > 0) {
    throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${[...leftoverPending, ...leftoverRunning, ...leftoverRequeue].map((item) => item.resourceId).join(",")}`);
  }
  if (extraJobs.length > 0) {
    throw new Error(`reconcile auto-replayed jobs: ${extraJobs.map((row) => row.id).join(",")}`);
  }
  if (jobsBefore.length !== 3) {
    throw new Error(`expected 3 seeded jobs, got ${jobsBefore.length}`);
  }
  console.log("OK: OpenSandbox reconcile requeued=1 orphaned=2 leftover=0 replay=0");
} finally {
  if (runner) {
    for (const item of provisioned) {
      await runner.destroy({ sandboxId: item.sandboxId }).catch(() => {});
    }
  }
  if (endSql) await endSql().catch(() => {});
  if (databaseCreated) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end({ timeout: 5 }).catch(() => {});
}
