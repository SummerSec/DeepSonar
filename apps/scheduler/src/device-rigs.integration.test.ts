import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

type FakeBroker = {
  server: http.Server;
  port: number;
  pushes: Array<{ authorization: string; devices: Array<{ key: string }>; revision: number }>;
  revision: number;
  /** true 时让 PUT /rig/devices 返回 500，用于验证一个 rig 失败不影响其它 rig。 */
  failing: boolean;
};

function startFakeBroker(mode: string): Promise<FakeBroker> {
  const state = {
    server: null as unknown as http.Server,
    port: 0,
    pushes: [] as FakeBroker["pushes"],
    revision: 0,
    failing: false,
  };
  const server = http.createServer((request, response) => {
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
            revision: state.revision,
            reconciled: true,
            mode,
            usable: [],
          }),
        );
        return;
      }
      if (request.url === "/rig/devices" && request.method === "PUT") {
        if (state.failing) {
          response.writeHead(500).end(JSON.stringify({ error: "boom" }));
          return;
        }
        state.revision = Number(body.revision ?? state.revision);
        state.pushes.push({
          authorization: String(request.headers.authorization ?? ""),
          devices: (body.devices ?? []) as Array<{ key: string }>,
          revision: state.revision,
        });
        response.writeHead(200).end(JSON.stringify({ revision: state.revision, mode }));
        return;
      }
      response.writeHead(200).end(JSON.stringify({ ok: true, released: true }));
    });
  });
  state.server = server;
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      state.port = (server.address() as { port: number }).port;
      resolve();
    }),
  ).then(() => state as FakeBroker);
}

/**
 * 多 rig（#505 后续）：平台按 `devices.rig_id` 分组推送，每个 rig 只收到自己的集合；
 * 一个 rig 失败不影响其它 rig，且写操作仍然落库（DB 是平台侧真相）。
 */
if (testDatabaseUrl) {
  test("device admission pushes each rig its own set, isolates failures and rejects unknown rigs", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_device_rigs_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    const brokers: FakeBroker[] = [];

    try {
      const defaultBroker = await startFakeBroker("platform");
      const rigBBroker = await startFakeBroker("env-legacy");
      brokers.push(defaultBroker, rigBBroker);

      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "44".repeat(32);
      process.env.DEEPSONAR_DEVICE_ENABLED = "true";
      process.env.DEEPSONAR_DEVICE_TRANSPORTS = "adb,hdc";
      process.env.DEEPSONAR_DEVICE_BROKER_URL = `http://127.0.0.1:${defaultBroker.port}`;
      process.env.DEEPSONAR_DEVICE_BROKER_TOKEN = "broker-inbound-token";
      process.env.DEEPSONAR_DEVICE_LEASE_SECRET = "shared-lease-secret-0123456789abcdef";
      // 具名 rig + 一条非法条目（非法条目必须被丢弃并在管理面可见）。
      process.env.DEEPSONAR_DEVICE_RIGS =
        `rig-b=http://127.0.0.1:${rigBBroker.port}|broker-token-b;bogus-entry`;

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

      const adminToken = generateToken();
      await sql`
        INSERT INTO api_tokens (name, token_prefix, token_hash, scopes)
        VALUES ('device-rig-admin', ${adminToken.prefix}, ${adminToken.hash}, ${["admin", "tasks:read"]})`;
      const auth = `Bearer ${adminToken.plaintext}`;
      const post = (payload: Record<string, unknown>) =>
        app.inject({ method: "POST", url: "/devices", headers: { authorization: auth }, payload });

      // 1) 默认 rig 的设备只出现在默认 rig 的集合里；rig-b 收到的是空集（整集替换语义）。
      const onDefault = await post({ key: "dev-default", transport: "adb" });
      assert.equal(onDefault.statusCode, 201, onDefault.payload);
      assert.deepEqual(defaultBroker.pushes.at(-1)?.devices.map((d) => d.key), ["dev-default"]);
      assert.deepEqual(rigBBroker.pushes.at(-1)?.devices, []);
      assert.equal(defaultBroker.pushes.at(-1)?.authorization, "Bearer broker-inbound-token");
      assert.equal(rigBBroker.pushes.at(-1)?.authorization, "Bearer broker-token-b");

      // 2) 登记到 rig-b 的设备不会出现在默认 rig 的集合里（跨 rig 隔离）。
      const onRigB = await post({ key: "dev-b", transport: "adb", rig_id: "rig-b" });
      assert.equal(onRigB.statusCode, 201, onRigB.payload);
      assert.deepEqual(rigBBroker.pushes.at(-1)?.devices.map((d) => d.key), ["dev-b"]);
      assert.deepEqual(defaultBroker.pushes.at(-1)?.devices.map((d) => d.key), ["dev-default"]);
      assert.equal((onRigB.json().device as { rig_id: string }).rig_id, "rig-b");
      assert.equal(
        (onRigB.json().rig_pushes as Array<{ rig: string; ok: boolean }>).every((entry) => entry.ok),
        true,
        onRigB.payload,
      );

      // 3) 未配置的 rig 一律拒绝，且不产生任何推送。
      const pushesBefore = defaultBroker.pushes.length + rigBBroker.pushes.length;
      const unknownRig = await post({ key: "dev-ghost", transport: "adb", rig_id: "rig-missing" });
      assert.equal(unknownRig.statusCode, 400, unknownRig.payload);
      assert.match(unknownRig.payload, /INVALID_RIG/);
      assert.equal(defaultBroker.pushes.length + rigBBroker.pushes.length, pushesBefore);
      const [{ ghosts }] = await sql<Array<{ ghosts: number }>>`
        SELECT count(*)::int AS ghosts FROM devices WHERE key = 'dev-ghost'`;
      assert.equal(ghosts, 0);

      // 4) 列表按 rig 回报准入状态：每个 rig 的模式来自各自的 broker；非法配置条目可见。
      const listed = await app.inject({ method: "GET", url: "/devices", headers: { authorization: auth } });
      assert.equal(listed.statusCode, 200, listed.payload);
      const registry = listed.json() as {
        devices: Array<{ key: string; rig_id: string }>;
        rig: {
          rigs: Array<{ id: string; admission: { mode: string } | null }>;
          invalid_entries: string[];
        };
      };
      assert.deepEqual(
        registry.devices.map((device) => [device.key, device.rig_id]).sort(),
        [
          ["dev-b", "rig-b"],
          ["dev-default", "default"],
        ],
      );
      assert.deepEqual(
        registry.rig.rigs.map((rig) => [rig.id, rig.admission?.mode]),
        [
          ["default", "platform"],
          ["rig-b", "env-legacy"],
        ],
      );
      assert.equal(registry.rig.invalid_entries.length, 1);
      assert.match(registry.rig.invalid_entries[0] ?? "", /id=/);

      // 5) 一个 rig 不可达不影响另一个 rig，也不回滚平台侧写入。
      rigBBroker.failing = true;
      const toMaintenance = await app.inject({
        method: "PATCH",
        url: `/devices/${String((onRigB.json().device as { id: string }).id)}`,
        headers: { authorization: auth },
        payload: { action: "maintenance" },
      });
      assert.equal(toMaintenance.statusCode, 200, toMaintenance.payload);
      const pushes = toMaintenance.json().rig_pushes as Array<{
        rig: string;
        ok: boolean;
        reason?: string;
        devices: number;
      }>;
      assert.deepEqual(
        pushes.map((entry) => [entry.rig, entry.ok, entry.reason ?? null]).sort(),
        [
          ["default", true, null],
          ["rig-b", false, "unavailable"],
        ],
      );
      const [rigBDevice] = await sql<Array<{ status: string }>>`
        SELECT status FROM devices WHERE key = 'dev-b'`;
      assert.equal(rigBDevice.status, "maintenance");
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      for (const broker of brokers) {
        await new Promise<void>((resolve) => broker.server.close(() => resolve()));
      }
      if (databaseCreated)
        await admin
          .unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
          .catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
