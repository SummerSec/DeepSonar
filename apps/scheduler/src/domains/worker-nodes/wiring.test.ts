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
});
