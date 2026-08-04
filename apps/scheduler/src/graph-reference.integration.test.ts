import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlInputError } from "./control-input.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Hub graph-reference integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("invalid Hub references roll back the whole decision without PostgreSQL UUID errors", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const { ingestEvent } = await import("./core.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `graph-reference-${randomUUID()}`;
    const otherCanvasId = `graph-reference-other-${randomUUID()}`;
    const jobId = randomUUID();
    const validSnapshot = { agent_cli: "claude-code", credential_id: null, model: null };
    let rootId = "";
    let otherRootId = "";

    await sql`
      INSERT INTO projects (id, canvas_id, name, config_json)
      VALUES (${projectId}, ${canvasId}, 'graph-reference', ${sql.json({})})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${canvasId}, ${projectId}, 'graph-reference', ${sql.json({})})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${otherCanvasId}, ${projectId}, 'graph-reference-other', ${sql.json({})})`;
    const [root] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})
      RETURNING id`;
    rootId = root.id;
    const [otherRoot] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${otherCanvasId}, 'root', 'other root', 'active', ${sql.json({})})
      RETURNING id`;
    otherRootId = otherRoot.id;
    await sql`
      INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
      VALUES (${jobId}, ${projectId}, ${canvasId}, 'hub_reason', 'running', ${sql.json(validSnapshot)}, ${sql.json({})})`;

    const decision = (from: unknown, complete = false) =>
      complete
        ? { complete: { from, description: "完成" } }
        : { intents: [{ from, role: "review", description: "复核", prompt: "执行复核" }] };

    const attempt = async (payload: unknown, label: string) => {
      const eventId = randomUUID();
      await assert.rejects(
        () => ingestEvent(jobId, { v: 1, event_id: eventId, type: "hub_decision", payload }),
        (error: unknown) => {
          assert.ok(error instanceof ControlInputError, `${label}: expected ControlInputError`);
          assert.equal(error.code, "invalid_node_ref", label);
          assert.match(error.message, /YAML root_id/);
          assert.doesNotMatch(error.message, /invalid input syntax for type uuid/i);
          return true;
        },
      );
      const [counts] = await sql<{ events: number; dedup: number; edges: number; jobs: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM events WHERE job_id = ${jobId}) AS events,
          (SELECT COUNT(*)::int FROM event_dedup WHERE job_id = ${jobId}) AS dedup,
          (SELECT COUNT(*)::int FROM canvas_edges WHERE canvas_id = ${canvasId}) AS edges,
          (SELECT COUNT(*)::int FROM jobs WHERE parent_job_id = ${jobId}) AS jobs`;
      assert.deepEqual(counts, { events: 0, dedup: 0, edges: 0, jobs: 0 }, `${label}: partial side effect`);
    };

    try {
      await attempt(decision(["root_id"]), "root_id field name");
      await attempt(decision(["not-a-uuid"]), "non-UUID");
      await attempt(decision([otherRootId]), "cross-canvas UUID");
      await attempt(decision(["root_id"], true), "complete.from field name");
      await attempt(decision(undefined), "missing from");

      const [validResult] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'fact', 'valid fact', 'open', ${sql.json({})})
        RETURNING id`;
      const validEventId = randomUUID();
      const accepted = await ingestEvent(jobId, {
        v: 1,
        event_id: validEventId,
        type: "hub_decision",
        payload: decision([validResult.id]),
      });
      assert.equal(accepted.deduped, false);
      const [{ eventCount }] = await sql<{ eventCount: number }[]>`
        SELECT COUNT(*)::int AS "eventCount" FROM events WHERE job_id = ${jobId}`;
      assert.equal(eventCount, 1);
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM event_dedup WHERE job_id = ${jobId}`;
      await sql`DELETE FROM events WHERE job_id = ${jobId}`;
      await sql`DELETE FROM jobs WHERE parent_job_id = ${jobId}`;
      await sql`DELETE FROM jobs WHERE id = ${jobId}`;
      await sql`DELETE FROM canvases WHERE id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 });
    }
  });
}
