import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
type InjectResponse = { statusCode: number; payload: string; json(): any };

if (!testDatabaseUrl) {
  test("Platform API integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL 未设置",
  }, () => {});
} else {
  test("Job capability token 驱动 Platform API 完成闭环并保持幂等", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_platform_api_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;

    const projectId = randomUUID();
    const canvasId = randomUUID();
    const jobId = randomUUID();
    const operations = ["emit_fact", "emit_finding", "submit_hub_decision", "mark_job_done"];

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";

      const [{ default: Fastify }, dbModule, platformApi] = await Promise.all([
        import("fastify"),
        import("../../db.js"),
        import("./index.js"),
      ]);
      const { sql, migrate } = dbModule;
      const {
        clearPlatformApiIdempotencyCache,
        activateProvisionedJobCapabilityTokens,
        mintJobCapabilityToken,
        registerPlatformControlRoutes,
        registerRuntimeHandler,
        unregisterRuntimeHandler,
      } = platformApi;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const app = Fastify({ logger: false });
      registerPlatformControlRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const snapshot = { name: "audit", platform_tools: operations };
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'Platform API 集成测试')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'Platform API 集成测试')`;
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, agent_snapshot_json,
          started_at, timeout_sec, lease_expires_at
        ) VALUES (
          ${jobId}, ${projectId}, ${canvasId}, 'audit', 'provisioning', ${sql.json(snapshot)},
          now(), 3600, now() + interval '1 hour'
        )`;

      const grant = await mintJobCapabilityToken(jobId);
      const auth = { authorization: `Bearer ${grant.token}` };
      const base = `/control/v1/jobs/${jobId}`;
      const beforeRunning = await app.inject({ method: "GET", url: `${base}/agent/capabilities_list`, headers: auth });
      assert.equal(beforeRunning.statusCode, 409, beforeRunning.payload);
      assert.equal(beforeRunning.json().error_code, "CAPABILITY_JOB_NOT_ACTIVE");
      await sql`UPDATE jobs SET status = 'running', started_at = now() WHERE id = ${jobId}`;
      assert.equal(await activateProvisionedJobCapabilityTokens(jobId), 1);
      const calls: Array<{ operationId: string; eventId: string; input: unknown }> = [];
      const handler = async (context: { operationId: string; eventId: string; input: unknown }) => {
        calls.push(context);
        return { accepted: true, operation_id: context.operationId, event_id: context.eventId };
      };
      registerRuntimeHandler(jobId, handler, operations);

      const capabilities = await app.inject({ method: "GET", url: `${base}/agent/capabilities_list`, headers: auth });
      assert.equal(capabilities.statusCode, 200, capabilities.payload);
      const projection = capabilities.json();
      assert.deepEqual(projection.operation_ids, operations);
      assert.equal(projection.operations.length, operations.length);
      for (const operation of projection.operations) {
        assert.equal(operation.input_schema.type, "object");
      }
      assert.equal("token" in projection, false);

      const invoke = (operationId: string, key: string, payload: unknown) => app.inject({
        method: "POST",
        url: `${base}/operations/${operationId}`,
        headers: { ...auth, "idempotency-key": key },
        payload,
      } as never) as unknown as Promise<InjectResponse>;
      const factKey = randomUUID();
      const fact = {
        title: "控制 API 事实",
        description: "通过真实 Job token 和 HTTP 路由提交的集成测试事实。",
      };
      assert.equal((await invoke("emit_fact", factKey, fact)).statusCode, 200);
      assert.equal((await invoke("emit_fact", factKey, fact)).statusCode, 200);
      assert.equal(calls.filter((call) => call.operationId === "emit_fact").length, 1, "幂等重放不得重复调用 handler");
      const conflict = await invoke("emit_fact", factKey, { ...fact, title: "冲突事实" });
      assert.equal(conflict.statusCode, 409, conflict.payload);
      assert.equal(conflict.json().error_code, "IDEMPOTENCY_KEY_CONFLICT");

      unregisterRuntimeHandler(jobId);
      const findingKey = randomUUID();
      const finding = {
        title: "Platform API 集成验证发现",
        severity: "high",
        summary: "该发现用于验证控制 API 在运行时 handler 暂时不可用后可使用同一幂等键安全恢复。",
      };
      const unavailable = await invoke("emit_finding", findingKey, finding);
      assert.equal(unavailable.statusCode, 503, unavailable.payload);
      assert.equal(unavailable.json().error_code, "HANDLER_UNAVAILABLE");
      registerRuntimeHandler(jobId, handler, operations);
      assert.equal((await invoke("emit_finding", findingKey, finding)).statusCode, 200, "503 不得污染幂等缓存");

      assert.equal((await invoke("submit_hub_decision", randomUUID(), {
        complete: { from: [], description: "所有验证步骤已经完成并可以收敛。" },
      })).statusCode, 200);
      assert.equal((await invoke("mark_job_done", randomUUID(), {
        summary: "Platform API 集成闭环已经完成。",
      })).statusCode, 200);
      assert.deepEqual(calls.map((call) => call.operationId), operations);

      const narrowGrant = await mintJobCapabilityToken(jobId, { operationIds: ["emit_fact"] });
      const denied = await app.inject({
        method: "POST",
        url: `${base}/operations/emit_finding`,
        headers: { authorization: `Bearer ${narrowGrant.token}`, "idempotency-key": randomUUID() },
        payload: finding,
      });
      assert.equal(denied.statusCode, 403, denied.payload);
      assert.equal(denied.json().error_code, "OPERATION_NOT_ALLOWED");

      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${jobId}`;
      const terminal = await app.inject({ method: "GET", url: `${base}/capabilities`, headers: auth });
      assert.equal(terminal.statusCode, 409, terminal.payload);
      assert.equal(terminal.json().error_code, "CAPABILITY_JOB_NOT_ACTIVE");
      clearPlatformApiIdempotencyCache();
      unregisterRuntimeHandler(jobId);
    } finally {
      if (closeApp) await closeApp().catch(() => {});
      if (endSql) await endSql().catch(() => {});
      if (databaseCreated) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      }
      await admin.end({ timeout: 5 }).catch(() => {});
    }
  });
}
