import assert from "node:assert/strict";
import test from "node:test";

test("registration row defaults to the shared pool and treats enabled=false as maintenance", async () => {
  const { registrationRow } = await import("./management.js");
  assert.deepEqual(
    registrationRow({
      key: "rig-1",
      transport: "adb",
      model: "Pixel-7",
      enabled: true,
    }),
    { key: "rig-1", transport: "adb", model: "Pixel-7", project_id: null, status: "idle" },
  );
  assert.deepEqual(
    registrationRow({
      key: "oh-1",
      transport: "hdc",
      model: null,
      project_id: "3f1c0a1e-0c2b-4c3d-9e4f-5a6b7c8d9e0f",
      enabled: false,
    }),
    {
      key: "oh-1",
      transport: "hdc",
      model: null,
      project_id: "3f1c0a1e-0c2b-4c3d-9e4f-5a6b7c8d9e0f",
      status: "maintenance",
    },
  );
});

test("status actions reuse the shared status machine", async () => {
  const { statusAfterAction } = await import("./management.js");
  assert.equal(statusAfterAction("enable"), "idle");
  assert.equal(statusAfterAction("maintenance"), "maintenance");
  assert.equal(statusAfterAction("revoke"), "revoked");
});

test("delete is blocked while a lease is still active", async () => {
  const { deviceDeleteBlocked } = await import("./management.js");
  assert.equal(deviceDeleteBlocked(0), false);
  assert.equal(deviceDeleteBlocked(1), true);
});

const rows = [
  { key: "rig-1", transport: "adb", model: "Pixel-7", status: "idle", broker_ref: "rig-a", updated_at: 1 },
  { key: "rig-2", transport: "adb", model: null, status: "maintenance", broker_ref: "rig-a", updated_at: 2 },
  { key: "oh-1", transport: "hdc", model: null, status: "idle", broker_ref: "rig-b", updated_at: 3 },
  { key: "rig-3", transport: "adb", model: null, status: "revoked", broker_ref: "rig-b", updated_at: 4 },
  { key: "orphan", transport: "adb", model: null, status: "idle", broker_ref: null, updated_at: 5 },
];

test("desired sets are grouped per rig and skip maintenance/revoked rows", async () => {
  const { groupDesiredByRig, desiredForRig } = await import("./management.js");
  const grouped = groupDesiredByRig(rows);
  // 没有 broker_ref 的登记项不参与推送。
  assert.deepEqual([...grouped.keys()], ["rig-a", "rig-b"]);
  assert.deepEqual(grouped.get("rig-a")?.map((device) => device.key), ["rig-1"]);
  assert.deepEqual(grouped.get("rig-b")?.map((device) => device.key), ["oh-1"]);
  assert.deepEqual(desiredForRig(rows, "rig-b").map((device) => device.transport), ["hdc"]);
  assert.deepEqual(desiredForRig(rows, "rig-missing"), []);
});
