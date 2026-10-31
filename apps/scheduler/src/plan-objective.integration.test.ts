import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

const objective = (expected_revision: string | null, goal = "Collect and verify the scoped execution evidence") => ({
  expected_revision,
  goal,
  completion: {
    mode: "all_tasks" as const,
    description: "Every planned task must have a retained output",
    required_outputs: [],
  },
  budget: {
    max_tasks: 8,
    max_rounds: 4,
    max_no_progress_rounds: 2,
    max_parallel_tasks: 1,
  },
});

if (!testDatabaseUrl) {
  test("Plan objective HTTP CAS integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("PATCH /tasks/:canvasId persists objective revisions and rejects stale concurrent input", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_plan_objective_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

    process.env.DATABASE_URL = targetUrl.toString();
    process.env.AGENT_MODE = "fake";
    process.env.DEEPSONAR_AUTH_REQUIRED = "true";
    process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);

    const Fastify = (await import("fastify")).default;
    const websocket = (await import("@fastify/websocket")).default;
    const { migrate, sql } = await import("./db.js");
    const { registerRoutes } = await import("./routes.js");
    const { generateToken } = await import("./auth.js");
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const canvasId = randomUUID();
    try {
      const writer = generateToken(), reader = generateToken();
      await sql`INSERT INTO api_tokens(name,token_prefix,token_hash,scopes) VALUES
        ('objective writer',${writer.prefix},${writer.hash},${["tasks:write", "tasks:read"]}),
        ('objective reader',${reader.prefix},${reader.hash},${["tasks:read"]})`;
      const headers = { authorization: `Bearer ${writer.plaintext}` };
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'plan-objective-http')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Scoped execution', ${sql.json({ network_policy: { allow_egress: false } })})`;
      await sql`INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'Scoped execution', 'active', ${sql.json({})})`;
      const anonymous = await app.inject({ method: "PATCH", url: `/tasks/${canvasId}`, payload: { plan_objective: objective(null) } });
      assert.equal(anonymous.statusCode, 401);
      const denied = await app.inject({ method: "PATCH", url: `/tasks/${canvasId}`, headers: { authorization: `Bearer ${reader.plaintext}` }, payload: { plan_objective: objective(null) } });
      assert.equal(denied.statusCode, 403);

      const first = await app.inject({
        method: "PATCH",
        url: `/tasks/${canvasId}`,
        headers,
        payload: { plan_objective: objective(null) },
      });
      assert.equal(first.statusCode, 200, first.payload);
      assert.equal(first.json().plan_objective.revision, "1");
      const firstObjectiveId = first.json().plan_objective.objective_id;

      const stale = await app.inject({
        method: "PATCH",
        url: `/tasks/${canvasId}`,
        headers,
        payload: { plan_objective: objective(null, "A stale writer must not replace the current user objective") },
      });
      assert.equal(stale.statusCode, 409, stale.payload);
      assert.equal(stale.json().error_code, "plan_stale_revision");

      const second = await app.inject({
        method: "PATCH",
        url: `/tasks/${canvasId}`,
        headers,
        payload: { plan_objective: objective("1", "Collect and verify the revised scoped execution evidence") },
      });
      assert.equal(second.statusCode, 200, second.payload);
      assert.equal(second.json().plan_objective.revision, "2");
      assert.equal(second.json().plan_objective.objective_id, firstObjectiveId);

      const concurrentPatch = objective("2", "Collect and verify the concurrently revised evidence");
      const concurrent = await Promise.all([
        app.inject({ method: "PATCH", url: `/tasks/${canvasId}`, headers, payload: { plan_objective: concurrentPatch } }),
        app.inject({ method: "PATCH", url: `/tasks/${canvasId}`, headers, payload: { plan_objective: concurrentPatch } }),
      ]);
      assert.deepEqual(
        concurrent.map((response) => response.statusCode).sort((a, b) => a - b),
        [200, 409],
        "Canvas row locking must make concurrent objective CAS single-winner",
      );
      const detail = await app.inject({ method: "GET", url: `/canvases/${canvasId}`, headers });
      assert.equal(detail.statusCode, 200, detail.payload);
      assert.equal(detail.json().canvas.target_json.plan_objective.revision, "3");

      const [canvas] = await sql`SELECT target_json FROM canvases WHERE id=${canvasId}`;
      assert.equal(canvas.target_json.plan_objective.revision, "3");
      const [root] = await sql`SELECT body_json FROM canvas_nodes WHERE canvas_id=${canvasId} AND node_type='root'`;
      assert.equal(root.body_json.target.plan_objective.revision, "3");
    } finally {
      await app.close().catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
