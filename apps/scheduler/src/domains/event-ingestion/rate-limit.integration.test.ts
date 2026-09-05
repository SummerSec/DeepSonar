import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("event rate-limit integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("durable per-job buckets serialize across processes, preserve dedup, and reserve terminal budget", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { createEventIngestionApplication } = await import("./application.js");
    const { EventRateLimitError } = await import("./rate-limit.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `event-rate-limit-${randomUUID()}`;
    const jobId = randomUUID();
    const concurrentJobId = randomUUID();
    const now = new Date("2026-08-05T00:00:12.000Z");
    const eventIds: string[] = [];
    await sql`
      INSERT INTO projects (id, name, config_json)
      VALUES (${projectId}, 'event-rate-limit', ${sql.json({ rules: { hubEnabled: false } })})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${canvasId}, ${projectId}, 'event-rate-limit', ${sql.json({})})`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
    for (const id of [jobId, concurrentJobId]) {
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
        ) VALUES (
          ${id}, ${projectId}, ${canvasId}, 'audit_module', 'running',
          ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
        )`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${id}, 'job', ${id}, 'running', ${sql.json({})})`;
    }

    const policy = {
      windowSeconds: 60,
      progressPerWindow: 2,
      standardPerWindow: 2,
      terminalPerWindow: 1,
    };
    let sideEffectCount = 0;
    const rateLimitObservations: string[] = [];
    const app = createEventIngestionApplication(sql, async () => {
      sideEffectCount += 1;
    }, {
      rateLimit: policy,
      clock: () => now,
      onRateLimited: (error) => rateLimitObservations.push(error.bucket),
    });

    try {
      const firstId = randomUUID();
      const secondId = randomUUID();
      const replayId = firstId;
      const limitedId = randomUUID();
      eventIds.push(firstId, secondId, limitedId);
      assert.deepEqual(await app.ingestEvent(jobId, {
        v: 1, event_id: firstId, type: "progress", payload: { message: "one" },
      }), { deduped: false, seq: 1 });
      assert.deepEqual(await app.ingestEvent(jobId, {
        v: 1, event_id: replayId, type: "progress", payload: { message: "replay" },
      }), { deduped: true }, "duplicate event_id must not consume a second quota slot");
      assert.deepEqual(await app.ingestEvent(jobId, {
        v: 1, event_id: secondId, type: "progress", payload: { message: "two" },
      }), { deduped: false, seq: 2 });
      await assert.rejects(
        app.ingestEvent(jobId, {
          v: 1, event_id: limitedId, type: "progress", payload: { message: "three" },
        }),
        (error: unknown) => {
          assert.ok(error instanceof EventRateLimitError);
          assert.equal(error.code, "event_rate_limited");
          assert.equal(error.bucket, "progress");
          assert.ok(error.retryAfterSec >= 1);
          return true;
        },
      );
      assert.equal(sideEffectCount, 2, "rejected event must not run side effects");
      assert.deepEqual(rateLimitObservations, ["progress"], "rate-limit observation is emitted once for the rejected first delivery");
      const [limitedEvent] = await sql`SELECT 1 FROM events WHERE event_id = ${limitedId}`;
      const [limitedDedup] = await sql`SELECT 1 FROM event_dedup WHERE event_id = ${limitedId}`;
      assert.equal(limitedEvent, undefined, "rate rejection must roll back event row");
      assert.equal(limitedDedup, undefined, "rate rejection must roll back dedup marker");
      const [counter] = await sql<{ progress_count: number; terminal_count: number }[]>`
        SELECT progress_count, terminal_count FROM job_event_rate_limits WHERE job_id = ${jobId}`;
      assert.equal(counter?.progress_count, 2);

      // Terminal/control events use an independent reserved bucket.
      const terminalOne = randomUUID();
      const terminalTwo = randomUUID();
      eventIds.push(terminalOne, terminalTwo);
      assert.equal((await app.ingestEvent(jobId, {
        v: 1, event_id: terminalOne, type: "human", payload: {
          reason: "operator review",
          subject: { type: "platform_blocker", kind: "business_decision" },
        },
      })).deduped, false);
      await assert.rejects(
        app.ingestEvent(jobId, {
          v: 1, event_id: terminalTwo, type: "done", payload: { summary: "second terminal" },
        }),
        (error: unknown) => error instanceof EventRateLimitError && error.bucket === "terminal",
      );
      const [terminalCounter] = await sql<{ terminal_count: number }[]>`
        SELECT terminal_count FROM job_event_rate_limits WHERE job_id = ${jobId}`;
      assert.equal(terminalCounter?.terminal_count, 1);
      assert.deepEqual(rateLimitObservations, ["progress", "terminal"]);

      // Five callers race from independent Scheduler-like transactions; the
      // row lock allows exactly two progress events through, never more.
      const concurrentIds = Array.from({ length: 5 }, () => randomUUID());
      eventIds.push(...concurrentIds);
      const concurrentResults = await Promise.allSettled(concurrentIds.map((eventId) => app.ingestEvent(concurrentJobId, {
        v: 1, event_id: eventId, type: "progress", payload: { message: eventId },
      })));
      assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 2);
      assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 3);
      assert.ok(concurrentResults.filter((result) => result.status === "rejected").every(
        (result) => result.status === "rejected" && result.reason instanceof EventRateLimitError,
      ));
      assert.equal(rateLimitObservations.filter((bucket) => bucket === "progress").length, 4);
      const [concurrentCounter] = await sql<{ progress_count: number }[]>`
        SELECT progress_count FROM job_event_rate_limits WHERE job_id = ${concurrentJobId}`;
      assert.equal(concurrentCounter?.progress_count, 2);

      // Advancing the injected clock crosses the fixed window without any
      // historical scan and permits a new progress event.
      now.setTime(now.getTime() + 61_000);
      const afterWindow = randomUUID();
      eventIds.push(afterWindow);
      assert.equal((await app.ingestEvent(jobId, {
        v: 1, event_id: afterWindow, type: "progress", payload: { message: "new window" },
      })).deduped, false);
      const [resetCounter] = await sql<{ progress_count: number }[]>`
        SELECT progress_count FROM job_event_rate_limits WHERE job_id = ${jobId}`;
      assert.equal(resetCounter?.progress_count, 1);
    } finally {
      for (const eventId of eventIds) {
        await sql`DELETE FROM event_dedup WHERE event_id = ${eventId}`;
        await sql`DELETE FROM events WHERE event_id = ${eventId}`;
      }
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end();
    }
  });
}
