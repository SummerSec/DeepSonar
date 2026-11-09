import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

test("project queue HTTP enforces permissions, strict input, ownership and durable order", {
  skip: !databaseUrl && "TEST_DATABASE_URL is required",
}, async () => {
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `queue_http_${process.pid}_${Date.now()}`;
  const targetUrl = new URL(databaseUrl!);
  targetUrl.pathname = `/${databaseName}`;
  targetUrl.search = "";
  let created = false;
  let closeApp: (() => Promise<unknown>) | undefined;
  let closeSql: (() => Promise<unknown>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    process.env.DATABASE_URL = targetUrl.toString();
    process.env.DEEPSONAR_AUTH_REQUIRED = "true";
    process.env.DEEPSONAR_ADMIN_TOKEN = "";
    process.env.AGENT_MODE = "fake";
    const { sql, migrate } = await import("../../db.js");
    closeSql = () => sql.end({ timeout: 5 });
    await migrate();
    const { default: Fastify } = await import("fastify");
    const { authHook, hashToken } = await import("../../auth.js");
    const { registerProjectTaskQueueRoutes } = await import("./task-queue-routes.js");
    const app = Fastify();
    closeApp = () => app.close();
    app.addHook("onRequest", authHook);
    registerProjectTaskQueueRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const canvasId = randomUUID();
    const otherCanvasId = randomUUID();
    await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'Queue HTTP'), (${otherProjectId}, 'Other queue')`;
    await sql`INSERT INTO canvases (id, project_id, title) VALUES
      (${canvasId}, ${projectId}, 'Queued task'), (${otherCanvasId}, ${otherProjectId}, 'Other task')`;
    await sql`INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
      VALUES (${projectId}, ${canvasId}, 'hub_reason', 'pending', '{}', '{}')`;

    const tokenFor = async (scopes: string[]) => {
      const prefix = randomBytes(4).toString("hex");
      const token = `deepsonar_ci_${prefix}_${randomBytes(24).toString("base64url")}`;
      await sql`INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('queue fixture', ${projectId}, ${prefix}, ${hashToken(token)}, ${scopes})`;
      return { authorization: `Bearer ${token}` };
    };
    const reader = await tokenFor(["tasks:read"]);
    const controller = await tokenFor(["tasks:read", "jobs:control"]);
    const path = `/projects/${projectId}/task-queue`;

    assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: path, headers: reader })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/projects/${otherProjectId}/task-queue`, headers: reader })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: path, headers: reader, payload: { paused: true } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: path, headers: controller, payload: { paused: true, unknown: true } })).statusCode, 400);

    const enqueue = (id: string) => app.inject({ method: "POST", url: `${path}/items`, headers: controller, payload: { canvas_id: id } });
    const foreign = await enqueue(otherCanvasId);
    assert.equal(foreign.statusCode, 409, foreign.payload);
    assert.equal(foreign.json().error_code, "QUEUE_PROJECT_MISMATCH");
    const first = await enqueue(canvasId);
    assert.equal(first.statusCode, 200, first.payload);
    const second = await enqueue(canvasId);
    assert.equal(second.statusCode, 200, second.payload);
    assert.equal(second.json().items[0].id, first.json().items[0].id);
    assert.equal(second.json().items[0].state, "queued");
    assert.deepEqual(Object.keys(second.json()).sort(), ["has_more", "items", "pause_reason", "paused", "project_id"]);
    assert.equal(second.json().has_more, false);
    assert.equal((await app.inject({ method: "PATCH", url: path, headers: controller,
      payload: { paused: true, acknowledge_failed_head: second.json().items[0].id } })).statusCode, 400);

    const paused = await app.inject({ method: "PATCH", url: path, headers: controller, payload: { paused: true } });
    assert.equal(paused.statusCode, 200, paused.payload);
    assert.equal(paused.json().paused, true);
    const resumed = await app.inject({ method: "PATCH", url: path, headers: controller, payload: { paused: false } });
    assert.equal(resumed.statusCode, 200, resumed.payload);
    assert.equal(resumed.json().paused, false);
    const auditRows = await sql`SELECT after_json FROM audit_logs
      WHERE project_id = ${projectId} AND action = 'task_queue.enqueue' ORDER BY id`;
    assert.equal(auditRows.length, 2);
    assert.equal(auditRows[0].after_json.canvas_id, canvasId);
    const [count] = await sql`SELECT count(*)::int AS count FROM project_task_queue_items WHERE project_id = ${projectId}`;
    assert.equal(count.count, 1);
  } finally {
    if (closeApp) await closeApp();
    if (closeSql) await closeSql();
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});
