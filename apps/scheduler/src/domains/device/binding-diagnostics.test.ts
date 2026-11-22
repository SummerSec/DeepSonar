import assert from "node:assert/strict";
import test from "node:test";
import { deriveDeviceBinding, projectLeaseRows } from "./binding-diagnostics.js";

const requirement = {
  transport: "hdc" as const,
  rig_id: "local-sim" as const,
  exclusive: true,
  ttl_sec: 1800,
  roles: ["test"],
};

const snapshotWith = (req: unknown) => ({ name: "test", device_requirement: req });

test("#1211 未声明设备需求时给出未绑定原因，不推断设备可用性", () => {
  const result = deriveDeviceBinding({ snapshot: { name: "test" }, canvasTarget: {}, roleName: "test", leases: [] });
  assert.equal(result.state, "not_declared");
  assert.equal(result.snapshot_requirement, null);
  assert.equal(result.canvas_requirement, null);
  assert.equal(result.connection_result_recorded, false);
  assert.match(result.reason, /都没有声明设备需求/);
  assert.match(result.reason, /不代表本 Job 已绑定设备/);
});

test("#1211 画布声明了需求但快照未冻结时明确指出不会申请租约", () => {
  const result = deriveDeviceBinding({
    snapshot: { name: "test" },
    canvasTarget: { device_requirement: requirement },
    roleName: "test",
    leases: [],
  });
  assert.equal(result.state, "declared_no_lease");
  assert.equal(result.snapshot_requirement, null);
  assert.deepEqual(result.canvas_requirement, { roles: ["test"], transport: "hdc", rig_id: "local-sim" });
  assert.match(result.reason, /Job 快照没有冻结该需求/);
});

test("#1211 快照声明但角色不命中时区分出来，而不是说没有可用设备", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "report",
    leases: [],
  });
  assert.equal(result.state, "declared_no_lease");
  assert.equal(result.role_matched, false);
  assert.match(result.reason, /report 不在 test 内/);
});

test("#1211 角色命中但没有租约记录时指向申请失败的可能原因", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    leases: [],
  });
  assert.equal(result.state, "declared_no_lease");
  assert.equal(result.role_matched, true);
  assert.match(result.reason, /租约申请未发生或被拒绝/);
});

test("#1211 有租约记录但无连接结果时只报未验证", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    leases: [
      {
        attempt_id: "attempt-1",
        state: "released",
        device_key: "local-sim-01",
        rig_id: "local-sim",
        granted_at: "2026-11-22T10:00:00.000Z",
        expires_at: "2026-11-22T10:30:00.000Z",
        released_at: "2026-11-22T10:05:00.000Z",
        release_reason: "attempt_terminal",
      },
    ],
  });
  assert.equal(result.state, "lease_recorded_unverified");
  assert.equal(result.connection_result_recorded, false);
  assert.match(result.reason, /最新状态 released/);
  assert.match(result.reason, /设备 local-sim-01/);
  assert.match(result.reason, /不能证明宿主机设备不可用/);
});

test("#1211 租约行投影保留时间与释放原因", () => {
  const projected = projectLeaseRows([
    {
      attempt_id: "attempt-1",
      state: "active",
      device_key: null,
      rig_id: null,
      granted_at: new Date("2026-11-22T10:00:00.000Z"),
      expires_at: null,
      released_at: null,
      release_reason: null,
    },
  ]);
  assert.deepEqual(projected, [
    {
      attempt_id: "attempt-1",
      state: "active",
      device_key: null,
      rig_id: null,
      granted_at: "2026-11-22T10:00:00.000Z",
      expires_at: null,
      released_at: null,
      release_reason: null,
    },
  ]);
});
test("#1211 重试时顶层跟随最新 Attempt，历史失败不被合并掩盖", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [
      { attempt_id: "attempt-2", attempt_no: 2 },
      { attempt_id: "attempt-1", attempt_no: 1 },
    ],
    leases: [
      {
        attempt_id: "attempt-2",
        state: "released",
        device_key: "local-sim-01",
        rig_id: "local-sim",
        granted_at: "2026-11-22T11:00:00.000Z",
        expires_at: "2026-11-22T11:30:00.000Z",
        released_at: "2026-11-22T11:05:00.000Z",
        release_reason: "attempt_terminal",
      },
    ],
  });
  assert.equal(result.state, "lease_recorded_unverified");
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts.map((a) => [a.attempt_id, a.state]), [
    ["attempt-2", "lease_recorded_unverified"],
    ["attempt-1", "declared_no_lease"],
  ]);
  assert.match(result.attempts[1]!.reason, /租约申请未发生或被拒绝/);
});

test("#1211 租约与 Attempt 列表都有上限并显式报告截断", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    attempt_id: `attempt-${index}`,
    state: "released",
    device_key: "local-sim-01",
    rig_id: "local-sim",
    granted_at: null,
    expires_at: null,
    released_at: null,
    release_reason: "attempt_terminal",
  }));
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    leases: many,
    attempts: Array.from({ length: 30 }, (_, index) => ({ attempt_id: `attempt-${index}`, attempt_no: 30 - index })),
    leaseCount: 120,
    attemptCount: 45,
  });
  assert.equal(result.leases.length, 32);
  assert.equal(result.lease_count, 120);
  assert.equal(result.leases_truncated, true);
  assert.equal(result.attempts.length, 20);
  assert.equal(result.attempts_truncated, true);
  assert.equal(result.state, "lease_recorded_unverified");
});
