import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Task hard delete with knowledge references (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  // #904: DELETE /tasks/:canvasId returned 500 when a job had project_knowledge_usages
  // rows. Runtime usage/lease records belong to the task and are cleaned with it;
  // knowledge work/versions are governance evidence (#752) and must be refused up front,
  // before any job is cancelled, so a 409 really means nothing ran.
  test("DELETE /tasks/:canvasId clears runtime knowledge usage and refuses retained governance records", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_task_delete_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

    process.env.DATABASE_URL = targetUrl.toString();
    process.env.AGENT_MODE = "fake";
    process.env.DEEPSONAR_AUTH_REQUIRED = "true";
    process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);

    const Fastify = (await import("fastify")).default;
    const websocket = (await import("@fastify/websocket")).default;
    const { migrate, sql } = await import("./db.js");
    const { registerRoutes } = await import("./routes.js");
    const { generateToken } = await import("./auth.js");
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    try {
      const token = generateToken();
      await sql`INSERT INTO api_tokens(name,token_prefix,token_hash,scopes)
        VALUES ('task delete',${token.prefix},${token.hash},${["tasks:write", "tasks:read"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'task-delete-knowledge')`;

      const seedJob = async (canvasId: string, status = "failed", sandboxId: string | null = null) => {
        const jobId = randomUUID();
        const attemptId = randomUUID();
        await sql`INSERT INTO canvases (id, project_id, title, target_json)
          VALUES (${canvasId}, ${projectId}, 'Delete me', ${sql.json({ network_policy: { allow_egress: false } })})`;
        await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, sandbox_id, agent_snapshot_json)
          VALUES (${jobId}, ${projectId}, ${canvasId}, 'explore', ${status}, ${sandboxId}, ${sql.json({})})`;
        // The lifecycle application validates the attempt's total state identity, so the
        // fixture supplies a well-formed state_json instead of the '{}' default.
        await sql`INSERT INTO job_attempts (id, job_id, attempt_no, status, phase, sandbox_id, state_json)
          VALUES (${attemptId}, ${jobId}, 1, ${status === "failed" ? "failed" : "active"}, ${status === "failed" ? "preparing" : "agent.ready"}, ${sandboxId},
            ${sql.json({ version: 1, attempt_id: attemptId, job_id: jobId })})`;
        return { jobId, attemptId, canvasId };
      };

      // 1. A job that pulled knowledge: the usage row must not block the delete.
      const withUsage = await seedJob(randomUUID());
      await sql`INSERT INTO project_knowledge_usages (project_id, job_id, attempt_id, selector, content_sha256)
        VALUES (${projectId}, ${withUsage.jobId}, ${withUsage.attemptId}, 'project:all', ${"a".repeat(64)})`;
      const deleted = await app.inject({ method: "DELETE", url: `/tasks/${withUsage.canvasId}`, headers });
      assert.equal(deleted.statusCode, 200, deleted.payload);
      const [usageLeft] = await sql`SELECT count(*)::int AS count FROM project_knowledge_usages WHERE job_id = ${withUsage.jobId}`;
      assert.equal(Number(usageLeft.count), 0, "runtime usage rows are cleaned with the task");
      const [canvasLeft] = await sql`SELECT count(*)::int AS count FROM canvases WHERE id = ${withUsage.canvasId}`;
      assert.equal(Number(canvasLeft.count), 0);

      // 1b. #904 review: a run that only recorded a knowledge receipt (no work/version)
      //     must also be refused — receipts are immutable evidence and carry NOT NULL
      //     job/attempt references, so deleting the job would have failed on the FK.
      const withReceipt = await seedJob(randomUUID());
      await sql`INSERT INTO project_knowledge_receipts (project_id, job_id, attempt_id, operation, idempotency_key, input_digest, event_id, result_json)
        VALUES (${projectId}, ${withReceipt.jobId}, ${withReceipt.attemptId}, 'record_skill_choice', ${randomUUID()}, ${"c".repeat(64)}, ${randomUUID()}, ${sql.json({ ok: true })})`;
      const refusedReceipt = await app.inject({ method: "DELETE", url: `/tasks/${withReceipt.canvasId}`, headers });
      assert.equal(refusedReceipt.statusCode, 409, refusedReceipt.payload);
      assert.equal(refusedReceipt.json().retained.receipts, 1);
      const [receiptKept] = await sql`SELECT count(*)::int AS count FROM project_knowledge_receipts WHERE job_id = ${withReceipt.jobId}`;
      assert.equal(Number(receiptKept.count), 1);

      // 1c. Device lease history is append-only audit: deleting a task must not erase it.
      const withLease = await seedJob(randomUUID());
      const deviceId = randomUUID();
      await sql`INSERT INTO devices (id, project_id, key, transport) VALUES (${deviceId}, ${projectId}, 'pixel-1', 'adb')`;
      await sql`INSERT INTO device_leases (device_id, job_id, project_id, state, released_at)
        VALUES (${deviceId}, ${withLease.jobId}, ${projectId}, 'released', now())`;
      const refusedLease = await app.inject({ method: "DELETE", url: `/tasks/${withLease.canvasId}`, headers });
      assert.equal(refusedLease.statusCode, 409, refusedLease.payload);
      assert.equal(refusedLease.json().retained.device_leases, 1);
      const [leaseKept] = await sql`SELECT count(*)::int AS count FROM device_leases WHERE job_id = ${withLease.jobId}`;
      assert.equal(Number(leaseKept.count), 1, "lease history must survive a task delete attempt");

      // 2. A job that produced knowledge work: deleting the task would destroy
      //    governance evidence, so the API refuses before touching anything.
      const withWork = await seedJob(randomUUID());
      const workId = randomUUID();
      await sql`INSERT INTO project_knowledge_work (id, project_id, origin_job_id, canvas_id, trigger_key, governance_hash)
        VALUES (${workId}, ${projectId}, ${withWork.jobId}, ${withWork.canvasId}, 'delete-guard', ${"b".repeat(64)})`;
      const refused = await app.inject({ method: "DELETE", url: `/tasks/${withWork.canvasId}`, headers });
      assert.equal(refused.statusCode, 409, refused.payload);
      assert.equal(refused.json().error_code, "TASK_DELETE_KNOWLEDGE_RETAINED");
      assert.equal(refused.json().retained.work, 1);
      const [canvasKept] = await sql`SELECT count(*)::int AS count FROM canvases WHERE id = ${withWork.canvasId}`;
      assert.equal(Number(canvasKept.count), 1, "a refusal must leave the task in place");
      const [notCancelled] = await sql`SELECT count(*)::int AS count FROM jobs WHERE id = ${withWork.jobId} AND status = 'failed'`;
      assert.equal(Number(notCancelled.count), 1, "the refusal rolls back, so the job keeps its status");
      const [jobKept] = await sql`SELECT count(*)::int AS count FROM jobs WHERE id = ${withWork.jobId}`;
      assert.equal(Number(jobKept.count), 1);
      const [workKept] = await sql`SELECT count(*)::int AS count FROM project_knowledge_work WHERE id = ${workId}`;
      assert.equal(Number(workKept.count), 1, "governance evidence is never deleted by a task delete");

      // 3. #904 review P1: a task holding a *live* job must not deadlock on the canvas
      //    lock it already owns, and a rolled-back delete must not tear down a runner.
      const destroyed: string[] = [];
      const { runner } = await import("./runtime.js");
      const realDestroy = runner.destroy.bind(runner);
      runner.destroy = async (input: { sandboxId: string }) => {
        destroyed.push(input.sandboxId);
        return realDestroy(input);
      };
      try {
        // 3a. Refusal wins over cancellation: the live job and its sandbox survive.
        const guarded = await seedJob(randomUUID(), "running", "sbx-retained-live");
        await sql`INSERT INTO project_knowledge_work (id, project_id, origin_job_id, canvas_id, trigger_key, governance_hash)
          VALUES (${randomUUID()}, ${projectId}, ${guarded.jobId}, ${guarded.canvasId}, 'delete-guard-live', ${"d".repeat(64)})`;
        const refusedLive = await app.inject({ method: "DELETE", url: `/tasks/${guarded.canvasId}`, headers });
        assert.equal(refusedLive.statusCode, 409, refusedLive.payload);
        assert.deepEqual(destroyed, [], "a refused delete rolls back before touching any sandbox");
        const [liveStillThere] = await sql`SELECT status, sandbox_id FROM jobs WHERE id = ${guarded.jobId}`;
        assert.equal(liveStillThere.status, "running", "the refusal leaves the live job untouched");
        assert.equal(liveStillThere.sandbox_id, "sbx-retained-live");
        const [attemptStillActive] = await sql`SELECT status FROM job_attempts WHERE id = ${guarded.attemptId}`;
        assert.equal(attemptStillActive.status, "active");

        // 3b. Deletable task holding a live job: the request must complete. Before this
        //     fix the cancel phase opened a second connection that waited on the outer
        //     canvas lock, so the whole delete hung until the pool timed out.
        const live = await seedJob(randomUUID(), "running", "sbx-cancel-now");
        const deleteStarted = Date.now();
        const deletedLive = await Promise.race([
          app.inject({ method: "DELETE", url: `/tasks/${live.canvasId}`, headers }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("DELETE /tasks/:canvasId deadlocked past 20s")), 20_000).unref();
          }),
        ]);
        assert.equal(deletedLive.statusCode, 200, deletedLive.payload);
        assert.equal(deletedLive.json().cancelled_jobs, 1);
        assert.ok(Date.now() - deleteStarted < 20_000, "delete must not wait on its own canvas lock");
        assert.deepEqual(destroyed, ["sbx-cancel-now"], "the sandbox is destroyed once, after commit");
        const [canvasLive] = await sql`SELECT count(*)::int AS count FROM canvases WHERE id = ${live.canvasId}`;
        assert.equal(Number(canvasLive.count), 0);
        const [jobLive] = await sql`SELECT count(*)::int AS count FROM jobs WHERE id = ${live.jobId}`;
        assert.equal(Number(jobLive.count), 0);
      } finally {
        runner.destroy = realDestroy;
      }
    } finally {
      await app.close();
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  });
}
