import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceActionLabel,
  deviceCanManage,
  deviceErrorCode,
  deviceRemedyHint,
  deviceRigOptions,
  deviceStatusLabel,
  deviceStatusTone,
  formatRigPushes,
  leaseIsActive,
  leaseStateLabel,
  rigAdmissionLine,
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

const syncedRig = {
  id: "default",
  broker_configured: true,
  admission: { revision: 3, reconciled: true, mode: "platform", usable: ["rig-1", "rig-2"] },
};
const unreachableRig = { id: "rig-b", broker_configured: true, admission: null };

test("rig admission summary reports configuration gaps instead of pretending synced", () => {
  assert.match(rigAdmissionSummary(null), /未知/);
  assert.match(rigAdmissionSummary({ enabled: false, broker_configured: true, rigs: [] }), /未启用/);
  assert.match(rigAdmissionSummary({ enabled: true, broker_configured: false, rigs: [] }), /未配置任何 rig/);
  assert.match(
    rigAdmissionSummary({ enabled: true, broker_configured: true, rigs: [syncedRig, unreachableRig] }),
    /已配置 2 个 rig（1 个当前不可达）/,
  );
  assert.match(rigAdmissionSummary({ enabled: true, broker_configured: true, rigs: [syncedRig] }), /全部可达/);
  assert.match(
    rigAdmissionSummary({
      enabled: true,
      broker_configured: true,
      rigs: [syncedRig],
      invalid_entries: ["条目缺少 'id=' 前缀"],
    }),
    /1 条配置被丢弃/,
  );
});

test("per-rig admission lines distinguish missing credentials, unreachable and unreconciled", () => {
  assert.match(
    rigAdmissionLine({ id: "rig-b", broker_configured: false, admission: null }),
    /未配置 broker 凭据/,
  );
  assert.match(rigAdmissionLine(unreachableRig), /不可达/);
  assert.match(
    rigAdmissionLine({
      id: "rig-b",
      broker_configured: true,
      admission: { revision: 1, reconciled: false, mode: "env-legacy", usable: [] },
    }),
    /尚未确认/,
  );
  assert.match(rigAdmissionLine(syncedRig), /已同步.*可用 2 台/);
});

test("rig options label the default rig so operators do not mistake it for a named rig", () => {
  assert.deepEqual(deviceRigOptions(["default", "rig-b"]), [
    { value: "default", label: "default（默认）" },
    { value: "rig-b", label: "rig-b" },
  ]);
  assert.deepEqual(deviceRigOptions([]), []);
});

test("push results name each rig and its failure reason", () => {
  assert.equal(formatRigPushes([]), "未配置 rig，未推送");
  assert.equal(formatRigPushes(null), "未配置 rig，未推送");
  assert.equal(
    formatRigPushes([
      { rig: "default", ok: true, devices: 2 },
      { rig: "rig-b", ok: false, reason: "unavailable", devices: 0 },
    ]),
    "default ✓ 2 台 · rig-b ✗ 不可达/契约不符",
  );
  // 未知 reason 原样透出，不吞信息。
  assert.match(
    formatRigPushes([{ rig: "rig-c", ok: false, reason: "mystery", devices: 0 }]),
    /mystery/,
  );
});

test("status tones keep leased/revoked visually distinct from idle", () => {
  assert.equal(deviceStatusTone("idle"), "ok");
  assert.equal(deviceStatusTone("leased"), "warn");
  assert.equal(deviceStatusTone("revoked"), "danger");
  assert.equal(deviceStatusTone("maintenance"), "muted");
  assert.equal(deviceStatusTone("unknown-state"), "muted");
});
