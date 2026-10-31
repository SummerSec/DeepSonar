import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATEWAY_PROXY_SCRIPT, GATEWAY_UPSTREAM_SOCKET_NAME } from "@deepsonar/runtime-sandbox";
import { relayTargetHost, startGatewayUpstreamSocket } from "./gateway-upstream-socket.js";

function listenHttp(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

function requestViaSocket(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "POST", agent: false, headers: { host: "scheduler:3100" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end("payload");
  });
}

/** Bind the fixed-port proxy script to a test port (mirrors runtime-behavior.test.ts). */
function proxyScriptOnPort(port: number): string {
  const script = GATEWAY_PROXY_SCRIPT.replace('server.listen(3100, "0.0.0.0");', `server.listen(${port}, "127.0.0.1");`);
  if (script === GATEWAY_PROXY_SCRIPT) throw new Error("failed to rebind Gateway proxy test port");
  return script;
}

test("relayTargetHost maps wildcard listeners to loopback", () => {
  assert.equal(relayTargetHost("0.0.0.0"), "127.0.0.1");
  assert.equal(relayTargetHost(""), "127.0.0.1");
  assert.equal(relayTargetHost("::"), "::1");
  assert.equal(relayTargetHost("10.0.0.5"), "10.0.0.5");
});

test("upstream socket relays HTTP to the Scheduler listener and survives recreation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-gw-sock-"));
  const seen: string[] = [];
  const { server, port } = await listenHttp((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(200, { "content-type": "text/plain" }).end(`ok ${req.url}`);
    });
  });
  try {
    const first = await startGatewayUpstreamSocket({ dir, socketName: "scheduler.sock", targetHost: "127.0.0.1", targetPort: port });
    assert.equal(first.path, join(dir, "scheduler.sock"));
    assert.equal(statSync(first.path).mode & 0o777, 0o666);
    assert.deepEqual(await requestViaSocket(first.path, "/gateway/v1/messages"), { status: 200, body: "ok /gateway/v1/messages" });
    // Simulate a container recreate: process goes away, socket file stays on the volume.
    await first.close();
    writeFileSync(join(dir, "unrelated"), "x");
    const second = await startGatewayUpstreamSocket({ dir, socketName: "scheduler.sock", targetHost: "127.0.0.1", targetPort: port });
    assert.deepEqual(await requestViaSocket(second.path, "/control/v1/jobs/j1"), { status: 200, body: "ok /control/v1/jobs/j1" });
    await second.close();
    assert.deepEqual(seen, ["POST /gateway/v1/messages payload", "POST /control/v1/jobs/j1 payload"]);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upstream socket refuses to replace a non-socket file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-gw-sock-"));
  try {
    writeFileSync(join(dir, "scheduler.sock"), "not a socket");
    await assert.rejects(
      startGatewayUpstreamSocket({ dir, socketName: "scheduler.sock", targetHost: "127.0.0.1", targetPort: 1 }),
      /不是 Unix socket/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#685 sandbox -> managed proxy -> socket relay -> Scheduler TCP, with Scheduler recreated in between", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ds-gw-e2e-"));
  const { server, port } = await listenHttp((req, res) => {
    res.writeHead(200).end(`scheduler ${req.url}`);
  });
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const proxyPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  let relay = await startGatewayUpstreamSocket({ dir, socketName: GATEWAY_UPSTREAM_SOCKET_NAME, targetHost: "127.0.0.1", targetPort: port });
  const proxy = spawn(process.execPath, ["-e", proxyScriptOnPort(proxyPort)], {
    env: {
      ...process.env,
      DEEPSONAR_GATEWAY_UPSTREAM: "http://scheduler:3100/gateway",
      DEEPSONAR_GATEWAY_UPSTREAM_SOCKET: relay.path,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    proxy.kill("SIGKILL");
    await relay.close();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const get = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await get("/_deepsonar_health").then((r) => r.status === 200, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "proxy did not start");
  assert.deepEqual(await get("/gateway/v1/models"), { status: 200, body: "scheduler /gateway/v1/models" });
  assert.equal((await get("/api/v1/settings")).status, 404);
  // Scheduler container recreated: relay down -> 502, relay back on the same path -> recovers.
  await relay.close();
  assert.equal((await get("/control/v1/jobs/j1")).status, 502);
  relay = await startGatewayUpstreamSocket({ dir, socketName: GATEWAY_UPSTREAM_SOCKET_NAME, targetHost: "127.0.0.1", targetPort: port });
  assert.deepEqual(await get("/control/v1/jobs/j1"), { status: 200, body: "scheduler /control/v1/jobs/j1" });
});
