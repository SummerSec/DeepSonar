import assert from "node:assert/strict";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import test from "node:test";
import { createPlatformMaintenanceGate, maintenanceIdentityMatches, registerPlatformMaintenanceGuard, type PlatformUpgradeState } from "./platform-maintenance.js";

const identity = { generation: "candidate-1", version: "1.2.3" };
const preparing: PlatformUpgradeState = { phase: "preparing", generation: identity.generation, runtime_role: "candidate", current_role: "candidate", target_version: identity.version };
function fixture() {
  let state: PlatformUpgradeState | null = { ...preparing };
  let unavailable = false;
  let starts = 0; let stops = 0;
  const gate = createPlatformMaintenanceGate({
    identity,
    readState: async () => { if (unavailable) throw new Error("DB unavailable"); return state; },
    start: (registerStop) => { starts++; registerStop(() => { stops++; }); },
  });
  return { gate, setState: (value: PlatformUpgradeState | null) => { state = value; }, unavailable: (value: boolean) => { unavailable = value; }, starts: () => starts, stops: () => stops };
}
test("baseline active requires empty generation, candidates bind generation, DB role and version", () => {
  assert.equal(maintenanceIdentityMatches(null, identity), false);
  assert.equal(maintenanceIdentityMatches({ ...preparing, phase: "active", generation: "", runtime_role: "" }, { generation: "", version: "" }), true);
  assert.equal(maintenanceIdentityMatches(preparing, { generation: "", version: "" }), false);
  for (const changed of [{ generation: "other" }, { current_role: "old" }, { runtime_role: "old" }, { target_version: "old" }, { phase: "invalid" }]) {
    assert.equal(maintenanceIdentityMatches({ ...preparing, ...changed }, identity), false);
  }
});
test("preparing does not start services; maintenance readiness waits for complete bootstrap", async () => {
  const f = fixture(); await f.gate.refresh();
  assert.equal(f.gate.status().maintenance_ready, false);
  f.gate.setBootReady(); await f.gate.refresh();
  assert.equal(f.gate.status().maintenance_ready, true);
  assert.equal(f.gate.active(), false);
  assert.equal(f.starts(), 0);
});
test("activation is idempotent; a second freeze and read errors stop every service", async () => {
  const f = fixture(); f.gate.setBootReady(); f.setState({ ...preparing, phase: "active" });
  await Promise.all([f.gate.refresh(), f.gate.refresh()]); await f.gate.refresh();
  assert.equal(f.starts(), 1); assert.equal(f.gate.active(), true);
  f.setState(preparing); await f.gate.refresh();
  assert.equal(f.stops(), 1); assert.equal(f.gate.active(), false);
  f.setState({ ...preparing, phase: "active" }); await f.gate.refresh();
  assert.equal(f.starts(), 2);
  f.unavailable(true); await f.gate.refresh();
  assert.equal(f.stops(), 2); assert.equal(f.gate.status().maintenance_ready, false);
});
test("activation cannot outrun bootstrap and missing state remains closed", async () => {
  const f = fixture(); f.setState({ ...preparing, phase: "active" }); await f.gate.refresh();
  assert.equal(f.starts(), 0);
  f.setState(null); f.gate.setBootReady(); await f.gate.refresh();
  assert.equal(f.starts(), 0); assert.equal(f.gate.status().maintenance_ready, false);
});
test("partial startup failure closes registered services and denies HTTP", async () => {
  let stops = 0;
  const gate = createPlatformMaintenanceGate({ identity, readState: async () => ({ ...preparing, phase: "active" }), start: (register) => { register(() => { stops++; }); throw new Error("startup failure"); } });
  gate.setBootReady(); await gate.refresh();
  assert.equal(gate.active(), false); assert.equal(stops, 1);
});
test("closing during a pending DB read cannot reopen services", async () => {
  let resolve!: (state: PlatformUpgradeState) => void; let starts = 0;
  const gate = createPlatformMaintenanceGate({ identity, readState: () => new Promise((done) => { resolve = done; }), start: () => { starts++; } });
  gate.setBootReady(); const refresh = gate.refresh(); gate.close(); resolve({ ...preparing, phase: "active" }); await refresh;
  assert.equal(starts, 0); assert.equal(gate.active(), false);
});
test("maintenance health is read-only; every other method, GET side effect and upgrade is rejected before handlers", async () => {
  const f = fixture(); const app = Fastify(); let calls = 0;
  registerPlatformMaintenanceGuard(app, f.gate, identity.version);
  app.get("/health", async () => { calls++; return { ok: true }; });
  app.get("/business", async () => { calls++; return {}; });
  app.post("/business", async () => { calls++; return {}; });
  try {
    const before = await app.inject({ method: "GET", url: "/health" });
    assert.equal(before.statusCode, 200); assert.equal(before.json().maintenance_ready, false);
    f.gate.setBootReady();
    const ready = await app.inject({ method: "GET", url: "/health?probe=1" });
    assert.equal(ready.json().maintenance_ready, true); assert.equal(ready.json().ready, false);
    for (const request of [
      { method: "GET" as const, url: "/business" }, { method: "POST" as const, url: "/business" },
      { method: "HEAD" as const, url: "/health" }, { method: "OPTIONS" as const, url: "/business" },
      { method: "GET" as const, url: "/health", headers: { upgrade: "websocket" } },
    ]) assert.equal((await app.inject(request)).statusCode, 503);
    assert.equal(calls, 0);
    f.setState({ ...preparing, phase: "active" });
    assert.equal((await app.inject({ method: "GET", url: "/business" })).statusCode, 200);
    assert.equal(calls, 1);
    f.unavailable(true);
    assert.equal((await app.inject({ method: "GET", url: "/business" })).statusCode, 503);
    assert.equal(calls, 1);
  } finally { f.gate.close(); await app.close(); }
});


test("refreezing terminates already-upgraded WebSockets", async () => {
  const f = fixture(); const app = Fastify();
  registerPlatformMaintenanceGuard(app, f.gate, identity.version);
  await app.register(websocket);
  app.get("/socket", { websocket: true }, (socket) => { socket.on("message", () => socket.send("echo")); });
  await app.ready();
  f.gate.setBootReady(); f.setState({ ...preparing, phase: "active" });
  const socket = await app.injectWS("/socket");
  try {
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    f.setState(preparing); await f.gate.refresh(); await closed;
    assert.equal(socket.readyState, 3);
  } finally { socket.terminate(); f.gate.close(); await app.close(); }
});
