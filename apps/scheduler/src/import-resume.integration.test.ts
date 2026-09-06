import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("import resume (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("imported cancelled Jobs stay readonly; imported failed Jobs may resume after admission", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    process.env.DEEPSONAR_AUTH_REQUIRED = "false";
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("./db.js"),
      import("./routes.js"),
    ]);
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const canvasId = randomUUID();
    const cancelledId = randomUUID();
    const failedId = randomUUID();
    try {
      await sql`INSERT INTO projects (id, name, status) VALUES (${projectId}, 'import resume', 'active')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'import resume', ${sql.json({})})`;
      const origin = { import_origin: { source_job_id: randomUUID(), original_status: "running" } };
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (
          ${cancelledId}, ${projectId}, ${canvasId}, 'audit', 'cancelled',
          ${sql.json(origin)}, ${sql.json({})}
        )`;
      const cancelledResume = await app.inject({ method: "POST", url: `/jobs/${cancelledId}/resume` });
      assert.equal(cancelledResume.statusCode, 409, cancelledResume.payload);
      assert.equal(cancelledResume.json().error_code, "JOB_IMPORTED_READONLY");
      assert.equal(cancelledResume.json().provenance?.source, "import");
      assert.equal(cancelledResume.json().provenance?.default_readonly, true);

      const failedOrigin = { import_origin: { source_job_id: randomUUID(), original_status: "failed" } };
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (
          ${failedId}, ${projectId}, ${canvasId}, 'audit', 'failed',
          ${sql.json(failedOrigin)}, ${sql.json({})}
        )`;
      const failedResume = await app.inject({ method: "POST", url: `/jobs/${failedId}/resume` });
      assert.notEqual(failedResume.json().error_code, "JOB_IMPORTED_READONLY");
      assert.ok(
        failedResume.statusCode === 200 || failedResume.json().error_code === "SNAPSHOT_STALE",
        failedResume.payload,
      );
      assert.equal(failedResume.json().provenance?.source, "import");
    } finally {
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await app.close();
    }
  });
}
