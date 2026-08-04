import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("event-ingestion integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("event append, duplicate replay, concurrent sequencing, rollback, and finalize lock order", async () => {
    // Install the explicit URL before importing db/core so a developer .env
    // cannot redirect this integration run to an existing database.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { createEventIngestionApplication } = await import("./application.js");
    const { finalizeJob, ingestEvent } = await import("../../core.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `event-ingestion-${randomUUID()}`;
    const jobId = randomUUID();
    const legacyJobId = randomUUID();
    const fixture = {
      jobId,
      projectId,
      canvasId,
      eventIds: [] as string[],
    };

    await sql`
      INSERT INTO projects (id, canvas_id, name, config_json)
      VALUES (${projectId}, ${canvasId}, 'event-ingestion', ${sql.json({ rules: { hubEnabled: false } })})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${canvasId}, ${projectId}, 'event-ingestion', ${sql.json({})})`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${jobId}, ${projectId}, ${canvasId}, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${legacyJobId}, ${projectId}, NULL, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES (${canvasId}, ${legacyJobId}, 'job', 'legacy job', 'running', ${sql.json({})})`;

    const marker = (tx: typeof sql, eventId: string) =>
      tx`UPDATE canvas_nodes
          SET body_json = body_json || ${sql.json({ last_event_id: eventId })}, updated_at = now()
          WHERE canvas_id = ${canvasId} AND node_type = 'root'`;

    try {
      let callbackCount = 0;
      const app = createEventIngestionApplication(sql, async (tx, _job, envelope) => {
        callbackCount += 1;
        await tx`UPDATE canvas_nodes
          SET body_json = body_json || ${tx.json({ last_event_id: envelope.event_id })}, updated_at = now()
          WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
      });

      const duplicateId = randomUUID();
      fixture.eventIds.push(duplicateId);
      const first = await app.ingestEvent(jobId, {
        v: 1,
        event_id: duplicateId,
        type: "progress",
        payload: { message: "first" },
      });
      const duplicate = await app.ingestEvent(jobId, {
        v: 1,
        event_id: duplicateId,
        type: "progress",
        payload: { message: "replay must not run" },
      });
      assert.deepEqual(first, { deduped: false, seq: 1 });
      assert.deepEqual(duplicate, { deduped: true });
      assert.equal(callbackCount, 1, "duplicate event must not invoke semantic side effects");

      // Legacy Jobs can lack canvas_id while their job node still points at a
      // Canvas.  The ingress boundary must discover that Canvas before the Job
      // lock so the real core side effect cannot reintroduce reverse locking.
      const legacyEventId = randomUUID();
      fixture.eventIds.push(legacyEventId);
      const legacyResult = await ingestEvent(legacyJobId, {
        v: 1,
        event_id: legacyEventId,
        type: "progress",
        payload: { message: "legacy canvas hint" },
      });
      assert.deepEqual(legacyResult, { deduped: false, seq: 1 });
      const [legacyNode] = await sql<{ body_json: { last_progress?: { message?: string } } }[]>`
        SELECT body_json FROM canvas_nodes WHERE job_id = ${legacyJobId} AND node_type = 'job'`;
      assert.equal(legacyNode?.body_json.last_progress?.message, "legacy canvas hint");
      await sql.begin(async (tx) => {
        await finalizeJob(tx as unknown as typeof sql, legacyJobId, "succeeded", { summary: "legacy terminal" });
      });
      const [legacyTerminalNode] = await sql<{ status: string }[]>`
        SELECT status FROM canvas_nodes WHERE job_id = ${legacyJobId} AND node_type = 'job'`;
      assert.equal(legacyTerminalNode?.status, "succeeded");

      const concurrentIds = [randomUUID(), randomUUID()];
      fixture.eventIds.push(...concurrentIds);
      const concurrent = await Promise.all(
        concurrentIds.map((eventId) =>
          app.ingestEvent(jobId, {
            v: 1,
            event_id: eventId,
            type: "progress",
            payload: { message: eventId },
          }),
        ),
      );
      assert.deepEqual(concurrent.map((result) => result.deduped), [false, false]);
      assert.deepEqual(
        concurrent.map((result) => result.seq).sort((a, b) => Number(a) - Number(b)),
        [2, 3],
        "the Job lock must serialize MAX(job_seq)+1",
      );

      let failOnce = true;
      const failingApp = createEventIngestionApplication(sql, async (tx, _job, envelope) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated semantic crash");
        }
        await marker(tx, envelope.event_id);
      });
      const retryId = randomUUID();
      fixture.eventIds.push(retryId);
      await assert.rejects(
        failingApp.ingestEvent(jobId, {
          v: 1,
          event_id: retryId,
          type: "progress",
          payload: { message: "rollback" },
        }),
        /simulated semantic crash/,
      );
      const [rolledBackEvent] = await sql`SELECT 1 FROM events WHERE event_id = ${retryId}`;
      const [rolledBackDedup] = await sql`SELECT 1 FROM event_dedup WHERE event_id = ${retryId}`;
      assert.equal(rolledBackEvent, undefined, "append must roll back with side-effect failure");
      assert.equal(rolledBackDedup, undefined, "dedup marker must roll back with side-effect failure");

      const retried = await failingApp.ingestEvent(jobId, {
        v: 1,
        event_id: retryId,
        type: "progress",
        payload: { message: "retry" },
      });
      assert.equal(retried.deduped, false);
      assert.equal(retried.seq, 4);

      // Compete the Canvas-first done event with a direct finalize path. Both
      // paths must complete; a Job-first finalize would deadlock here.
      const terminalJobId = randomUUID();
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
        ) VALUES (
          ${terminalJobId}, ${projectId}, ${canvasId}, 'audit_module', 'running',
          ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
        )`;
      const terminalEventId = randomUUID();
      fixture.eventIds.push(terminalEventId);
      const finalizeDirect = sql.begin(async (rawTx) =>
        finalizeJob(rawTx as unknown as typeof sql, terminalJobId, "succeeded", { summary: "direct" }),
      );
      const finalizeEvent = ingestEvent(terminalJobId, {
        v: 1,
        event_id: terminalEventId,
        type: "done",
        payload: { summary: "event" },
      });
      const results = await Promise.race([
        Promise.all([finalizeDirect, finalizeEvent]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Canvas/Job lock-order deadlock")), 5000)),
      ]);
      assert.equal(results[1].deduped, false);
      const [terminal] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${terminalJobId}`;
      assert.ok(["succeeded", "failed"].includes(String(terminal?.status)));
    } finally {
      for (const eventId of fixture.eventIds) {
        await sql`DELETE FROM event_dedup WHERE event_id = ${eventId}`;
        await sql`DELETE FROM events WHERE event_id = ${eventId}`;
      }
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end();
    }
  });
}
