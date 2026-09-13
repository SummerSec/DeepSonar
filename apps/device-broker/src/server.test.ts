import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrokerAdbDevice } from "./adb.js";
import type { BrokerDependencies } from "./config.js";
import { buildBrokerServer } from "./server.js";

const TOKEN = "scheduler-inbound-token";
const SECRET = "broker-lease-secret-0123456789abcdef";
const devices: BrokerAdbDevice[] = [
  { key: "rig-1", model: "Pixel-7", state: "device", transport: "adb" },
  { key: "rig-2", model: "Pixel-8", state: "device", transport: "adb" },
];

async function broker(overrides: Partial<BrokerDependencies> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-broker-test-"));
  const config: BrokerDependencies = {
    adbBin: "adb",
    allowedKeys: ["rig-1"],
    leaseTtlSecDefault: 900,
    leaseTtlSecMax: 3600,
    adbEndpointHost: "rig.internal",
    adbServerPort: 5037,
    leaseSecret: SECRET,
    inboundToken: TOKEN,
    auditLogPath: path.join(dir, "broker.jsonl"),
    port: 0,
    host: "127.0.0.1",
    ...overrides,
  };
  const app = buildBrokerServer({ config, enumerate: async () => devices });
  await app.ready();
  return { app, config, dir };
}

const auth = { authorization: `Bearer ${TOKEN}` };

test("acquire returns a grant with the adb endpoint and audits the decision", async () => {
  const { app, config, dir } = await broker();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: { job_id: "job-1", attempt_id: "attempt-1", project_id: "project-1", transport: "adb", ttl_sec: 600 },
    });
    assert.equal(response.statusCode, 201, response.payload);
    const grant = response.json();
    assert.equal(grant.device_key, "rig-1");
    assert.equal(grant.model, "Pixel-7");
    assert.equal(grant.endpoint.host, "rig.internal");
    assert.equal(grant.endpoint.port, 5037);
    assert.match(grant.token, /^v1\./u);

    // 沙箱侧用租约 token 查询短时端点。
    const session = await app.inject({
      method: "GET",
      url: "/session",
      headers: { authorization: `Bearer ${grant.token}` },
    });
    assert.equal(session.statusCode, 200, session.payload);
    assert.equal(session.json().device_key, "rig-1");

    const log = await fs.readFile(config.auditLogPath, "utf8");
    assert.match(log, /"action":"lease_acquire"/u);
    assert.match(log, /"outcome":"granted"/u);
    // 审计与日志都不得出现租约 token 本体。
    assert.equal(log.includes(grant.token), false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("acquire fails closed on missing token, unknown transport and unlisted device", async () => {
  const { app, dir } = await broker({ allowedKeys: [] });
  try {
    const noAuth = await app.inject({ method: "POST", url: "/lease/acquire", payload: {} });
    assert.equal(noAuth.statusCode, 401);

    const unsupported = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: { job_id: "j", attempt_id: "a", project_id: "p", transport: "hdc" },
    });
    assert.equal(unsupported.statusCode, 403);
    assert.equal(unsupported.json().error_code, "device_not_authorized");

    const notListed = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: { job_id: "j", attempt_id: "a", project_id: "p", transport: "adb" },
    });
    assert.equal(notListed.statusCode, 409);
    assert.equal(notListed.json().error_code, "device_not_available");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("release is idempotent and an unconfigured rig endpoint yields device_not_available", async () => {
  const { app, dir } = await broker();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: { job_id: "job-9", attempt_id: "attempt-9", project_id: "project-9", transport: "adb" },
    });
    const leaseId = response.json().lease_id as string;
    const released = await app.inject({
      method: "POST",
      url: "/lease/release",
      headers: auth,
      payload: { lease_id: leaseId, reason: "attempt_terminal" },
    });
    assert.equal(released.statusCode, 200);
    assert.equal(released.json().released, true);
    const again = await app.inject({
      method: "POST",
      url: "/lease/release",
      headers: auth,
      payload: { lease_id: leaseId },
    });
    assert.equal(again.json().released, true);
    const unknown = await app.inject({
      method: "POST",
      url: "/lease/release",
      headers: auth,
      payload: { lease_id: "11111111-1111-4111-8111-111111111111" },
    });
    assert.equal(unknown.json().released, false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rig without a sandbox-reachable endpoint host cannot hand out devices", async () => {
  const { app, dir } = await broker({ adbEndpointHost: "" });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: { job_id: "j", attempt_id: "a", project_id: "p", transport: "adb" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error_code, "device_not_available");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
