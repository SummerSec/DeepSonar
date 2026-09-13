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
