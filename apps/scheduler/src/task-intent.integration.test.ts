import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import {
  TASK_INTENT_SAVED_IDLE,
  TASK_INTENT_SAVED_RUNNING,
} from "./task-intent.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("task intent patch integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("PATCH /tasks/:canvasId updates title/content without rewriting frozen job snapshots", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_task_intent_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

    process.env.DATABASE_URL = targetUrl.toString();
    process.env.AGENT_MODE = "fake";

    const Fastify = (await import("fastify")).default;
    const websocket = (await import("@fastify/websocket")).default;
    const { migrate, sql } = await import("./db.js");
    const { registerRoutes } = await import("./routes.js");
    await migrate();

    const app = Fastify();
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const runningCanvasId = randomUUID();
    const idleCanvasId = randomUUID();
    const archivedCanvasId = randomUUID();
    const runningJobId = randomUUID();
    const frozenSnapshot = { name: "hub_reason", model: "frozen-model", digest: "sha256:intent" };
    const frozenPayload = { title: "旧标题", content: "旧内容", goal: "旧内容" };
    const target = {
      title: "旧标题",
      content: "旧内容",
      goal: "旧内容",
      kind: "standard",
      network_policy: { allow_egress: false },
    };

    const patchTask = (canvasId: string, body: Record<string, string>) =>
      app.inject({ method: "PATCH", url: `/tasks/${canvasId}`, payload: body });

    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${projectId}, ${`issue-251-${randomUUID()}`}, ${`issue-251-${randomUUID()}`})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES
          (${runningCanvasId}, ${projectId}, '旧标题', ${sql.json(target as never)}),
          (${idleCanvasId}, ${projectId}, '空闲任务', ${sql.json({ ...target, title: "空闲任务" } as never)}),
          (${archivedCanvasId}, ${projectId}, '已归档', ${sql.json(target as never)})`;
      await sql`UPDATE canvases SET status = 'archived', archived_at = now() WHERE id = ${archivedCanvasId}`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES
          (${runningCanvasId}, 'root', '旧标题', 'active', ${sql.json({ target } as never)}),
          (${idleCanvasId}, 'root', '空闲任务', 'active', ${sql.json({ target: { ...target, title: "空闲任务" } } as never)})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, payload_json, agent_snapshot_json)
        VALUES (
          ${runningJobId}, ${projectId}, ${runningCanvasId}, 'hub_reason', 'running', 0,
          ${sql.json(frozenPayload as never)}, ${sql.json(frozenSnapshot as never)}
        )`;

      const empty = await patchTask(runningCanvasId, {});
      assert.equal(empty.statusCode, 400);
      assert.equal(empty.json().error_code, "INVALID_TASK_INTENT");

      const missing = await patchTask(randomUUID(), { title: "不存在" });
      assert.equal(missing.statusCode, 404);

      const archived = await patchTask(archivedCanvasId, { title: "不能改" });
      assert.equal(archived.statusCode, 409);
      assert.equal(archived.json().error_code, "TASK_ARCHIVED");

      const running = await patchTask(runningCanvasId, { title: "新标题", content: "新完成标准" });
      assert.equal(running.statusCode, 200, running.payload);
      const runningBody = running.json();
      assert.equal(runningBody.title, "新标题");
      assert.equal(runningBody.target_json.content, "新完成标准");
      assert.equal(runningBody.target_json.goal, "新完成标准");
      assert.equal(runningBody.target_json.kind, "standard");
      assert.deepEqual(runningBody.target_json.network_policy, { allow_egress: false });
      assert.equal(runningBody.has_active_jobs, true);
      assert.equal(runningBody.snapshot_rewritten, false);
      assert.equal(runningBody.message, TASK_INTENT_SAVED_RUNNING);

      const [canvas] = await sql`SELECT title, target_json FROM canvases WHERE id = ${runningCanvasId}`;
      assert.equal(canvas.title, "新标题");
      assert.equal((canvas.target_json as { content?: string }).content, "新完成标准");

      const [root] = await sql`
        SELECT title, body_json FROM canvas_nodes
        WHERE canvas_id = ${runningCanvasId} AND node_type = 'root'`;
      assert.equal(root.title, "新标题");
      assert.equal((root.body_json as { target?: { content?: string } }).target?.content, "新完成标准");

      const [job] = await sql`
        SELECT payload_json, agent_snapshot_json FROM jobs WHERE id = ${runningJobId}`;
      assert.deepEqual(job.payload_json, frozenPayload);
      assert.deepEqual(job.agent_snapshot_json, frozenSnapshot);

      const idle = await patchTask(idleCanvasId, { content: "仅改内容" });
      assert.equal(idle.statusCode, 200, idle.payload);
      assert.equal(idle.json().title, "空闲任务");
      assert.equal(idle.json().has_active_jobs, false);
      assert.equal(idle.json().message, TASK_INTENT_SAVED_IDLE);
      assert.equal(idle.json().target_json.content, "仅改内容");
      assert.equal(idle.json().target_json.goal, "仅改内容");
    } finally {
      await app.close().catch(() => undefined);
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
