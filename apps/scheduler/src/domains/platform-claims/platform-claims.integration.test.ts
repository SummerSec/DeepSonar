import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("platform claims pause integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("#740 platform claims pause is persistent, replica-wide, drain-aware and audited", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_platform_claims_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

    process.env.DATABASE_URL = targetUrl.toString();
    process.env.AGENT_MODE = "fake";

    const Fastify = (await import("fastify")).default;
    const websocket = (await import("@fastify/websocket")).default;
    const { migrate, sql } = await import("../../db.js");
    const { registerRoutes } = await import("../../routes.js");
    const { claimPendingJobs } = await import("../../dispatcher.js");
    const { DISPATCH_CLAIM_ADVISORY_KEY } = await import("../../core.js");
    // A second connection pool stands in for another Scheduler replica / restarted process.
    const replicaSql = postgres(targetUrl.toString(), { max: 2 });
    await migrate();

    const app = Fastify();
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const canvasId = randomUUID();
    const pendingId = randomUUID();
    const claimedId = randomUUID();
    const runningId = randomUUID();
    const attemptId = randomUUID();
    let stopListening: (() => Promise<void>) | null = null;

    const status = async () => {
      const response = await app.inject({ method: "GET", url: "/platform/claims" });
      assert.equal(response.statusCode, 200, response.payload);
      return response.json();
    };
    const pause = (payload: unknown) =>
      app.inject({ method: "POST", url: "/platform/claims/pause", payload: payload as never });
    const resume = (payload: unknown = {}) =>
      app.inject({ method: "POST", url: "/platform/claims/resume", payload: payload as never });

    try {
      const initial = await status();
      assert.equal(initial.claims_paused, false);
      assert.equal(initial.state, "running");
      assert.equal(initial.reason, null);

      const [rulesRow] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
      await sql`
        UPDATE global_settings SET rules_json = ${sql.json({
          ...(rulesRow?.rules_json ?? {}) as Record<string, unknown>,
          maxGlobalJobs: 8,
          maxJobsPerProject: 8,
          maxConcurrentProvisioning: 8,
        } as never)}
        WHERE id = 'global'`;
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, ${`issue-740-${randomUUID()}`})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'platform claims', '{}'::jsonb)`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, agent_snapshot_json)
        VALUES
          (${pendingId}, ${projectId}, ${canvasId}, 'explore', 'pending', 0, '{}'::jsonb),
          (${claimedId}, ${projectId}, NULL, 'explore', 'claimed', 0, '{}'::jsonb),
          (${runningId}, ${projectId}, NULL, 'explore', 'running', 0, '{}'::jsonb)`;
      await sql`
        INSERT INTO job_attempts (id, job_id, attempt_no, status)
        VALUES (${attemptId}, ${runningId}, 1, 'active')`;
      await sql`
        INSERT INTO job_attempt_effects (attempt_id, job_id, effect_id, effect_kind, status)
        VALUES (${attemptId}, ${runningId}, 'provision', 'sandbox_provision', 'effect_pending')`;

      // Pause linearizes behind an in-flight claim transaction (same advisory key).
      let pauseSettled = false;
      let releaseClaimLock!: () => void;
      const claimLockReleased = new Promise<void>((resolve) => { releaseClaimLock = resolve; });
      let lockHeld!: () => void;
      const lockAcquired = new Promise<void>((resolve) => { lockHeld = resolve; });
      const heldClaim = replicaSql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
        lockHeld();
        await claimLockReleased;
      });
      await lockAcquired;
      const pausing = pause({ reason: "platform_upgrade", note: "upgrade to v0.6.0" }).then((response) => {
        pauseSettled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(pauseSettled, false, "pause must wait for a claim transaction holding the dispatch lock");
      releaseClaimLock();
      await heldClaim;
      const firstPause = await pausing;
      assert.equal(firstPause.statusCode, 200, firstPause.payload);
      const paused = firstPause.json();
      assert.equal(paused.changed, true);
      assert.equal(paused.claims_paused, true);
      assert.equal(paused.reason, "platform_upgrade");
      assert.equal(paused.note, "upgrade to v0.6.0");
      assert.equal(paused.paused_by, "internal:internal");
      assert.equal(paused.state, "pausing");
      assert.equal(paused.drained, false);
      assert.deepEqual(paused.in_flight, { claimed: 1, provisioning: 0, running: 1, total: 2 });
      assert.equal(paused.pending, 1);
      assert.equal(paused.effect_pending_attempts, 1);
      assert.equal(paused.unknown_effect_attempts, 0);

      const [replicaView] = await replicaSql`
        SELECT claims_paused, claims_pause_reason FROM global_settings WHERE id = 'global'`;
      assert.equal(replicaView.claims_paused, true, "another replica must observe the committed pause");
      assert.equal(replicaView.claims_pause_reason, "platform_upgrade");

      const pausedClaims = await Promise.all([claimPendingJobs(), claimPendingJobs()]);
      assert.equal(pausedClaims.flat().length, 0, "no replica may claim while platform claims are paused");
      const [stillPending] = await sql`SELECT status FROM jobs WHERE id = ${pendingId}`;
      assert.equal(stillPending.status, "pending", "queued work stays durable while paused");

      const duplicate = await pause({ reason: "platform_upgrade" });
      assert.equal(duplicate.statusCode, 200);
      assert.equal(duplicate.json().changed, false);
      assert.equal(duplicate.json().paused_at, paused.paused_at, "idempotent pause keeps original metadata");
      assert.equal(duplicate.json().note, "upgrade to v0.6.0");

      const conflicting = await pause({ reason: "maintenance" });
      assert.equal(conflicting.statusCode, 409);
      assert.equal(conflicting.json().error_code, "PLATFORM_CLAIMS_ALREADY_PAUSED");
      assert.equal(conflicting.json().current_reason, "platform_upgrade");

      for (const payload of [{}, { reason: "nope" }, { reason: "maintenance", extra: true }, { reason: "maintenance", note: "" }]) {
        const invalid = await pause(payload);
        assert.equal(invalid.statusCode, 400, JSON.stringify(payload));
        assert.equal(invalid.json().error_code, "PLATFORM_CLAIMS_INVALID_BODY");
      }

      // Ordinary global rules writes must not clear the pause.
      const patched = await app.inject({
        method: "PATCH",
        url: "/global-settings",
        payload: { rules: { maxGlobalJobs: 9 } },
      });
      assert.equal(patched.statusCode, 200, patched.payload);
      assert.equal((await status()).claims_paused, true);

      // The schema forbids an incoherent pause row.
      await assert.rejects(
        sql`UPDATE global_settings SET claims_pause_reason = 'other' WHERE id = 'global'`,
        /global_settings_claims_pause_check/,
      );
      await assert.rejects(
        sql`UPDATE global_settings SET claims_paused = false WHERE id = 'global'`,
        /global_settings_claims_pause_check/,
      );

      const audits = await sql`
        SELECT action, after_json FROM audit_logs
        WHERE action IN ('platform.claims_pause', 'platform.claims_resume')
        ORDER BY id`;
      assert.deepEqual(audits.map((row) => row.action), ["platform.claims_pause"]);
      assert.equal(audits[0].after_json.reason, "platform_upgrade");

      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id IN (${claimedId}, ${runningId})`;
      const stillEffect = await status();
      assert.equal(stillEffect.in_flight.total, 0);
      assert.equal(stillEffect.state, "pausing", "an unsettled external effect blocks the drained state");
      // Closing an Attempt is not evidence that its external effects settled.
      // Count Attempts, not effect rows, and keep both unresolved categories visible.
      await sql`
        INSERT INTO job_attempt_effects (attempt_id, job_id, effect_id, effect_kind, status)
        VALUES
          (${attemptId}, ${runningId}, 'run', 'agent_run', 'effect_pending'),
          (${attemptId}, ${runningId}, 'cleanup', 'sandbox_destroy', 'unknown')`;
      for (const terminalStatus of ["succeeded", "failed", "cancelled", "timeout", "orphan", "interrupted", "unknown"]) {
        await sql`UPDATE job_attempts SET status = ${terminalStatus}, finished_at = now() WHERE id = ${attemptId}`;
        const unresolved = await status();
        assert.equal(unresolved.in_flight.total, 0);
        assert.equal(unresolved.effect_pending_attempts, 1, terminalStatus);
        assert.equal(unresolved.unknown_effect_attempts, 1, terminalStatus);
        assert.equal(unresolved.state, "pausing", terminalStatus);
        assert.equal(unresolved.drained, false, terminalStatus);
      }
      await sql`
        UPDATE job_attempt_effects SET status = 'settled', settled_at = now()
        WHERE attempt_id = ${attemptId} AND status = 'effect_pending'`;
      const unknownOnly = await status();
      assert.equal(unknownOnly.effect_pending_attempts, 0);
      assert.equal(unknownOnly.unknown_effect_attempts, 1);
      assert.equal(unknownOnly.drained, false, "unknown effects alone still block drain");
      await sql`
        UPDATE job_attempt_effects SET status = 'settled', settled_at = now()
        WHERE attempt_id = ${attemptId}`;
      await sql`UPDATE job_attempts SET status = 'succeeded', finished_at = now() WHERE id = ${attemptId}`;
      const drained = await status();
      assert.equal(drained.state, "paused");
      assert.equal(drained.drained, true);
      assert.equal(drained.pending, 1);

      const mismatch = await resume({ reason: "maintenance" });
      assert.equal(mismatch.statusCode, 409);
      assert.equal(mismatch.json().error_code, "PLATFORM_CLAIMS_PAUSE_REASON_MISMATCH");
      assert.equal((await status()).claims_paused, true);

      let resumeNotified = false;
      let resolveNotification!: () => void;
      const notification = new Promise<void>((resolve) => { resolveNotification = resolve; });
      const listener = await replicaSql.listen("deepsonar_jobs", (payload) => {
        if (payload === "platform-claims-resumed") {
          resumeNotified = true;
          resolveNotification();
        }
      });
      stopListening = () => listener.unlisten();

      const resumed = await resume({ reason: "platform_upgrade" });
      assert.equal(resumed.statusCode, 200, resumed.payload);
      assert.equal(resumed.json().changed, true);
      assert.equal(resumed.json().claims_paused, false);
      assert.equal(resumed.json().state, "running");
      assert.equal(resumed.json().paused_by, null);
      await Promise.race([notification, new Promise<void>((resolve) => setTimeout(resolve, 1_500))]);
      assert.equal(resumeNotified, true, "resume must wake every replica's dispatch loop");

      const again = await resume();
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().changed, false);

      const resumedClaims = await Promise.all([claimPendingJobs(), claimPendingJobs()]);
      assert.equal(
        resumedClaims.flat().filter((row) => row.id === pendingId).length,
        1,
        "the queued Job is claimed exactly once after resume",
      );

      const resumeAudits = await sql`
        SELECT action FROM audit_logs
        WHERE action IN ('platform.claims_pause', 'platform.claims_resume')
        ORDER BY id`;
      assert.deepEqual(resumeAudits.map((row) => row.action), ["platform.claims_pause", "platform.claims_resume"]);

      // Missing singleton row fails closed: no claims, mutations refuse.
      const secondPendingId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, agent_snapshot_json)
        VALUES (${secondPendingId}, ${projectId}, ${canvasId}, 'explore', 'pending', 0, '{}'::jsonb)`;
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${pendingId}`;
      await sql`DELETE FROM global_settings WHERE id = 'global'`;
      assert.deepEqual(await claimPendingJobs(), []);
      const missing = await pause({ reason: "maintenance" });
      assert.equal(missing.statusCode, 503);
      assert.equal(missing.json().error_code, "PLATFORM_CLAIMS_STATE_MISSING");
      assert.equal((await status()).claims_paused, true, "missing state is reported as paused");
    } finally {
      if (stopListening) await stopListening().catch(() => undefined);
      await app.close().catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await replicaSql.end({ timeout: 5 }).catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
