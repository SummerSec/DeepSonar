import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";

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
        INSERT INTO projects (id, name)
        VALUES (${projectId}, 'job-lifecycle integration')`;
      await sql`
        INSERT INTO canvases (id, project_id, title)
        VALUES (${canvasId}, ${projectId}, 'job-lifecycle integration')`;

    const insertJob = async (status: string) => {
        const id = randomUUID();
        jobIds.push(id);
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${id}, ${projectId}, ${canvasId}, 'audit', ${status}, ${sql.json(snapshot as never)})`;
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
      const heartbeatGuardId = await insertJob("running");
      await sql`
        UPDATE jobs
        SET lease_expires_at = now() - interval '10 seconds',
            heartbeat_at = now() - interval '1 second'
        WHERE id = ${heartbeatGuardId}`;
      const eventGuardId = await insertJob("running");
      await sql`
        UPDATE jobs SET lease_expires_at = now() - interval '10 seconds'
        WHERE id = ${eventGuardId}`;
      await sql`
        INSERT INTO events (job_id, event_id, job_seq, type, payload_json, created_at)
        VALUES (
          ${eventGuardId}, ${randomUUID()}, 1, 'progress',
          ${sql.json({ message: "tool.call.started bash" } as never)},
          now() - interval '1 second'
        )`;
      const orphans = await app.reapLeaseOrphans();
      const orphanedIds = new Set(orphans.map((row) => row.id));
      assert.equal((await app.reapExecutionTimeout()).some((row) => row.id === timeoutId), true);
      assert.equal((await app.reapProvisionTimeout(1)).some((row) => row.id === provisionId), true);
      assert.equal(orphanedIds.has(orphanId), true, "expired lease without heartbeat or events is orphaned");
      assert.equal(orphanedIds.has(heartbeatGuardId), false, "fresh heartbeat after expired lease is kept");
      assert.equal(orphanedIds.has(eventGuardId), false, "fresh event after expired lease is kept");
      const [keptHeartbeat] = await sql`SELECT status FROM jobs WHERE id = ${heartbeatGuardId}`;
      const [keptEvent] = await sql`SELECT status FROM jobs WHERE id = ${eventGuardId}`;
      assert.equal(keptHeartbeat.status, "running");
      assert.equal(keptEvent.status, "running");

      const waitingFreshId = await insertJob("waiting_human");
      await sql`
        INSERT INTO events (job_id, event_id, job_seq, type, payload_json, created_at)
        VALUES (
          ${waitingFreshId}, ${randomUUID()}, 1, 'human',
          ${sql.json({ reason: "需要授权" } as never)},
          now() - interval '1 second'
        )`;
      const waitingStaleId = await insertJob("waiting_human");
      await sql`
        INSERT INTO events (job_id, event_id, job_seq, type, payload_json, created_at)
        VALUES (
          ${waitingStaleId}, ${randomUUID()}, 1, 'human',
          ${sql.json({ reason: "需要授权" } as never)},
          now() - interval '10 seconds'
        )`;
      assert.equal((await app.reapWaitingHumanTimeout(0)).length, 0, "0 disables waiting_human timeout");
      const [keptFreshBefore] = await sql`SELECT status FROM jobs WHERE id = ${waitingFreshId}`;
      assert.equal(keptFreshBefore.status, "waiting_human");
      const humanTimedOut = await app.reapWaitingHumanTimeout(2);
      const humanTimedOutIds = new Set(humanTimedOut.map((row) => row.id));
      assert.equal(humanTimedOutIds.has(waitingStaleId), true, "stale waiting_human is failed after independent budget");
      assert.equal(humanTimedOutIds.has(waitingFreshId), false, "fresh human event is kept");
      const [staleHuman] = await sql`SELECT status, error FROM jobs WHERE id = ${waitingStaleId}`;
      const [freshHuman] = await sql`SELECT status FROM jobs WHERE id = ${waitingFreshId}`;
      assert.equal(staleHuman.status, "failed");
      assert.match(String(staleHuman.error), /人工等待超时/);
      assert.equal(freshHuman.status, "waiting_human");

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

      const insertRunning = async (imageKey: string | null, extra?: { payload?: Record<string, unknown> }) => {
        const id = randomUUID();
        jobIds.push(id);
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, started_at, lease_expires_at, agent_snapshot_json, payload_json)
          VALUES (
            ${id}, ${projectId}, ${canvasId}, 'audit', 'running',
            now() - interval '1000 seconds', now() + interval '60 seconds',
            ${sql.json({
              ...snapshot,
              ...(imageKey ? { runtime_image: { image_key: imageKey } } : {}),
            } as never)},
            ${sql.json((extra?.payload ?? {}) as never)}
          )`;
        return id;
      };

      const silentAudit = await insertRunning("deepsonar-audit");
      const chromeAuditTool = await insertRunning("deepsonar-chrome-audit");
      await sql`
        INSERT INTO events (job_id, event_id, job_seq, type, payload_json, created_at)
        VALUES (
          ${chromeAuditTool}, ${randomUUID()}, 1, 'progress',
          ${sql.json({ message: "tool.call.started Bash" } as never)},
          now() - interval '1000 seconds'
        )`;
      const chromeFuzzInflight = await insertRunning("deepsonar-chrome-fuzz", {
        payload: { runtime_activity: { inflight_tool: "Bash", phase: "started" } },
      });
      const silentChromeNoTool = await insertRunning("deepsonar-chrome-audit");
      const longToolAudit = await insertRunning("deepsonar-audit", {
        payload: { runtime_activity: { inflight_tool: "Bash", phase: "started" } },
      });

      const stalled = await app.reapStalledExecution(900);
      const stalledIds = new Set(stalled.map((row) => row.id));
      assert.equal(stalledIds.has(silentAudit), true, "silent non-chrome job is reaped after 900s");
      assert.equal(stalledIds.has(chromeAuditTool), false, "chrome-audit with stale tool.call.started + live lease is kept");
      assert.equal(stalledIds.has(chromeFuzzInflight), false, "chrome-fuzz with in-flight tool + live lease is kept");
      assert.equal(stalledIds.has(silentChromeNoTool), false, "chrome-audit uses the 5400s stall floor");
      assert.equal(stalledIds.has(longToolAudit), false, "non-chrome in-flight tool + live lease is kept");

      const [silentRow] = await sql`SELECT status, error FROM jobs WHERE id = ${silentAudit}`;
      assert.equal(silentRow.status, "failed");
      assert.match(String(silentRow.error), /产出停滞/);

      const { expireDanglingHumanNodes } = await import("../canvas/human-node-expire.js");
      // cancelJobsOnCanvas 会收走 waitingFreshId；live 请求必须绑一条仍为 waiting_human 的 Job。
      const liveWaitingJob = await insertJob("waiting_human");
      const deadJob = waitingStaleId;
      const liveFindingId = randomUUID();
      const deadFindingId = randomUUID();
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES
          (${liveFindingId}, ${projectId}, ${liveWaitingJob}, ${`live-${liveFindingId}`}, '仍需人', 'high', 'needs_human'),
          (${deadFindingId}, ${projectId}, ${deadJob}, ${`dead-${deadFindingId}`}, '已自动收口', 'high', 'inconclusive')`;
      const liveRequestId = randomUUID();
      const deadRequestId = randomUUID();
      const liveBlockerId = randomUUID();
      const deadBlockerId = randomUUID();
      const commentId = randomUUID();
      const danglingId = randomUUID();
      const ignoredId = randomUUID();
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, job_id, node_type, title, status, body_json)
        VALUES
          (${liveRequestId}, ${canvasId}, ${liveWaitingJob}, 'human', '仍在等人', 'open', ${sql.json({ reason: "需要授权" } as never)}),
          (${deadRequestId}, ${canvasId}, ${deadJob}, 'human', 'Job 已失败', 'open', ${sql.json({ reason: "需要授权" } as never)}),
          (${liveBlockerId}, ${canvasId}, null, 'human', '验证阻塞', 'open', ${sql.json({ kind: "verification_blocker", finding_id: liveFindingId } as never)}),
          (${deadBlockerId}, ${canvasId}, null, 'human', '预算 blocker', 'open', ${sql.json({ kind: "verification_blocker", finding_id: deadFindingId } as never)}),
          (${commentId}, ${canvasId}, null, 'human', '评论投影', 'open', ${sql.json({ kind: "finding_comment", finding_id: liveFindingId } as never)}),
          (${danglingId}, ${canvasId}, null, 'human', '脱钩垃圾', 'open', ${sql.json({ reason: "环境说明" } as never)}),
          (${ignoredId}, ${canvasId}, ${deadJob}, 'human', '人已忽略', 'ignored', ${sql.json({ resolution: "ignored" } as never)})`;
      const expiredCount = await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        return expireDanglingHumanNodes(tx, canvasId);
      });
      assert.equal(expiredCount, 3);
      const statuses = Object.fromEntries(
        (await sql`
          SELECT id, status, body_json->>'expired_reason' AS expired_reason
          FROM canvas_nodes
          WHERE id = ANY(${[liveRequestId, deadRequestId, liveBlockerId, deadBlockerId, commentId, danglingId, ignoredId]})
        `).map((row) => [String(row.id), { status: String(row.status), reason: row.expired_reason ? String(row.expired_reason) : null }]),
      );
      assert.deepEqual(statuses[liveRequestId], { status: "open", reason: null });
      assert.deepEqual(statuses[deadRequestId], { status: "expired", reason: "job_not_waiting_human" });
      assert.deepEqual(statuses[liveBlockerId], { status: "open", reason: null });
      assert.deepEqual(statuses[deadBlockerId], { status: "expired", reason: "finding_not_needs_human" });
      assert.deepEqual(statuses[commentId], { status: "open", reason: null });
      assert.deepEqual(statuses[danglingId], { status: "expired", reason: "dangling_human_node" });
      assert.deepEqual(statuses[ignoredId], { status: "ignored", reason: null });
      const [liveFinding] = await sql`SELECT verify_status FROM findings WHERE id = ${liveFindingId}`;
      assert.equal(liveFinding.verify_status, "needs_human");
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM events WHERE job_id = ANY(${jobIds})`;
      await sql`DELETE FROM jobs WHERE id = ANY(${jobIds})`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  });
}
