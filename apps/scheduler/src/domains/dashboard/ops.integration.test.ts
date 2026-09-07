import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("dashboard ops (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("GET /dashboard/ops returns P1/P2 server aggregates from live tables", async () => {
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
    const canvasId = randomUUID();
    const jobId = randomUUID();
    const findingId = randomUUID();
    try {
      await sql`INSERT INTO projects (id, name, status) VALUES (${projectId}, 'ops project', 'active')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json, created_at)
        VALUES (${canvasId}, ${projectId}, 'ops task', ${sql.json({})}, ${"2026-08-19T01:00:00.000Z"})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, created_at, started_at, finished_at)
        VALUES (
          ${jobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})},
          ${"2026-08-19T01:05:00.000Z"}, ${"2026-08-19T01:06:00.000Z"}, ${"2026-08-19T01:16:00.000Z"}
        )`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, disposition, verify_status, created_at)
        VALUES (
          ${findingId}, ${projectId}, ${jobId}, ${`fp-${canvasId}`}, 'ops finding',
          'critical', 'open', 'pending', ${"2026-08-19T01:10:00.000Z"}
        )`;

      const response = await app.inject({ method: "GET", url: "/dashboard/ops" });
      assert.equal(response.statusCode, 200, response.payload);
      const body = JSON.parse(response.payload) as {
        calendar_timezone: string;
        query_planes: { snapshot: string; throughput: string };
        findings: { open_high_risk: { items: Array<{ id: string }> } };
        jobs: { throughput: { succeeded: number } };
      };
      assert.equal(body.calendar_timezone, "Asia/Shanghai");
      assert.deepEqual(body.query_planes, { snapshot: "current", throughput: "history" });
      assert.ok(body.findings.open_high_risk.items.some((item) => item.id === findingId));
      assert.ok(body.jobs.throughput.succeeded >= 1);
    } finally {
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await app.close();
    }
  });
}
