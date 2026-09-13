import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (testDatabaseUrl) {
  test("device lease lifecycle is authorized, exclusive, audited and reaped", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_device_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let endSql: (() => Promise<unknown>) | null = null;
    let server: http.Server | null = null;
    const brokerCalls: Array<{ path: string; body: Record<string, unknown> }> =
      [];
    const leaseTtlSec = 600;

    // 假 broker：只验证 Scheduler 侧的授权/独占/回收语义，不依赖真机或 adb。
    server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        brokerCalls.push({
          path: String(request.url ?? ""),
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        response.setHeader("content-type", "application/json");
        if (request.url === "/lease/acquire") {
          const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          // 按请求的 transport 回话：broker 是设备真相，调度器只按契约解析（#504）。
          const transport = body.transport === "hdc" ? "hdc" : "adb";
          response.writeHead(201).end(
            JSON.stringify({
              lease_id: randomUUID(),
              device_key: String(
                body.device_key ??
                  (transport === "hdc" ? "target-oh-1" : "rig-1"),
              ),
              model: transport === "hdc" ? null : "Pixel-7",
              transport,
              endpoint: {
                transport,
                host: "127.0.0.1",
                port: transport === "hdc" ? 8710 : 5037,
                env: {},
              },
              token: "v1.fake-payload.fake-signature",
              expires_at: new Date(
                Date.now() + leaseTtlSec * 1000,
              ).toISOString(),
            }),
          );
          return;
        }
        response
          .writeHead(200)
          .end(JSON.stringify({ ok: true, released: true }));
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
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.DEEPSONAR_MASTER_KEY = "22".repeat(32);
      // broker 配置必须在 device 模块（及其 config）首次 import 之前就位。
      process.env.DEEPSONAR_DEVICE_ENABLED = "true";
      // #504：平台侧显式开启 adb 与 hdc 两条 transport。
      process.env.DEEPSONAR_DEVICE_TRANSPORTS = "adb,hdc";
      process.env.DEEPSONAR_DEVICE_BROKER_URL = `http://127.0.0.1:${brokerPort}`;
      process.env.DEEPSONAR_DEVICE_BROKER_TOKEN = "broker-inbound-token";
      process.env.DEEPSONAR_DEVICE_LEASE_SECRET =
        "shared-lease-secret-0123456789abcdef";

      const [dbModule, attemptModule, deviceModule] = await Promise.all([
        import("./db.js"),
        import("./domains/job-attempt/index.js"),
        import("./domains/device/index.js"),
      ]);
      const { sql, migrate } = dbModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const optOutProjectId = randomUUID();
      const canvasId = `device-${randomUUID()}`;
      await sql`INSERT INTO projects (id, name, config_json) VALUES (${projectId}, 'device rig', ${sql.json({ device_access_enabled: true } as never)})`;
      await sql`INSERT INTO projects (id, name, config_json) VALUES (${optOutProjectId}, 'device opt-out', ${sql.json({} as never)})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'device task', ${sql.json({ network_policy: { allow_egress: false } } as never)})`;
      await sql`INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json) VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({} as never)})`;

      const insertJob = async (
        targetProjectId: string,
        targetCanvasId: string,
        roleName: string,
      ) => {
        const jobId = randomUUID();
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
          VALUES (${jobId}, ${targetProjectId}, ${targetCanvasId}, ${roleName}, 'provisioning',
                  ${sql.json({} as never)}, ${sql.json({ name: roleName } as never)})`;
        const attempt = await attemptModule.createAttempt(sql, jobId, {
          agent_cli: "pi",
          adapter_id: "pi",
          adapter_version: "1",
          runtime_image_ref: "deepsonar-mobile:test",
        });
        return { jobId, attemptId: String(attempt.id) };
      };
      const requirement = {
        transport: "adb" as const,
        key: "rig-1",
        exclusive: true,
        ttl_sec: leaseTtlSec,
        roles: ["test"],
      };
      const snapshotFor = (roleName: string) => ({
        name: roleName,
        device_requirement: requirement,
        // 设备数据面是沙箱直连 rig 端点，所以设备任务必须允许出网（#506）。
        network_policy: { allow_egress: true },
      });

      // 1) 授权后租到设备：端点进 env、租约 active、设备 leased，token 不落库。
      const first = await insertJob(projectId, canvasId, "test");
      const lease = await deviceModule.acquireDeviceLeaseForJob({
        jobId: first.jobId,
        attemptId: first.attemptId,
        projectId,
        snapshot: snapshotFor("test"),
        roleName: "test",
      });
      assert.ok(lease, "authorized task must acquire a lease");
      assert.equal(lease.env.ANDROID_ADB_SERVER_ADDRESS, "127.0.0.1");
      assert.equal(lease.env.ANDROID_SERIAL, "rig-1");
      assert.equal(
        brokerCalls.filter((call) => call.path === "/lease/acquire").length,
        1,
      );
      const [leaseRow] = await sql`
        SELECT state, endpoint_json, attempt_id FROM device_leases WHERE job_id = ${first.jobId}`;
      assert.equal(leaseRow.state, "active");
      assert.equal(String(leaseRow.attempt_id), first.attemptId);
      assert.equal(
        JSON.stringify(leaseRow.endpoint_json).includes("fake-signature"),
        false,
      );
      assert.equal(
        JSON.stringify(leaseRow.endpoint_json).includes("token"),
        false,
      );
      const [leasedDevice] =
        await sql`SELECT status FROM devices WHERE key = 'rig-1'`;
      assert.equal(leasedDevice.status, "leased");

      // 2) 角色不在需求内：不占用设备。
      const hubJob = await insertJob(projectId, canvasId, "hub_reason");
      const noDevice = await deviceModule.acquireDeviceLeaseForJob({
        jobId: hubJob.jobId,
        attemptId: hubJob.attemptId,
        projectId,
        snapshot: snapshotFor("hub_reason"),
        roleName: "hub_reason",
      });
      assert.equal(noDevice, null);
      assert.equal(
        brokerCalls.filter((call) => call.path === "/lease/acquire").length,
        1,
      );

      // 3) 独占性：DB 部分唯一索引是最终仲裁者，broker 侧租约被回滚。
      const second = await insertJob(projectId, canvasId, "test");
      await assert.rejects(
        () =>
          deviceModule.acquireDeviceLeaseForJob({
            jobId: second.jobId,
            attemptId: second.attemptId,
            projectId,
            snapshot: snapshotFor("test"),
            roleName: "test",
          }),
        (error: unknown) =>
          (error as { code?: string }).code === "device_not_available",
      );
      assert.equal(
        brokerCalls.filter((call) => call.path === "/lease/release").length,
        1,
      );
      const [secondLease] =
        await sql`SELECT count(*)::int AS count FROM device_leases WHERE job_id = ${second.jobId}`;
      assert.equal(secondLease.count, 0);

      // 4) 未 opt-in 项目：授权前置，broker 根本收不到请求。
      const optOutCanvasId = `device-optout-${randomUUID()}`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${optOutCanvasId}, ${optOutProjectId}, 'opt-out', ${sql.json({ network_policy: { allow_egress: false } } as never)})`;
      const optOut = await insertJob(optOutProjectId, optOutCanvasId, "test");
      await assert.rejects(
        () =>
          deviceModule.acquireDeviceLeaseForJob({
            jobId: optOut.jobId,
            attemptId: optOut.attemptId,
            projectId: optOutProjectId,
            snapshot: snapshotFor("test"),
            roleName: "test",
          }),
        (error: unknown) =>
          (error as { code?: string }).code === "device_not_authorized",
      );
      assert.equal(
        brokerCalls.filter((call) => call.path === "/lease/acquire").length,
        2,
      );

      // 5) 终态释放：租约 released、设备回 idle，broker 收到释放。
      assert.equal(
        await deviceModule.releaseDeviceLeasesForJob(
          first.jobId,
          "attempt_terminal",
        ),
        1,
      );
      const [released] = await sql`
        SELECT state, release_reason FROM device_leases WHERE job_id = ${first.jobId}`;
      assert.deepEqual(released, {
        state: "released",
        release_reason: "attempt_terminal",
      });
      const [idleDevice] =
        await sql`SELECT status FROM devices WHERE key = 'rig-1'`;
      assert.equal(idleDevice.status, "idle");
      // 幂等：重复释放不再改动任何行。
      assert.equal(
        await deviceModule.releaseDeviceLeasesForJob(
          first.jobId,
          "attempt_terminal",
        ),
        0,
      );

      // 6) Reaper 兜底：过期租约 → expired + 设备 idle，并留下 device_events 审计。
      const reapTarget = await insertJob(projectId, canvasId, "test");
      const reaped = await deviceModule.acquireDeviceLeaseForJob({
        jobId: reapTarget.jobId,
        attemptId: reapTarget.attemptId,
        projectId,
        snapshot: snapshotFor("test"),
        roleName: "test",
      });
      assert.ok(reaped);
      await sql`UPDATE device_leases SET expires_at = now() - interval '1 minute' WHERE id = ${reaped.leaseId}`;
      assert.equal(await deviceModule.reapExpiredDeviceLeases(), 1);
      const [expired] =
        await sql`SELECT state, release_reason FROM device_leases WHERE id = ${reaped.leaseId}`;
      assert.deepEqual(expired, {
        state: "expired",
        release_reason: "expired",
      });
      const [idleAgain] =
        await sql`SELECT status FROM devices WHERE key = 'rig-1'`;
      assert.equal(idleAgain.status, "idle");
      const events = await sql`
        SELECT action FROM device_events WHERE lease_id = ${reaped.leaseId} ORDER BY id`;
      assert.deepEqual(
        events.map((row) => row.action),
        ["lease_acquire", "lease_expired"],
      );

      // 7) 出网前置（#506）：快照未允许出网时，申请阶段就 fail closed，broker 收不到请求。
      const noEgress = await insertJob(projectId, canvasId, "test");
      await assert.rejects(
        () =>
          deviceModule.acquireDeviceLeaseForJob({
            jobId: noEgress.jobId,
            attemptId: noEgress.attemptId,
            projectId,
            snapshot: { name: "test", device_requirement: requirement },
            roleName: "test",
          }),
        (error: unknown) =>
          (error as { code?: string }).code === "device_not_authorized",
      );
      assert.equal(
        brokerCalls.filter((call) => call.path === "/lease/acquire").length,
        3,
      );
      const [noEgressLease] =
        await sql`SELECT count(*)::int AS count FROM device_leases WHERE job_id = ${noEgress.jobId}`;
      assert.equal(noEgressLease.count, 0);

      // 8) 冻结前置（#506）：画布声明设备需求但未允许出网 → 建 Job 阶段就拒；允许出网才附加进快照。
      const freezeNoEgressCanvas = `device-freeze-${randomUUID()}`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${freezeNoEgressCanvas}, ${projectId}, 'freeze no egress', ${sql.json({ network_policy: { allow_egress: false }, device_requirement: requirement } as never)})`;
      await assert.rejects(
        () =>
          deviceModule.freezeSnapshotDeviceRequirement(
            sql,
            projectId,
            freezeNoEgressCanvas,
            {
              name: "test",
              network_policy: { allow_egress: false },
            },
          ),
        (error: unknown) =>
          (error as { code?: string }).code === "device_not_authorized",
      );
      const freezeOkCanvas = `device-freeze-ok-${randomUUID()}`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${freezeOkCanvas}, ${projectId}, 'freeze ok', ${sql.json({ network_policy: { allow_egress: true }, device_requirement: requirement } as never)})`;
      const frozen = await deviceModule.freezeSnapshotDeviceRequirement(
        sql,
        projectId,
        freezeOkCanvas,
        {
          name: "test",
          network_policy: { allow_egress: true },
        },
      );
      assert.deepEqual(frozen.device_requirement, requirement);

      // 9) hdc transport（#504）：与 adb 同一套授权/租约/回收；env 走通用变量，不注入 ANDROID_*。
      const hdcRequirement = {
        transport: "hdc" as const,
        key: "target-oh-1",
        exclusive: true,
        ttl_sec: leaseTtlSec,
        roles: ["test"],
      };
      const hdcJob = await insertJob(projectId, canvasId, "test");
      const hdcLease = await deviceModule.acquireDeviceLeaseForJob({
        jobId: hdcJob.jobId,
        attemptId: hdcJob.attemptId,
        projectId,
        snapshot: {
          name: "test",
          device_requirement: hdcRequirement,
          network_policy: { allow_egress: true },
        },
        roleName: "test",
      });
      assert.ok(hdcLease, "hdc 需求也必须能租到设备");
      assert.equal(hdcLease.env.DEEPSONAR_DEVICE_TRANSPORT, "hdc");
      assert.equal(hdcLease.env.DEEPSONAR_DEVICE_ENDPOINT, "127.0.0.1:8710");
      assert.deepEqual(
        Object.keys(hdcLease.env).filter((key) => key.startsWith("ANDROID_")),
        [],
      );
      const [hdcDeviceRow] =
        await sql`SELECT transport, status FROM devices WHERE key = 'target-oh-1'`;
      assert.deepEqual(hdcDeviceRow, { transport: "hdc", status: "leased" });
      const [hdcLeaseRow] =
        await sql`SELECT state FROM device_leases WHERE job_id = ${hdcJob.jobId}`;
      assert.equal(hdcLeaseRow.state, "active");

      // 未实现的 transport 在授权阶段就拒（不可重试），broker 收不到请求。
      const acquiresBeforeSerial = brokerCalls.filter(
        (call) => call.path === "/lease/acquire",
      ).length;
      const serialJob = await insertJob(projectId, canvasId, "test");
      await assert.rejects(
        () =>
          deviceModule.acquireDeviceLeaseForJob({
            jobId: serialJob.jobId,
            attemptId: serialJob.attemptId,
            projectId,
            snapshot: {
              name: "test",
              device_requirement: { ...hdcRequirement, transport: "serial" },
              network_policy: { allow_egress: true },
            },
            roleName: "test",
          }),
        (error: unknown) =>
          (error as { code?: string }).code === "device_not_authorized",
      );
      assert.equal(
        brokerCalls.filter((call) => call.path === "/lease/acquire").length,
        acquiresBeforeSerial,
      );

      // 释放后 hdc 设备同样回到 idle。
      assert.equal(
        await deviceModule.releaseDeviceLeasesForJob(
          hdcJob.jobId,
          "attempt_terminal",
        ),
        1,
      );
      const [idleHdc] =
        await sql`SELECT status FROM devices WHERE key = 'target-oh-1'`;
      assert.equal(idleHdc.status, "idle");
    } finally {
      if (endSql) await endSql().catch(() => {});
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      if (databaseCreated) {
        await admin
          .unsafe(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
          )
          .catch(() => {});
        await admin
          .unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`)
          .catch(() => {});
      }
      await admin.end({ timeout: 5 }).catch(() => {});
    }
  });
} else {
  test("device lease integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
}
