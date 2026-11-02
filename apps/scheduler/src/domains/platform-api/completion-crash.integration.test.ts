// #835 item 1: a real Scheduler process must die at a persistence window and a fresh
// process must rebuild the durable state. Unlike completion.integration.test.ts this
// suite kills an actual child process, so an in-memory idempotency cache cannot hide a
// missing durable write.
//
// Windows exercised: the completion receipt is committed, the process is SIGKILLed
// before the response is written, and a second process replays the same idempotency key.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

// Absolute so the child starts correctly regardless of the workspace cwd the runner uses.
const FIXTURE = fileURLToPath(new URL("./crash-server.fixture.ts", import.meta.url));

const freePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, "close");
  return port;
};

interface Child { child: ReturnType<typeof spawn>; port: number; ready: Promise<void> }

async function startChild(env: Record<string, string | undefined>): Promise<Child> {
  const port = await freePort();
  const child = spawn("pnpm", ["exec", "tsx", FIXTURE], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not become ready: ${stderr}`)), 60_000);
    child.stdout?.on("data", chunk => {
      if (chunk.toString().includes("READY")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`child exited early (${code ?? signal}): ${stderr}`)); });
  });
  return { child, port, ready };
}

const post = (port: number, jobId: string, token: string, key: string, payload: unknown) =>
  fetch(`http://127.0.0.1:${port}/control/v1/jobs/${jobId}/operations/mark_job_done`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "x-deepsonar-proposal-revision": "0", "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });

test("a killed Scheduler process leaves a replayable durable completion (#835)", { skip: !databaseUrl }, async () => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `crash_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${name}`;
  const children: Child[] = [];
  const [{ sql, migrate }, api, { createAttempt }] = await Promise.all([
    import("../../db.js"), import("./index.js"), import("../job-attempt/application.js"),
  ]);
  try {
    // The parent process points at the same isolated database the children use.
    process.env.DATABASE_URL = url.toString();
    await migrate();
    const projectId = randomUUID(), jobId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'crash test')`;
    await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
      VALUES(${jobId},${projectId},'audit','running',${sql.json({ name: "audit", platform_tools: ["mark_job_done"] })},now(),3600,now()+interval '1 hour')`;
    await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
    const grant = await api.mintJobCapabilityToken(jobId);
    const key = randomUUID();
    const payload = { summary: "The process dies after the receipt is durable." };

    const first = await startChild({ DATABASE_URL: url.toString(), JOB_ID: jobId, TOKEN: grant.token, MODE: "crash" });
    children.push(first);
    await first.ready;
    const pending = post(first.port, jobId, grant.token, key, payload).catch(() => "no response");
    const exited = once(first.child, "exit");
    const [code, signal] = await exited as [number | null, NodeJS.Signals | null];
    await pending;
    assert.equal(signal, "SIGKILL", `the crash window must be a real SIGKILL, got ${code ?? signal}`);

    // Durable truth before any restart: the receipt exists and names one semantic event.
    const [receipt] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${jobId} AND type='control_receipt'`;
    assert.equal(receipt.count, 1, "an accepted receipt must survive the process that wrote it");
    const [doneEvents] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${jobId} AND type='control_receipt' AND payload_json->>'status'='persisted_deferred'`;
    assert.equal(doneEvents.count, 1);

    const second = await startChild({ DATABASE_URL: url.toString(), JOB_ID: jobId, TOKEN: grant.token, MODE: "replay" });
    children.push(second);
    await second.ready;
    const replay = await post(second.port, jobId, grant.token, key, payload);
    assert.equal(replay.status, 200, await replay.text());
    // SAFETY: the Control API answers with the receipt envelope this suite asserts on;
    // only the fields below are read and both are string comparisons.
    const body = (await replay.json()) as { receipt_status?: string; idempotency_key?: string };
    assert.equal(body.receipt_status, "persisted_deferred", "the restarted process serves the persisted receipt");
    assert.equal(body.idempotency_key, key);

    const after = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${jobId} AND type='control_receipt'`;
    assert.equal(after.count, 1, "a replayed completion must not add a second durable receipt");
    const [job] = await sql`SELECT status FROM jobs WHERE id=${jobId}`;
    assert.equal(job.status, "running", "the crash must not flip the Job terminal on its own");
    const [attempt] = await sql`SELECT count(*)::int AS count FROM job_attempts WHERE job_id=${jobId}`;
    assert.equal(attempt.count, 1, "a restart must not mint a second attempt");
  } finally {
    for (const entry of children) entry.child.kill("SIGKILL");
    process.env.DATABASE_URL = databaseUrl;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});