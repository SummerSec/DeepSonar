import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "./test-project-teardown.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

if (!testDatabaseUrl) {
  test("tool progress Canvas-first integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("Canvas-first progress removes the real trigger/node deadlock and preserves the projection", { timeout: 30000 }, async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const [{ migrate, sql }, { default: postgres }, { persistJobToolProgress }] = await Promise.all([
      import("./db.js"), import("postgres"), import("./domains/canvas/job-tool-progress.js"),
    ]);
    await migrate();
    const reader = postgres(testDatabaseUrl, { max: 1 });
    const writer = postgres(testDatabaseUrl, { max: 1 });
    const projectId = randomUUID(), canvasId = randomUUID(), otherCanvasId = randomUUID();
    try {
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'tool progress lock integration')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES
        (${canvasId}, ${projectId}, 'primary', ${sql.json({})}),
        (${otherCanvasId}, ${projectId}, 'unrelated', ${sql.json({})})`;
      const [job] = await sql`INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${projectId}, ${canvasId}, 'audit', 'running', ${sql.json({})}) RETURNING id`;
      await sql`INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, body_json) VALUES
        (${canvasId}, ${job.id}, 'job', 'job', ${sql.json({ summary: 'keep', warning: 'keep' })}),
        (${canvasId}, ${job.id}, 'intent', 'intent', ${sql.json({ summary: 'intent stays' })})`;
      const [writerBackend] = await writer`SELECT pg_backend_pid() AS pid`;
      const [readerBackend] = await reader`SELECT pg_backend_pid() AS pid`;

      // Do not rely on sleeps to order the race: observe the actual backend lock wait
      // before the Canvas owner requests the node. The old UPDATE locks node first;
      // its real change-log trigger then waits for Canvas and closes a 40P01 cycle.
      async function cross(write: () => Promise<unknown>, expectedWaitingQuery: RegExp) {
        const locked = barrier(), proceed = barrier();
        const read = reader.begin(async tx => {
          await tx`SET LOCAL statement_timeout = '5s'`;
          await tx`SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
          locked.release();
          await proceed.promise;
          await tx`SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} ORDER BY id FOR UPDATE`;
        });
        // Observe failures from creation, even while waiting for the barrier.
        const observedRead = read.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        await Promise.race([locked.promise, observedRead.then(result => {
          if (result.status === "rejected") throw result.reason;
        })]);
        const written = write();
        const observedWrite = written.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        try {
          let waitingQuery: string | undefined;
          for (let poll = 0; poll < 200; poll += 1) {
            const [activity] = await sql`SELECT query, pg_blocking_pids(pid) AS blockers
              FROM pg_stat_activity WHERE pid = ${writerBackend.pid}`;
            if (activity?.blockers.map(Number).includes(Number(readerBackend.pid))) {
              waitingQuery = String(activity.query);
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.ok(waitingQuery, "writer must actually wait for the Canvas owner");
          assert.match(waitingQuery, expectedWaitingQuery);
        } finally {
          proceed.release();
          await Promise.all([observedRead, observedWrite]);
        }
        return Promise.all([observedRead, observedWrite]);
      }

      const old = await cross(() => writer.begin(async tx => {
        await tx`SET LOCAL statement_timeout = '5s'`;
        await tx`UPDATE canvas_nodes SET body_json = body_json || ${tx.json({ last_progress: { message: 'old', kind: 'tool' } })}
          WHERE job_id = ${job.id} AND node_type = 'job'`;
      }), /^\s*UPDATE canvas_nodes/);
      assert.ok(old.some(result => result.status === "rejected" && result.reason?.code === "40P01"),
        "negative control must reproduce the actual PostgreSQL trigger deadlock");

      const [before] = await sql`SELECT change_revision FROM canvases WHERE id = ${canvasId}`;
      const input = { canvasId, jobId: String(job.id), action: 'Read governed source' };
      const fixed = await cross(() => persistJobToolProgress(writer, input), /^SELECT id FROM canvases/);
      assert.ok(fixed.every(result => result.status === "fulfilled"), "both Canvas-first transactions commit");
      const [node] = await sql`SELECT id, body_json FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'job'`;
      assert.deepEqual(node.body_json, { summary: 'keep', warning: 'keep', last_progress: { message: input.action, kind: 'tool' } });
      const [after] = await sql`SELECT change_revision FROM canvases WHERE id = ${canvasId}`;
      assert.equal(Number(after.change_revision), Number(before.change_revision) + 1);
      const [change] = await sql`SELECT projection_json FROM canvas_changes WHERE canvas_id = ${canvasId} AND revision = ${after.change_revision}`;
      assert.equal(String(change.projection_json.id), String(node.id));
      assert.deepEqual(change.projection_json.body_json.last_progress, { message: input.action, kind: 'tool' });
      const [intent] = await sql`SELECT body_json FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'intent'`;
      assert.deepEqual(intent.body_json, { summary: 'intent stays' });
      await persistJobToolProgress(writer, { ...input, canvasId: otherCanvasId, action: 'must not escape scope' });
      await persistJobToolProgress(writer, { ...input, canvasId: randomUUID(), action: 'removed Canvas' });
      const [unchanged] = await sql`SELECT body_json FROM canvas_nodes WHERE id = ${node.id}`;
      assert.deepEqual(unchanged.body_json, node.body_json);
    } finally {
      await Promise.allSettled([reader.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
      await sql`DELETE FROM canvas_nodes WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM jobs WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM canvases WHERE id IN (${canvasId}, ${otherCanvasId})`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await sql.end({ timeout: 5 });
    }
  });
}
