import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Job lifecycle integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("Job lifecycle CAS, recovery exceptions, metadata, and bulk cancellation", async () => {
    // Install the explicit URL before importing config/db so a local .env can
    // never redirect this integration run to a shared scheduler database.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { createSqlJobLifecycleApplication } = await import("./application.js");
    const { createAttempt } = await import("../job-attempt/application.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `job-lifecycle-${randomUUID()}`;
    const app = createSqlJobLifecycleApplication(sql);
    const jobIds: string[] = [];
    const snapshot = { agent_cli: "claude-code", credential_provider: "", credential_id: null, model: "" };

    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${projectId}, ${canvasId}, 'job-lifecycle integration')`;
      await sql`
        INSERT INTO canvases (id, project_id, title)
        VALUES (${canvasId}, ${projectId}, 'job-lifecycle integration')`;

    const insertJob = async (status: string) => {
        const id = randomUUID();
        jobIds.push(id);
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${id}, ${projectId}, ${canvasId}, 'audit_module', ${status}, ${sql.json(snapshot as never)})`;
        return id;
      };

      const claimId = await insertJob("pending");
      const claimed = await Promise.all([app.claimPendingJob(claimId), app.claimPendingJob(claimId)]);
      assert.equal(claimed.filter(Boolean).length, 1, "one concurrent claim must lose the pending CAS");
      const [claimedRow] = await sql`SELECT status, claimed_at FROM jobs WHERE id = ${claimId}`;
      assert.equal(claimedRow.status, "claimed");
      assert.ok(claimedRow.claimed_at);

      await sql`UPDATE jobs SET status = 'provisioning' WHERE id = ${claimId}`;
      const startedAt = new Date(Date.now() - 1_000);
      const running = await app.transitionJob(claimId, "running", {
        started_at: startedAt,
        lease_expires_at: new Date(Date.now() + 60_000),
      });
      assert.equal(running?.status, "running");
      assert.equal(await app.transitionJob(claimId, "running"), null, "duplicate transition is a no-op");

      const failed = await app.failExecution(claimId, "executor fixture failure");
      assert.equal(failed?.id, claimId);
      const [failedRow] = await sql`SELECT status, finished_at, error FROM jobs WHERE id = ${claimId}`;
      assert.deepEqual(
        { status: failedRow.status, error: failedRow.error },
        { status: "failed", error: "executor fixture failure" },
      );
      assert.ok(failedRow.finished_at);

      const timeoutId = await insertJob("running");
      await sql`
        UPDATE jobs SET started_at = now() - interval '10 seconds', timeout_sec = 1
        WHERE id = ${timeoutId}`;
      const provisionId = await insertJob("provisioning");
      await sql`
        UPDATE jobs SET claimed_at = now() - interval '10 seconds'
        WHERE id = ${provisionId}`;
      const orphanId = await insertJob("running");
      await sql`
        UPDATE jobs SET lease_expires_at = now() - interval '10 seconds'
        WHERE id = ${orphanId}`;
      assert.equal((await app.reapExecutionTimeout()).some((row) => row.id === timeoutId), true);
      assert.equal((await app.reapProvisionTimeout(1)).some((row) => row.id === provisionId), true);
      assert.equal((await app.reapLeaseOrphans()).some((row) => row.id === orphanId), true);

      const resetClaimed = await insertJob("claimed");
      const resetProvision = await insertJob("provisioning");
      const safeRequeue = await insertJob("provisioning");
      await createAttempt(sql, safeRequeue, { agent_cli: "claude-code" });
      const reset = await app.reconcileProvisioning();
      assert.deepEqual(new Set(reset.requeued.map((row) => row.id)), new Set([safeRequeue]));
      assert.deepEqual(new Set(reset.orphaned.map((row) => row.id)), new Set([resetClaimed, resetProvision]));
      const [resetRow] = await sql`SELECT status, claimed_at, lease_expires_at FROM jobs WHERE id = ${resetClaimed}`;
      assert.deepEqual(
        { status: resetRow.status, claimed_at: resetRow.claimed_at, lease_expires_at: resetRow.lease_expires_at },
        { status: "orphan", claimed_at: null, lease_expires_at: null },
      );

      const bootRunningId = await insertJob("running");
      const bootOrphaned = await app.reconcileRunning();
      assert.equal(bootOrphaned.some((row) => row.id === bootRunningId), true);
      const [bootRow] = await sql`SELECT status, error FROM jobs WHERE id = ${bootRunningId}`;
      assert.deepEqual(
        { status: bootRow.status, error: bootRow.error },
        { status: "orphan", error: "调度器重启（执行中断）" },
      );

      const runtimeVersionId = randomUUID();
      const runtimeImageJob = await insertJob("running");
      await sql`
        UPDATE jobs SET agent_snapshot_json = ${sql.json({
          ...snapshot,
          runtime_image: { runtime_image_version_id: runtimeVersionId },
        } as never)}
        WHERE id = ${runtimeImageJob}`;
      const imageCancelled = await app.cancelJobsForRuntimeImageVersion(runtimeVersionId, "image revoked");
      assert.deepEqual(imageCancelled.map((row) => row.id), [runtimeImageJob]);
      const [imageRow] = await sql`SELECT status, error FROM jobs WHERE id = ${runtimeImageJob}`;
      assert.deepEqual({ status: imageRow.status, error: imageRow.error }, { status: "cancelled", error: "image revoked" });
      assert.deepEqual(await app.cancelJobsForRuntimeImageVersion(runtimeVersionId, "late revoke"), []);

      const cancelA = await insertJob("pending");
      const cancelB = await insertJob("running");
      const cancelled = await app.cancelJobsOnCanvas(canvasId, "bulk fixture cancel");
      const cancelledIds = new Set(cancelled.map((row) => row.id));
      assert.equal(cancelledIds.has(cancelA), true);
      assert.equal(cancelledIds.has(cancelB), true);
      const [cancelledRow] = await sql`SELECT status, error, lease_expires_at, heartbeat_at FROM jobs WHERE id = ${cancelB}`;
      assert.deepEqual(
        {
          status: cancelledRow.status,
          error: cancelledRow.error,
          lease_expires_at: cancelledRow.lease_expires_at,
          heartbeat_at: cancelledRow.heartbeat_at,
        },
        { status: "cancelled", error: "bulk fixture cancel", lease_expires_at: null, heartbeat_at: null },
      );
      assert.equal(await app.cancelJob(cancelA, "late cancel"), null, "cancelled Job is a no-op");
      assert.deepEqual(await app.cancelJobsOnCanvas(canvasId, "late bulk cancel"), [], "bulk cancel is a zero-row no-op");
    } finally {
      await sql`DELETE FROM jobs WHERE id = ANY(${jobIds})`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  });
}
