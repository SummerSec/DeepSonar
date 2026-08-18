import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("task execution control integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("pause/start are idempotent, database-authoritative, drain-safe, and schedule-safe", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const Fastify = (await import("fastify")).default;
    const websocket = (await import("@fastify/websocket")).default;
    const { migrate, sql } = await import("./db.js");
    const { registerRoutes } = await import("./routes.js");
    const { claimPendingJobs } = await import("./dispatcher.js");
    await migrate();

    const app = Fastify();
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const scheduledCanvasId = randomUUID();
    const runnableCanvasId = randomUUID();
    const archivedCanvasId = randomUUID();
    const scheduledPendingId = randomUUID();
    const drainingId = randomUUID();
    const waitingHumanId = randomUUID();
    const failedId = randomUUID();
    const orphanId = randomUUID();
    const runnablePendingId = randomUUID();
    const schedule = {
      start_at: "2099-08-20T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      preset: "custom",
    };
    const rulesBefore = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const originalRules = rulesBefore[0]?.rules_json ?? {};

    const post = (canvasId: string, action: "pause" | "start") =>
      app.inject({ method: "POST", url: `/tasks/${canvasId}/${action}` });

    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${projectId}, ${`issue-188-${randomUUID()}`}, ${`issue-188-${randomUUID()}`})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES
          (${scheduledCanvasId}, ${projectId}, 'scheduled drain', ${sql.json({ schedule } as never)}),
          (${runnableCanvasId}, ${projectId}, 'runnable gate', '{}'::jsonb),
          (${archivedCanvasId}, ${projectId}, 'archived gate', ${sql.json({
            execution_control: {
              paused: true,
              paused_at: "2026-08-18T09:00:00.000Z",
              paused_by: "operator",
              reason: "manual_pause",
            },
          } as never)})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, agent_snapshot_json)
        VALUES
          (${scheduledPendingId}, ${projectId}, ${scheduledCanvasId}, 'explore', 'pending', 0, '{}'::jsonb),
          (${drainingId}, ${projectId}, ${scheduledCanvasId}, 'explore', 'running', 0, '{}'::jsonb),
          (${waitingHumanId}, ${projectId}, ${scheduledCanvasId}, 'explore', 'waiting_human', 0, '{}'::jsonb),
          (${failedId}, ${projectId}, ${scheduledCanvasId}, 'explore', 'failed', 0, '{}'::jsonb),
          (${orphanId}, ${projectId}, ${scheduledCanvasId}, 'explore', 'orphan', 0, '{}'::jsonb),
          (${runnablePendingId}, ${projectId}, ${runnableCanvasId}, 'explore', 'pending', 0, '{}'::jsonb)`;
      await sql`
        UPDATE global_settings SET rules_json = ${sql.json({
          ...originalRules as Record<string, unknown>,
          maxGlobalJobs: 8,
          maxJobsPerProject: 8,
          maxConcurrentProvisioning: 8,
        } as never)}
        WHERE id = 'global'`;

      const firstPause = await post(scheduledCanvasId, "pause");
      assert.equal(firstPause.statusCode, 200);
      assert.deepEqual(firstPause.json(), {
        canvas_id: scheduledCanvasId,
        execution_state: "pausing",
        active_count: 2,
        pending_count: 1,
        changed: true,
      });
      const [pausedTarget] = await sql`
        SELECT target_json FROM canvases WHERE id = ${scheduledCanvasId}`;
      const pausedAt = pausedTarget.target_json.execution_control.paused_at;
      assert.equal(pausedTarget.target_json.execution_control.reason, "manual_pause");
      assert.deepEqual(pausedTarget.target_json.schedule, schedule);

      const duplicatePause = await post(scheduledCanvasId, "pause");
      assert.equal(duplicatePause.statusCode, 200);
      assert.equal(duplicatePause.json().changed, false);
      const [duplicateTarget] = await sql`
        SELECT target_json FROM canvases WHERE id = ${scheduledCanvasId}`;
      assert.equal(duplicateTarget.target_json.execution_control.paused_at, pausedAt);

      // A second Scheduler process sees the committed JSONB gate through the
      // same database claim transaction; pending remains durable.
      const pausedClaims = await Promise.all([claimPendingJobs(), claimPendingJobs()]);
      assert.equal(pausedClaims.flat().some((row) => row.id === scheduledPendingId), false);
      const [stillPending] = await sql`SELECT status FROM jobs WHERE id = ${scheduledPendingId}`;
      assert.equal(stillPending.status, "pending");

      await sql`
        UPDATE jobs SET status = 'succeeded', finished_at = now()
        WHERE id IN (${drainingId}, ${waitingHumanId})`;
      const settledPause = await post(scheduledCanvasId, "pause");
      assert.deepEqual(settledPause.json(), {
        canvas_id: scheduledCanvasId,
        execution_state: "paused",
        active_count: 0,
        pending_count: 1,
        changed: false,
      });

      const firstStart = await post(scheduledCanvasId, "start");
      assert.deepEqual(firstStart.json(), {
        canvas_id: scheduledCanvasId,
        execution_state: "running",
        active_count: 0,
        pending_count: 1,
        changed: true,
      });
      const duplicateStart = await post(scheduledCanvasId, "start");
      assert.equal(duplicateStart.json().changed, false);
      const [startedTarget] = await sql`
        SELECT target_json FROM canvases WHERE id = ${scheduledCanvasId}`;
      assert.deepEqual(startedTarget.target_json.schedule, schedule, "ordinary start must not clear schedule");
      const [failedAfterStart] = await sql`SELECT status FROM jobs WHERE id = ${failedId}`;
      assert.equal(failedAfterStart.status, "failed", "start must not retry failed Jobs");
      const [orphanAfterStart] = await sql`SELECT status FROM jobs WHERE id = ${orphanId}`;
      assert.equal(orphanAfterStart.status, "orphan", "start must not retry orphan Jobs");
      const scheduledClaims = await claimPendingJobs();
      assert.equal(scheduledClaims.some((row) => row.id === scheduledPendingId), false);

      await post(runnableCanvasId, "pause");
      assert.equal((await claimPendingJobs()).some((row) => row.id === runnablePendingId), false);
      const runnableStart = await post(runnableCanvasId, "start");
      assert.equal(runnableStart.json().pending_count, 1);
      const concurrentClaims = await Promise.all([claimPendingJobs(), claimPendingJobs()]);
      assert.equal(
        concurrentClaims.flat().filter((row) => row.id === runnablePendingId).length,
        1,
        "two Scheduler claim loops may claim the resumed pending Job only once",
      );

      await sql`UPDATE canvases SET status = 'archived', archived_at = now() WHERE id = ${archivedCanvasId}`;
      const archivedStart = await post(archivedCanvasId, "start");
      assert.equal(archivedStart.statusCode, 409);
      assert.equal(archivedStart.json().error_code, "TASK_ARCHIVED");

      const list = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/canvases?status=all`,
      });
      const scheduledProjection = list.json().find((row: { id: string }) => row.id === scheduledCanvasId);
      assert.equal(scheduledProjection.execution_state, "running");
      assert.equal(scheduledProjection.pending_count, 1);
      assert.equal(scheduledProjection.execution_active_count, 0);
    } finally {
      await sql`UPDATE global_settings SET rules_json = ${sql.json(originalRules as never)} WHERE id = 'global'`;
      // Audit rows are intentionally append-only; project_id is informational
      // and does not prevent deleting the isolated test fixture.
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await app.close();
      await sql.end({ timeout: 5 });
    }
  });
}
