import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("canvas change log integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("canvas revisions are bounded, transactional, movable, and gap-aware", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { migrate, sql } = await import("./db.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `canvas-change-${randomUUID()}`;
    const otherCanvasId = `canvas-change-${randomUUID()}`;
    const nodeIds: string[] = [];
    try {
      await sql`
        INSERT INTO projects (id, name)
        VALUES (${projectId}, 'canvas change log integration')`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'primary', ${sql.json({})}),
               (${otherCanvasId}, ${projectId}, 'secondary', ${sql.json({})})`;

      const inserted = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
        const [row] = await sql`
          INSERT INTO canvas_nodes (canvas_id, node_type, title, body_json, verification_status)
          VALUES (
            ${canvasId}, 'fact', ${`fact-${index}`},
            ${sql.json({
              summary: "s".repeat(500),
              description: "d".repeat(500),
              secret: "must-not-enter-change-log",
              last_progress: { message: "m".repeat(500), kind: "k".repeat(100), raw: "secret" },
            })}, 'unverified'
          ) RETURNING id`;
        return String(row.id);
      }));
      nodeIds.push(...inserted);

      const [revision] = await sql`
        SELECT change_revision, change_floor_revision FROM canvases WHERE id = ${canvasId}`;
      assert.equal(Number(revision.change_revision), inserted.length);
      const changes = await sql`
        SELECT revision, entity_type, op, projection_json
        FROM canvas_changes WHERE canvas_id = ${canvasId} ORDER BY revision`;
      assert.equal(changes.length, inserted.length);
      for (const change of changes) {
        const serialized = JSON.stringify(change.projection_json);
        assert.equal(serialized.includes("must-not-enter-change-log"), false);
        const body = (change.projection_json as Record<string, unknown>).body_json as Record<string, unknown>;
        assert.ok(String(body.summary).length <= 240);
        assert.ok(String((body.last_progress as Record<string, unknown>).message).length <= 240);
        assert.ok(String((body.last_progress as Record<string, unknown>).kind).length <= 64);
      }

      const deletedId = nodeIds[0] as string;
      await sql`DELETE FROM canvas_nodes WHERE id = ${deletedId}`;
      const [tombstone] = await sql`
        SELECT entity_type, entity_id, op, projection_json
        FROM canvas_changes WHERE canvas_id = ${canvasId} ORDER BY revision DESC LIMIT 1`;
      assert.deepEqual(
        { entity_type: tombstone.entity_type, entity_id: String(tombstone.entity_id), op: tombstone.op },
        { entity_type: "node", entity_id: deletedId, op: "delete" },
      );
      assert.equal(JSON.stringify(tombstone.projection_json).includes("must-not-enter-change-log"), false);

      const movedId = nodeIds[1] as string;
      const [beforeMove] = await sql`SELECT change_revision FROM canvases WHERE id = ${canvasId}`;
      await sql`UPDATE canvas_nodes SET canvas_id = ${otherCanvasId} WHERE id = ${movedId}`;
      const [oldDelete] = await sql`
        SELECT op, entity_id FROM canvas_changes
        WHERE canvas_id = ${canvasId} AND entity_id = ${movedId} ORDER BY revision DESC LIMIT 1`;
      const [newUpsert] = await sql`
        SELECT op, entity_id FROM canvas_changes
        WHERE canvas_id = ${otherCanvasId} AND entity_id = ${movedId} ORDER BY revision DESC LIMIT 1`;
      assert.equal(oldDelete.op, "delete");
      assert.equal(newUpsert.op, "upsert");
      assert.equal(Number(beforeMove.change_revision) + 1, Number((await sql`SELECT change_revision FROM canvases WHERE id = ${canvasId}`)[0].change_revision));

      // Regression: two transactions can arrive here while each already
      // holds the other canvas lock.  NOWAIT must fail fast with lock_not_available
      // rather than waiting for a 40P01 deadlock.
      let locked = 0;
      let releaseBarrier: () => void = () => {};
      const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
      const moveFromPrimary = sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        await tx.unsafe("SET LOCAL statement_timeout = '2000ms'");
        await tx`SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
        locked += 1;
        if (locked === 2) releaseBarrier();
        await barrier;
        await tx`UPDATE canvas_nodes SET canvas_id = ${otherCanvasId} WHERE id = ${nodeIds[2]}`;
      });
      const moveFromOther = sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        await tx.unsafe("SET LOCAL statement_timeout = '2000ms'");
        await tx`SELECT id FROM canvases WHERE id = ${otherCanvasId} FOR UPDATE`;
        locked += 1;
        if (locked === 2) releaseBarrier();
        await barrier;
        await tx`UPDATE canvas_nodes SET canvas_id = ${canvasId} WHERE id = ${movedId}`;
      });
      const moveResults = await Promise.allSettled([moveFromPrimary, moveFromOther]);
      const moveErrors = moveResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason as { code?: string });
      assert.equal(moveErrors.some((error) => error.code === "40P01"), false);
      assert.ok(moveErrors.some((error) => error.code === "55P03"));

      // Reader upper-bound and node projection share one canvas lock.  The
      // writer waits for the reader, then its revision is visible only through
      // a subsequent delta range.
      const reader = sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as typeof sql;
        const [upper] = await tx`SELECT change_revision FROM canvases WHERE id = ${canvasId} FOR SHARE`;
        await tx`SELECT pg_sleep(0.1)`;
        const rows = await tx`SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
        return { upper: BigInt(String(upper.change_revision)), rows };
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const writer = sql`UPDATE canvas_nodes SET title = 'writer update' WHERE id = ${nodeIds[2]}`;
      const [{ upper, rows }] = await Promise.all([reader, writer]);
      const [afterWrite] = await sql`SELECT change_revision FROM canvases WHERE id = ${canvasId}`;
      assert.ok(BigInt(String(afterWrite.change_revision)) >= upper);
      assert.ok(rows.every((row) => row.id));
      const followup = await sql`
        SELECT revision, op FROM canvas_changes
        WHERE canvas_id = ${canvasId} AND revision > ${upper.toString()}::bigint
        ORDER BY revision`;
      assert.ok(followup.some((row) => row.op === "upsert"));

      // Exercise retention and expose a deterministic floor for CURSOR_GAP.
      await sql.unsafe(`
        DO $$
        BEGIN
          FOR i IN 1..10002 LOOP
            PERFORM deepsonar_canvas_append_change('${canvasId}', 'meta', '${canvasId}', 'upsert', '{"id":"${canvasId}"}'::jsonb);
          END LOOP;
        END $$;`);
      const [retained] = await sql`
        SELECT change_revision, change_floor_revision FROM canvases WHERE id = ${canvasId}`;
      assert.ok(Number(retained.change_floor_revision) > 0);
      assert.ok(Number(retained.change_floor_revision) < Number(retained.change_revision));
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM canvas_changes WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM canvases WHERE id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 });
    }
  });
}
