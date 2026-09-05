import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("dashboard overview (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("GET /dashboard/overview returns P0 totals from the live tables", async () => {
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
    try {
      await sql`INSERT INTO projects (id, name, status) VALUES (${projectId}, 'overview project', 'active')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json, created_at)
        VALUES (${canvasId}, ${projectId}, 'overview task', ${sql.json({})}, ${"2026-08-19T01:00:00.000Z"})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, created_at, started_at)
        VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json({})}, ${"2026-08-19T01:05:00.000Z"}, ${"2026-08-19T01:06:00.000Z"})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, verify_status, created_at)
        VALUES (${randomUUID()}, ${projectId}, ${jobId}, ${`fp-${canvasId}`}, 'demo finding', 'pending', ${"2026-08-19T01:10:00.000Z"})`;

      const response = await app.inject({ method: "GET", url: "/dashboard/overview" });
      assert.equal(response.statusCode, 200, response.payload);
      const body = JSON.parse(response.payload) as {
        totals: { projects: number; tasks: number; jobs: number; findings: number };
        calendar_timezone: string;
        distributions: { jobs: Array<{ key: string; count: number }> };
        active_projects: Array<{ id: string; active_jobs: number }>;
      };
      assert.equal(body.calendar_timezone, "Asia/Shanghai");
      assert.ok(body.totals.projects >= 1);
      assert.ok(body.totals.tasks >= 1);
      assert.ok(body.totals.jobs >= 1);
      assert.ok(body.totals.findings >= 1);
      assert.ok((body.distributions.jobs.find((item) => item.key === "running")?.count ?? 0) >= 1);
      assert.ok(body.active_projects.some((project) => project.id === projectId && project.active_jobs >= 1));
    } finally {
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await app.close();
    }
  });
}
