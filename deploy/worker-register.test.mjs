import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { workerReleaseIdentity, WORKER_PROTOCOL_VERSION } from "./worker-register-contract.mjs";

test("worker agent declares its release and stable registration protocol, never OpenSandbox version", () => {
  const identity = workerReleaseIdentity({ DEEPSONAR_VERSION: "0.5.7", OPEN_SANDBOX_VERSION: "99.99.99" });
  assert.deepEqual(identity, { body: { protocol_version: 1, platform_version: "0.5.7", deployment_generation: "" }, headers: {} });
  const server = readFileSync(new URL("../apps/scheduler/src/domains/worker-nodes/model.ts", import.meta.url), "utf8");
  assert.ok(server.includes(`export const WORKER_PROTOCOL_VERSION = ${WORKER_PROTOCOL_VERSION};`));
  assert.throws(() => workerReleaseIdentity({}), /requires DEEPSONAR_VERSION/);
});

test("managed generation requires independent enrollment token and puts it only in a header", () => {
  assert.throws(() => workerReleaseIdentity({ DEEPSONAR_VERSION: "0.5.7", DEEPSONAR_DEPLOYMENT_GENERATION: "g" }), /enrollment token/);
  const value = workerReleaseIdentity({ DEEPSONAR_VERSION: "0.5.7", DEEPSONAR_DEPLOYMENT_GENERATION: "g", DEEPSONAR_WORKER_GENERATION_TOKEN: "fixture-secret" });
  assert.equal(value.headers["x-deepsonar-worker-generation-token"], "fixture-secret");
  assert.equal(JSON.stringify(value.body).includes("fixture-secret"), false);
});

for (const preparing of [false, true]) test(preparing ? "candidate worker remains alive waiting for maintenance activation" : "fenced heartbeat explicitly re-enrolls the persisted installation with current generation credentials", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const directory = mkdtempSync(join(tmpdir(), "worker-enrollment-"));
  const tokenFile = join(directory, "node.token");
  writeFileSync(tokenFile, "existing-installation-token\n");
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
    res.setHeader("content-type", "application/json");
    if (preparing && req.url === "/workers/register") res.statusCode = 503;
    res.end(JSON.stringify(req.url === "/workers/heartbeat" ? { status: "unavailable" } : preparing ? { error_code: "PLATFORM_MAINTENANCE" } : { node_token: "existing-installation-token" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./worker-register.mjs", import.meta.url))], {
    env: { ...process.env, DEEPSONAR_CONTROL_PLANE: `http://127.0.0.1:${server.address().port}`,
      DEEPSONAR_WORKER_BOOTSTRAP_TOKEN: "bootstrap-fixture", DEEPSONAR_WORKER_NODE_ID: "same-installation",
      DEEPSONAR_WORKER_ENDPOINT: "10.0.0.4:18081", OPEN_SANDBOX_API_KEY: "sandbox-fixture",
      DEEPSONAR_WORKER_TOKEN_FILE: tokenFile, DEEPSONAR_VERSION: "0.5.7", DEEPSONAR_DEPLOYMENT_GENERATION: "generation-fixture",
      DEEPSONAR_WORKER_GENERATION_TOKEN: "generation-secret-fixture" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker enrollment timed out")), 5000);
      child.stdout.on("data", data => { if (String(data).includes(preparing ? "waiting for platform generation activation" : "online")) { clearTimeout(timeout); resolve(); } });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`worker exited ${code}`)); });
    });
    assert.equal(child.exitCode, null);
    assert.deepEqual(requests.map(request => request.path), ["/workers/heartbeat", "/workers/register"]);
    assert.equal(requests[1].headers.authorization, "Bearer bootstrap-fixture");
    assert.equal(requests[1].headers["x-deepsonar-worker-node-token"], "existing-installation-token");
    for (const request of requests) {
      assert.equal(request.headers["x-deepsonar-worker-generation-token"], "generation-secret-fixture");
      assert.equal(request.body.node_id, "same-installation");
      assert.equal(request.body.protocol_version, 1);
      assert.equal(request.body.platform_version, "0.5.7");
      assert.equal(request.body.deployment_generation, "generation-fixture");
      assert.equal(JSON.stringify(request.body).includes("generation-secret-fixture"), false);
    }
  } finally {
    child.kill("SIGTERM");
    await closed;
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
