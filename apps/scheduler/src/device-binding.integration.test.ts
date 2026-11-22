import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

/**
 * #1211 现场：设备已登记、设备代理也说可用，任务却报「当前环境没有可用模拟器」。
 * 真实事实是 Job 快照与画布都没有 `device_requirement`，调度器从未申请租约。
 * 这里在真实 PG 上核对 `GET /jobs/:id` 的 device_binding 只投影平台记录。
 */
if (testDatabaseUrl) {
  test("job detail explains device binding from platform records only", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_device_binding_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./auth.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { sql, migrate } = dbModule;
      const { generateToken } = authModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const plainCanvasId = `binding-plain-${randomUUID()}`;
      const declaredCanvasId = `binding-declared-${randomUUID()}`;
      const leasedCanvasId = `binding-leased-${randomUUID()}`;
      await sql`INSERT INTO projects (id, name, config_json) VALUES (${projectId}, '设备绑定诊断', ${sql.json({ device_access_enabled: true } as never)})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${plainCanvasId}, ${projectId}, '未声明设备', ${sql.json({} as never)})`;
      const requirement = { transport: "hdc" as const, rig_id: "local-sim", exclusive: true, ttl_sec: 1800, roles: ["test"] };
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${declaredCanvasId}, ${projectId}, '画布声明设备', ${sql.json({ device_requirement: requirement } as never)})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${leasedCanvasId}, ${projectId}, '有租约', ${sql.json({ device_requirement: requirement } as never)})`;

      const insertJob = async (canvasId: string, snapshot: Record<string, unknown>) => {
        const jobId = randomUUID();
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
          VALUES (${jobId}, ${projectId}, ${canvasId}, 'test', 'running', ${sql.json({} as never)}, ${sql.json(snapshot as never)})`;
        return jobId;
      };
      const plainJobId = await insertJob(plainCanvasId, { name: "test" });
      const declaredJobId = await insertJob(declaredCanvasId, { name: "test" });
      const leasedJobId = await insertJob(leasedCanvasId, { name: "test", device_requirement: requirement });

      const deviceId = randomUUID();
      await sql`
        INSERT INTO devices (id, project_id, key, transport, rig_id, status)
        VALUES (${deviceId}, ${projectId}, 'local-sim-01', 'hdc', 'local-sim', 'idle')`;
      await sql`
        INSERT INTO device_leases (device_id, job_id, project_id, state, granted_at, released_at, release_reason)
        VALUES (${deviceId}, ${leasedJobId}, ${projectId}, 'released', now(), now(), 'attempt_terminal')`;

      const token = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('设备绑定诊断 Token', ${projectId}, ${token.prefix}, ${token.hash}, ${["tasks:read"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const app = Fastify({ logger: false });
      await app.register(websocket);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const read = async (jobId: string) => {
        const response = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers });
        assert.equal(response.statusCode, 200);
        return response.json().device_binding as Record<string, unknown>;
      };

      const plain = await read(plainJobId);
      assert.equal(plain.state, "not_declared");
      assert.equal(plain.role_matched, false);
      assert.deepEqual(plain.leases, []);
      assert.equal(plain.connection_result_recorded, false);
      assert.doesNotMatch(String(plain.reason), /连接失败|设备不可用/);

      const declared = await read(declaredJobId);
      assert.equal(declared.state, "declared_no_lease");
      assert.equal(declared.snapshot_requirement, null);
      assert.deepEqual(declared.canvas_requirement, { roles: ["test"], transport: "hdc", rig_id: "local-sim" });
      assert.match(String(declared.reason), /Job 快照没有冻结该需求/);

      const leased = await read(leasedJobId);
      assert.equal(leased.state, "lease_recorded_unverified");
      assert.equal(leased.connection_result_recorded, false);
      const leases = leased.leases as Array<Record<string, unknown>>;
      assert.equal(leases.length, 1);
      assert.equal(leases[0]?.device_key, "local-sim-01");
      assert.equal(leases[0]?.state, "released");
      assert.equal(leases[0]?.release_reason, "attempt_terminal");
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  });
}