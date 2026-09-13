import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

/**
 * 设备准入管理面（#505 阶段 1）：平台是权威。
 * 覆盖注册/重复登记、项目隔离、在途租约冲突、强制释放、事件回放，以及"写操作后把期望集合推给 rig"。
 */
if (testDatabaseUrl) {
  test("device admission management routes register, isolate, guard leases and push to the rig", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_device_mgmt_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    let server: http.Server | null = null;
    const rigPushes: Array<Record<string, unknown>> = [];
    let rigRevision = 0;

    // 假 broker：验证平台是权威（期望集合整集推送），不依赖真机或 adb。
    server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        response.setHeader("content-type", "application/json");
        if (request.url === "/rig/devices" && request.method === "GET") {
          response.writeHead(200).end(
            JSON.stringify({
              revision: rigRevision,
              reconciled: true,
              mode: "platform",
              usable: [],
            }),
          );
          return;
        }
        if (request.url === "/rig/devices" && request.method === "PUT") {
          rigPushes.push(body);
          rigRevision = Number(body.revision ?? rigRevision);
          response
            .writeHead(200)
            .end(JSON.stringify({ revision: rigRevision, mode: "platform" }));
          return;
        }
        response.writeHead(200).end(JSON.stringify({ ok: true, released: true }));
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const brokerPort = (server.address() as { port: number }).port;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "33".repeat(32);
      // 设备配置必须在 device 模块（及其 config）首次 import 之前就位。
      process.env.DEEPSONAR_DEVICE_ENABLED = "true";
      process.env.DEEPSONAR_DEVICE_TRANSPORTS = "adb,hdc";
      process.env.DEEPSONAR_DEVICE_BROKER_URL = `http://127.0.0.1:${brokerPort}`;
      process.env.DEEPSONAR_DEVICE_BROKER_TOKEN = "broker-inbound-token";
      process.env.DEEPSONAR_DEVICE_LEASE_SECRET =
        "shared-lease-secret-0123456789abcdef";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule] =
        await Promise.all([
          import("fastify"),
          import("@fastify/websocket"),
          import("./db.js"),
          import("./routes.js"),
          import("./auth.js"),
        ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { generateToken } = authModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const projectA = randomUUID();
      const projectB = randomUUID();
      const canvasId = `device-mgmt-${randomUUID()}`;
      await sql`INSERT INTO projects (id, name, config_json) VALUES (${projectA}, 'managed rig', ${sql.json({ device_access_enabled: true } as never)})`;
      await sql`INSERT INTO projects (id, name, config_json) VALUES (${projectB}, 'other project', ${sql.json({} as never)})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectA}, 'device mgmt', ${sql.json({} as never)})`;

      const insertToken = async (
        name: string,
        scopes: string[],
        projectId: string | null,
      ) => {
        const token = generateToken();
        await sql`
          INSERT INTO api_tokens (name, token_prefix, token_hash, scopes, project_id)
          VALUES (${name}, ${token.prefix}, ${token.hash}, ${scopes}, ${projectId})`;
        return `Bearer ${token.plaintext}`;
      };
      const adminAuth = await insertToken("device-admin", ["admin", "tasks:read"], null);
      const readAuth = await insertToken("device-reader", ["tasks:read"], null);
      const otherProjectAuth = await insertToken("device-project-b", ["admin", "tasks:read"], projectB);

      const request = (
        method: "GET" | "POST" | "PATCH" | "DELETE",
        url: string,
        authorization: string,
        payload?: Record<string, unknown>,
      ) =>
        app.inject({
          method,
          url,
          headers: { authorization },
          ...(payload ? { payload } : {}),
        });

      // 1) 登记：201 + 落库（status idle、broker_ref = broker 侧句柄）+ 期望集合推给 rig。
      const registered = await request("POST", "/devices", adminAuth, {
        key: "rig-9",
        transport: "adb",
        model: "Pixel-9",
        project_id: projectA,
      });
      assert.equal(registered.statusCode, 201, registered.payload);
      const device = registered.json().device as { id: string; status: string };
      assert.equal(device.status, "idle");
      assert.equal(registered.json().rig_push.ok, true, registered.payload);
      assert.deepEqual(
        (rigPushes.at(-1)?.devices as Array<{ key: string }>).map((d) => d.key),
        ["rig-9"],
      );
      const [deviceRow] = await sql<
        Array<{ project_id: string; status: string; broker_ref: string }>
      >`SELECT project_id, status, broker_ref FROM devices WHERE key = 'rig-9'`;
      assert.equal(deviceRow.project_id, projectA);
      assert.equal(deviceRow.broker_ref, "rig-9");

      // 2) 重复登记同一 key 是更新而不是新增（key 是设备身份）。
      const reRegistered = await request("POST", "/devices", adminAuth, {
        key: "rig-9",
        transport: "adb",
        project_id: projectA,
      });
      assert.equal(reRegistered.statusCode, 201, reRegistered.payload);
      assert.equal(reRegistered.json().device.id, device.id);
      const [{ count }] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM devices WHERE key = 'rig-9'`;
      assert.equal(count, 1);

      // 3) 非法输入：未实现的 transport / 不存在的项目一律 400，不进入 DB。
      const badTransport = await request("POST", "/devices", adminAuth, {
        key: "rig-bad",
        transport: "serial",
      });
      assert.equal(badTransport.statusCode, 400, badTransport.payload);
      const badProject = await request("POST", "/devices", adminAuth, {
        key: "rig-bad",
        transport: "adb",
        project_id: randomUUID(),
      });
      assert.equal(badProject.statusCode, 400, badProject.payload);
      assert.match(badProject.payload, /INVALID_PROJECT/);

      // 4) 项目隔离：项目 B 的 token 不能往项目 A 登记设备，也看不到它的设备。
      const crossProject = await request("POST", "/devices", otherProjectAuth, {
        key: "rig-9",
        transport: "adb",
        project_id: projectA,
      });
      assert.equal(crossProject.statusCode, 403, crossProject.payload);
      const otherList = await request("GET", "/devices", otherProjectAuth);
      assert.equal(otherList.statusCode, 200, otherList.payload);
      assert.deepEqual(otherList.json().devices, []);
      const adminList = await request("GET", "/devices", readAuth);
      assert.equal(adminList.statusCode, 200, adminList.payload);
      assert.equal(adminList.json().devices.length, 1);
      assert.equal(adminList.json().devices[0].key, "rig-9");

      // 5) scope：登记是管理面写操作，只有 tasks:read 的 token 必须 403。
      const readOnlyWrite = await request("POST", "/devices", readAuth, {
        key: "rig-10",
        transport: "adb",
      });
      assert.equal(readOnlyWrite.statusCode, 403, readOnlyWrite.payload);

      // 6) 在途租约冲突：下架与删除都必须 409，避免"已下架但还租着"。
      const jobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${jobId}, ${projectA}, ${canvasId}, 'test', 'running',
                ${sql.json({} as never)}, ${sql.json({ name: "test" } as never)})`;
      const leaseId = randomUUID();
      await sql`
        INSERT INTO device_leases (id, device_id, job_id, project_id, state, granted_by, granted_at, expires_at)
        VALUES (${leaseId}, ${device.id}, ${jobId}, ${projectA}, 'active', 'dispatcher', now(), now() + interval '10 minutes')`;
      await sql`UPDATE devices SET status = 'leased' WHERE id = ${device.id}`;

      const revokeBlocked = await request(
        "PATCH",
        `/devices/${device.id}`,
        adminAuth,
        { action: "revoke" },
      );
      assert.equal(revokeBlocked.statusCode, 409, revokeBlocked.payload);
      assert.match(revokeBlocked.payload, /DEVICE_HAS_ACTIVE_LEASE/);
      const deleteBlocked = await request(
        "DELETE",
        `/devices/${device.id}`,
        adminAuth,
      );
      assert.equal(deleteBlocked.statusCode, 409, deleteBlocked.payload);

      // 7) 租约可见性与强制释放：释放后设备回 idle，且期望集合重新下发。
      const leases = await request("GET", `/device-leases?device_id=${device.id}`, readAuth);
      assert.equal(leases.statusCode, 200, leases.payload);
      assert.equal(leases.json().leases.length, 1);
      assert.equal(leases.json().leases[0].state, "active");
      const released = await request(
        "POST",
        `/device-leases/${leaseId}/release`,
        adminAuth,
      );
      assert.equal(released.statusCode, 200, released.payload);
      assert.equal(released.json().released, 1);
      const [afterRelease] = await sql<Array<{ state: string }>>`
        SELECT state FROM device_leases WHERE id = ${leaseId}`;
      assert.equal(afterRelease.state, "released");
      const [idleDevice] = await sql<Array<{ status: string }>>`
        SELECT status FROM devices WHERE id = ${device.id}`;
      assert.equal(idleDevice.status, "idle");
      const releaseAgain = await request(
        "POST",
        `/device-leases/${leaseId}/release`,
        adminAuth,
      );
      assert.equal(releaseAgain.statusCode, 409, releaseAgain.payload);
      assert.match(releaseAgain.payload, /DEVICE_LEASE_NOT_ACTIVE/);

      // 8) 维护态下发时不进 rig 期望集合；enable 后重新进入。
      const toMaintenance = await request(
        "PATCH",
        `/devices/${device.id}`,
        adminAuth,
        { action: "maintenance" },
      );
      assert.equal(toMaintenance.statusCode, 200, toMaintenance.payload);
      assert.deepEqual(rigPushes.at(-1)?.devices, []);
      const toIdle = await request("PATCH", `/devices/${device.id}`, adminAuth, {
        action: "enable",
      });
      assert.equal(toIdle.statusCode, 200, toIdle.payload);
      assert.deepEqual(
        (rigPushes.at(-1)?.devices as Array<{ key: string }>).map((d) => d.key),
        ["rig-9"],
      );

      // 9) 非法动作 / 非法 id / 不存在的设备。
      const badAction = await request(
        "PATCH",
        `/devices/${device.id}`,
        adminAuth,
        { action: "delete-forever" },
      );
      assert.equal(badAction.statusCode, 400, badAction.payload);
      const badId = await request("GET", "/devices/not-a-uuid/events", readAuth);
      assert.equal(badId.statusCode, 400, badId.payload);
      assert.match(badId.payload, /INVALID_ID/);
      const missing = await request(
        "PATCH",
        `/devices/${randomUUID()}`,
        adminAuth,
        { action: "enable" },
      );
      assert.equal(missing.statusCode, 404, missing.payload);

      // 10) 事件时间线是 append-only 的审计链。
      const events = await request("GET", `/devices/${device.id}/events`, readAuth);
      assert.equal(events.statusCode, 200, events.payload);
      const actions = (
        events.json().events as Array<{ action: string; actor: string }>
      ).map((event) => event.action);
      assert.ok(actions.includes("device_register"), events.payload);
      assert.ok(actions.includes("device_status"), events.payload);
      assert.ok(actions.includes("lease_force_release"), events.payload);
      assert.equal(
        (events.json().events as Array<{ actor: string }>)[0]?.actor,
        "device-admin",
      );

      // 11) 有租约历史的登记项不能删除（外键 + append-only 审计），只能下架；
      //     下架即从 rig 准入集合摘掉。
      const deleteWithHistory = await request(
        "DELETE",
        `/devices/${device.id}`,
        adminAuth,
      );
      assert.equal(deleteWithHistory.statusCode, 409, deleteWithHistory.payload);
      assert.match(deleteWithHistory.payload, /DEVICE_HAS_LEASE_HISTORY/);
      const revoked = await request("PATCH", `/devices/${device.id}`, adminAuth, {
        action: "revoke",
      });
      assert.equal(revoked.statusCode, 200, revoked.payload);
      const [revokedRow] = await sql<Array<{ status: string }>>`
        SELECT status FROM devices WHERE id = ${device.id}`;
      assert.equal(revokedRow.status, "revoked");
      assert.deepEqual(rigPushes.at(-1)?.devices, []);
      const revokeAgain = await request("PATCH", `/devices/${device.id}`, adminAuth, {
        action: "enable",
      });
      assert.equal(revokeAgain.statusCode, 200, revokeAgain.payload);

      // 12) 从未租用过的登记项可以删除，并把空集合推给 rig。
      const scratch = await request("POST", "/devices", adminAuth, {
        key: "rig-scratch",
        transport: "adb",
        project_id: projectA,
      });
      assert.equal(scratch.statusCode, 201, scratch.payload);
      const scratchId = scratch.json().device.id as string;
      const deleted = await request("DELETE", `/devices/${scratchId}`, adminAuth);
      assert.equal(deleted.statusCode, 200, deleted.payload);
      // rig-9 在 step 11 已重新 enable，所以删除 scratch 后集合里只剩它。
      assert.deepEqual(
        (rigPushes.at(-1)?.devices as Array<{ key: string }>).map((d) => d.key),
        ["rig-9"],
      );
      const [{ remaining }] = await sql<Array<{ remaining: number }>>`
        SELECT count(*)::int AS remaining FROM devices WHERE key = 'rig-scratch'`;
      assert.equal(remaining, 0);
      const gone = await request("GET", `/devices/${scratchId}/events`, readAuth);
      assert.equal(gone.statusCode, 404, gone.payload);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (databaseCreated)
        await admin
          .unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
          .catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
