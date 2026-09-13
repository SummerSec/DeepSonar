import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceActionLabel,
  deviceCanManage,
  deviceErrorCode,
  deviceRemedyHint,
  deviceStatusLabel,
  deviceStatusTone,
  leaseIsActive,
  leaseStateLabel,
  rigAdmissionSummary,
} from "./devices";

test("device status and lease labels fall back to the raw value instead of inventing text", () => {
  assert.equal(deviceStatusLabel("idle"), "空闲");
  assert.equal(deviceStatusLabel("leased"), "已租出");
  assert.equal(deviceStatusLabel("revoked"), "已下架");
  assert.equal(deviceStatusLabel("brand-new-state"), "brand-new-state");
  assert.equal(deviceStatusLabel(null), "未知");
  assert.equal(leaseStateLabel("active"), "生效中");
  assert.equal(leaseStateLabel("expired"), "已过期");
  assert.equal(deviceActionLabel("revoke"), "下架");
});

test("only pending/active leases occupy a device", () => {
  assert.equal(leaseIsActive("pending"), true);
  assert.equal(leaseIsActive("active"), true);
  assert.equal(leaseIsActive("released"), false);
  assert.equal(leaseIsActive("expired"), false);
  assert.equal(leaseIsActive(null), false);
});

test("management requires admin so project-scoped actors stay read-only", () => {
  const actor = (role: string | null, scopes: string[]) => ({
    auth_required: true,
    authenticated: true,
    actor: { role, scopes },
  });
  assert.equal(deviceCanManage(actor("admin", ["tasks:read"])), true);
  assert.equal(deviceCanManage(actor(null, ["admin", "tasks:read"])), true);
  assert.equal(deviceCanManage(actor("operator", ["tasks:read"])), false);
  // 未开鉴权的部署等同全权，但未认证的主体一律不能改。
  assert.equal(deviceCanManage({ auth_required: false, authenticated: true, actor: null }), true);
  assert.equal(deviceCanManage({ auth_required: true, authenticated: false, actor: null }), false);
  assert.equal(deviceCanManage(null), false);
});

test("error codes are extracted from the api message envelope", () => {
  assert.equal(
    deviceErrorCode("DEVICE_HAS_ACTIVE_LEASE: 设备仍有在途租约，请先强制释放"),
    "DEVICE_HAS_ACTIVE_LEASE",
  );
  assert.equal(deviceErrorCode("DEVICE_HAS_LEASE_HISTORY: 设备有租约历史"), "DEVICE_HAS_LEASE_HISTORY");
  assert.equal(deviceErrorCode("设备仍有在途租约"), null);
  assert.equal(deviceErrorCode(null), null);
});

test("remedy hints distinguish active-lease conflicts from immutable lease history", () => {
  // 这两个码处置不同：在途租约可以先释放，租约历史只能下架。
  assert.match(String(deviceRemedyHint("DEVICE_HAS_ACTIVE_LEASE")), /强制释放/);
  assert.match(String(deviceRemedyHint("DEVICE_HAS_LEASE_HISTORY")), /下架/);
  assert.equal(deviceRemedyHint("SOMETHING_ELSE"), null);
  assert.equal(deviceRemedyHint(null), null);
});

test("rig admission summary reports configuration gaps instead of pretending synced", () => {
  assert.match(rigAdmissionSummary(null), /未知/);
  assert.match(rigAdmissionSummary({ enabled: false, broker_configured: true, admission: null }), /未启用/);
  assert.match(rigAdmissionSummary({ enabled: true, broker_configured: false, admission: null }), /未配置/);
  assert.match(
    rigAdmissionSummary({ enabled: true, broker_configured: true, admission: null }),
    /不可达/,
  );
  assert.match(
    rigAdmissionSummary({
      enabled: true,
      broker_configured: true,
      admission: { mode: "platform", reconciled: true, usable: ["rig-1", "rig-2"] },
    }),
    /已同步.*可用 2 台/,
  );
  assert.match(
    rigAdmissionSummary({
      enabled: true,
      broker_configured: true,
      admission: { mode: "env-legacy", reconciled: false, usable: [] },
    }),
    /尚未确认/,
  );
});

test("status tones keep leased/revoked visually distinct from idle", () => {
  assert.equal(deviceStatusTone("idle"), "ok");
  assert.equal(deviceStatusTone("leased"), "warn");
  assert.equal(deviceStatusTone("revoked"), "danger");
  assert.equal(deviceStatusTone("maintenance"), "muted");
  assert.equal(deviceStatusTone("unknown-state"), "muted");
});
