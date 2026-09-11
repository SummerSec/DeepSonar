import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("scheduler seeds a local worker and dispatches through the worker plane", () => {
  const index = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../../runtime.ts", import.meta.url), "utf8");
  const health = readFileSync(new URL("../../opensandbox-health.ts", import.meta.url), "utf8");
  const auth = readFileSync(new URL("../../auth.ts", import.meta.url), "utf8");
  assert.match(index, /seedLocalWorkerNode\(\)/);
  assert.match(runtime, /createWorkerPlaneOpenSandboxClient/);
  assert.match(runtime, /useServerProxy: true/);
  assert.match(health, /listWorkerNodes\(\)/);
  assert.match(auth, /\/workers\/register/);
  assert.match(auth, /\/workers\/heartbeat/);
  assert.match(auth, /DELETE \/workers\/:id/);
  const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.match(routes, /audit\(/);
  assert.match(routes, /consumeWorkerRateLimit|consumePlaneRateLimit/);
  assert.match(routes, /forgetWorkerNode/);
  const registry = readFileSync(new URL("./registry.ts", import.meta.url), "utf8");
  assert.match(registry, /WORKER_NODE_RESERVED/);
  assert.match(registry, /WORKER_NODE_EXISTS/);
  assert.match(registry, /shouldReuseLocalWorkerToken/);
  assert.doesNotMatch(registry, /ON CONFLICT \(id\) DO UPDATE SET\s+endpoint = excluded.endpoint[\s\S]*kind = excluded.kind/);
});

test("reaper and reconcile reclaim sandbox leases for terminal jobs", () => {
  const reaper = readFileSync(new URL("../../reaper.ts", import.meta.url), "utf8");
  const reconcile = readFileSync(new URL("../../reconcile.ts", import.meta.url), "utf8");
  assert.match(reaper, /releaseOrphanSandboxLeases\(\)/);
  assert.match(reconcile, /releaseOrphanSandboxLeases\(\)/);
});
