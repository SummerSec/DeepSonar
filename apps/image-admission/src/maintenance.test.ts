import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionMaintenanceBlocked, admissionMaintenanceAllowsWork, createAdmissionMaintenanceGate, type AdmissionUpgradeState } from "./maintenance.js";
const identity = { generation: "candidate", version: "1.2.3" };
const state: AdmissionUpgradeState = { phase: "active", generation: identity.generation, target_version: identity.version, runtime_role: "candidate", current_role: "candidate" };
test("admission identity fails closed for missing, preparing, old generation, wrong role and version", () => {
  for (const row of [null, { ...state, phase: "preparing" }, { ...state, generation: "old" }, { ...state, current_role: "old" }, { ...state, target_version: "old" }]) assert.equal(admissionMaintenanceAllowsWork(row, identity), false);
  assert.equal(admissionMaintenanceAllowsWork(state, identity), true);
  assert.equal(admissionMaintenanceAllowsWork(state, { generation: "", version: "" }), false);
});
test("preparing runs no scan loops; activation starts once; freeze or DB error closes all loops", async () => {
  let current = { ...state, phase: "preparing" }; let fail = false; let starts = 0; let stops = 0;
  const gate = createAdmissionMaintenanceGate({ identity, readState: async () => { if (fail) throw new Error("DB"); return current; }, start: (register) => { starts++; register(() => { stops++; }); } });
  await gate.refresh(); assert.equal(starts, 0); await assert.rejects(gate.requireActive(), AdmissionMaintenanceBlocked);
  current = state; await Promise.all([gate.refresh(), gate.refresh()]); await gate.refresh(); assert.equal(starts, 1);
  current = { ...state, phase: "preparing" }; await gate.refresh(); assert.equal(stops, 1);
  current = state; await gate.refresh(); fail = true; await gate.refresh(); assert.equal(stops, 2);
  assert.equal(await gate.authorized(), false);
  gate.close();
});
test("closing during authorization prevents late DB reads from starting or authorizing work", async () => {
  let resolve!: (row: AdmissionUpgradeState) => void; let starts = 0;
  const gate = createAdmissionMaintenanceGate({ identity, readState: () => new Promise((done) => { resolve = done; }), start: () => { starts++; } });
  const pending = gate.refresh(); gate.close(); resolve(state); await pending; assert.equal(starts, 0);
});
