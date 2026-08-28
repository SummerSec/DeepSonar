/**
 * Live proof that Reaper timeout/orphan owns OpenSandbox leftovers.
 * isAlive must be true before reap and false after destroy. leftover=0.
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
  console.log("skip: OpenSandbox reaper PoC (set OPEN_SANDBOX_POC=1)");
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
const databaseName = `deepsonar_os_reaper_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
const targetUrl = new URL(databaseUrl);
targetUrl.pathname = `/${databaseName}`;
targetUrl.search = "";

const projectId = randomUUID();
const canvasId = randomUUID();
const timeoutJobId = randomUUID();
const orphanJobId = randomUUID();
const liveJobId = randomUUID();
const timeoutAttemptId = randomUUID();
const orphanAttemptId = randomUUID();
const liveAttemptId = randomUUID();
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

  const [dbModule, runtimeModule, { reapOnce }] = await Promise.all([
    import("./db.js"),
    import("./runtime.js"),
    import("./reaper.js"),
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
    sandbox_limits: { cpu: 1, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true },
    runtime_image: { image_ref: runtimeImage, contract_version: "deepsonar.runtime.contract/v1" },
    network_policy: { allow_egress: false },
  };
  const snapshotJson = JSON.parse(JSON.stringify(snapshot));
  await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'OpenSandbox reaper')`;
  await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'OpenSandbox reaper')`;

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

  const timeoutSandbox = await provision(timeoutJobId, timeoutAttemptId);
  const orphanSandbox = await provision(orphanJobId, orphanAttemptId);
  const liveSandbox = await provision(liveJobId, liveAttemptId);
  const aliveBefore = {
    timeout: await sandboxRunner.isAlive({ sandboxId: timeoutSandbox }),
    orphan: await sandboxRunner.isAlive({ sandboxId: orphanSandbox }),
    live: await sandboxRunner.isAlive({ sandboxId: liveSandbox }),
  };
  if (!aliveBefore.timeout || !aliveBefore.orphan || !aliveBefore.live) {
    throw new Error(`expected all sandboxes alive before reap: ${JSON.stringify(aliveBefore)}`);
  }

  await sql`
    INSERT INTO jobs (
      id, project_id, canvas_id, type, status, agent_snapshot_json, timeout_sec,
      sandbox_id, started_at, lease_expires_at
    ) VALUES
      (${timeoutJobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(snapshotJson)}, 1,
       ${timeoutSandbox}, now() - interval '10 minutes', now() + interval '1 hour'),
      (${orphanJobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(snapshotJson)}, 3600,
       ${orphanSandbox}, now(), now() - interval '1 minute'),
      (${liveJobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(snapshotJson)}, 3600,
       ${liveSandbox}, now(), now() + interval '1 hour')`;
  const attemptState = (id: string, jobId: string, sandboxId: string) =>
    JSON.parse(JSON.stringify({
      ...buildAttemptState({ attemptId: id, jobId, attemptNo: 1, phase: "agent.ready" }),
      sandbox_id: sandboxId,
    }));
  await sql`
    INSERT INTO job_attempts (id, job_id, attempt_no, status, phase, started_at, sandbox_id, state_json)
    VALUES
      (${timeoutAttemptId}, ${timeoutJobId}, 1, 'active', 'agent.ready', now(), ${timeoutSandbox}, ${sql.json(attemptState(timeoutAttemptId, timeoutJobId, timeoutSandbox))}),
      (${orphanAttemptId}, ${orphanJobId}, 1, 'active', 'agent.ready', now(), ${orphanSandbox}, ${sql.json(attemptState(orphanAttemptId, orphanJobId, orphanSandbox))}),
      (${liveAttemptId}, ${liveJobId}, 1, 'active', 'agent.ready', now(), ${liveSandbox}, ${sql.json(attemptState(liveAttemptId, liveJobId, liveSandbox))})`;

  const reaped = await reapOnce();
  const jobsAfter = await sql`SELECT id, status FROM jobs`;
  const statusOf = (id: string) => String(jobsAfter.find((row) => String(row.id) === id)?.status ?? "");
  const leftoverTimeout = await sandboxRunner.listResources({ jobId: timeoutJobId });
  const leftoverOrphan = await sandboxRunner.listResources({ jobId: orphanJobId });
  const leftoverLive = await sandboxRunner.listResources({ jobId: liveJobId });
  const aliveAfter = {
    timeout: await sandboxRunner.isAlive({ sandboxId: timeoutSandbox }).catch(() => false),
    orphan: await sandboxRunner.isAlive({ sandboxId: orphanSandbox }).catch(() => false),
    live: await sandboxRunner.isAlive({ sandboxId: liveSandbox }),
  };

  if (reaped.timeouts !== 1 || reaped.orphans !== 1) {
    throw new Error(`expected timeout=1 orphan=1, got ${JSON.stringify(reaped)}`);
  }
  if (statusOf(timeoutJobId) !== "timeout") throw new Error(`timeout job status=${statusOf(timeoutJobId)}`);
  if (statusOf(orphanJobId) !== "orphan") throw new Error(`orphan job status=${statusOf(orphanJobId)}`);
  if (statusOf(liveJobId) !== "running") throw new Error(`live job must stay running, got ${statusOf(liveJobId)}`);
  if (leftoverTimeout.length + leftoverOrphan.length !== 0) {
    throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${[...leftoverTimeout, ...leftoverOrphan].map((item) => item.resourceId).join(",")}`);
  }
  if (leftoverLive.length !== 1 || !aliveAfter.live) {
    throw new Error(`live sandbox must survive reap: leftover=${leftoverLive.length} alive=${aliveAfter.live}`);
  }
  if (aliveAfter.timeout || aliveAfter.orphan) {
    throw new Error(`reaped sandboxes must be dead: ${JSON.stringify(aliveAfter)}`);
  }
  console.log(`OK: OpenSandbox reaper timeout=1 orphan=1 live=1 leftover=0 aliveAfter=${JSON.stringify(aliveAfter)}`);
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
