import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("project findings summary / disposition (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("project risk summary rolls up every canvas and human_reproducing stays a disposition", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("../../db.js"),
      import("../../routes.js"),
    ]);
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const canvasA = randomUUID();
    const canvasB = randomUUID();
    const jobA = randomUUID();
    const jobB = randomUUID();
    const findingA = randomUUID();
    const findingB = randomUUID();
    try {
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${randomUUID()}, 'multi-task risk')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES
        (${canvasA}, ${projectId}, '任务 A'),
        (${canvasB}, ${projectId}, '任务 B')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES
          (${jobA}, ${projectId}, ${canvasA}, 'audit', 'succeeded', ${sql.json({})}),
          (${jobB}, ${projectId}, ${canvasB}, 'audit', 'succeeded', ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status, disposition)
        VALUES
          (${findingA}, ${projectId}, ${jobA}, ${`fp-a-${findingA}`}, 'A finding', 'high', 'pending', 'open'),
          (${findingB}, ${projectId}, ${jobB}, ${`fp-b-${findingB}`}, 'B finding', 'medium', 'pending', 'accepted')`;

      const list = await app.inject({ method: "GET", url: `/findings?project_id=${projectId}` });
      assert.equal(list.statusCode, 200, list.payload);
      const listed = JSON.parse(list.payload) as Array<{ id: string; canvas_id: string }>;
      assert.equal(listed.length, 2);
      assert.deepEqual(new Set(listed.map((row) => row.canvas_id)), new Set([canvasA, canvasB]));

      const summaryRes = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary` });
      assert.equal(summaryRes.statusCode, 200, summaryRes.payload);
      const summary = JSON.parse(summaryRes.payload) as {
        total: number;
        project_total: number;
        truncated: boolean;
        severity: Array<{ key: string; count: number }>;
        disposition: Array<{ key: string; count: number }>;
        canvases: Array<{ id: string; count: number }>;
      };
      assert.equal(summary.total, 2);
      assert.equal(summary.project_total, 2);
      assert.equal(summary.truncated, false);
      assert.equal(summary.severity.find((item) => item.key === "high")?.count, 1);
      assert.equal(summary.canvases.find((item) => item.id === canvasB)?.count, 1);

      const canvasSummary = await app.inject({
        method: "GET",
        url: `/projects/${projectId}/findings/summary?canvas_id=${canvasA}`,
      });
      assert.equal(JSON.parse(canvasSummary.payload).total, 1);

      const emptyProjectId = randomUUID();
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${emptyProjectId}, ${randomUUID()}, 'empty risk')`;
      const emptySummary = await app.inject({ method: "GET", url: `/projects/${emptyProjectId}/findings/summary` });
      assert.equal(emptySummary.statusCode, 200);
      assert.equal(JSON.parse(emptySummary.payload).total, 0);

      const reproduce = await app.inject({
        method: "PATCH",
        url: `/findings/${findingA}/disposition`,
        payload: { disposition: "human_reproducing", note: "手工打 PoC" },
      });
      assert.equal(reproduce.statusCode, 200, reproduce.payload);
      assert.equal(JSON.parse(reproduce.payload).disposition, "human_reproducing");

      const bypass = await app.inject({
        method: "PATCH",
        url: `/findings/${findingA}/disposition`,
        payload: { disposition: "confirmed_vuln" },
      });
      assert.equal(bypass.statusCode, 409);
      assert.equal(JSON.parse(bypass.payload).error, "confirmed_vuln_requires_verify");

      const after = await app.inject({ method: "GET", url: `/projects/${projectId}/findings/summary` });
      assert.equal(JSON.parse(after.payload).disposition.find((item: { key: string; count: number }) => item.key === "human_reproducing")?.count, 1);

      await sql`DELETE FROM findings WHERE project_id = ${emptyProjectId}`;
      await sql`DELETE FROM projects WHERE id = ${emptyProjectId}`;
    } finally {
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await app.close();
    }
  });
}
