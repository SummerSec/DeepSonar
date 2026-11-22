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
  assert.equal(result.snapshot_requirement, null);
  assert.deepEqual(result.canvas_requirement, { roles: ["test"], transport: "hdc", rig_id: "local-sim" });
  assert.match(result.reason, /Job 快照没有冻结该需求/);
});

test("#1211 角色不命中的 Attempt 单独分档为 not_applying", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "report",
    attempts: [{ attempt_id: "attempt-1", attempt_no: 1, status: "succeeded", error: null, failure_reason: null }],
  });
  assert.equal(result.role_matched, false);
  assert.deepEqual(result.attempts.map((a) => [a.attempt_no, a.state]), [[1, "not_applying"]]);
  assert.match(result.attempts[0]!.reason, /report 不在 test 内/);
});

test("#1211 有 Attempt 但无租约时区分「未申请」与「已记录的申请失败」", () => {
  const alive = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [{ attempt_id: "attempt-1", attempt_no: 1, status: "active", error: null, failure_reason: null }],
  });
  assert.equal(alive.state, "attempted_no_lease");
  assert.match(alive.reason, /还没有租约行：申请可能仍在进行/);

  const failed = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [{ attempt_id: "attempt-2", attempt_no: 2, status: "failed", error: "device broker 拒绝", failure_reason: "device_not_available" }],
  });
  assert.equal(failed.state, "acquire_failed");
  assert.match(failed.reason, /终态原因是设备失败码 device_not_available/);
  assert.doesNotMatch(failed.reason, /拒绝/); // 原因不在诊断里复读，只指向 attempts[].error
});

test("#1211 快照声明但整 Job 还没有 Attempt 时为 not_attempted（申请未发生）", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    leases: [],
  });
  assert.equal(result.state, "not_attempted");
  assert.match(result.reason, /租约申请未发生/);
});

test("#1211 有租约记录但无连接结果时只报未验证", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [{ attempt_id: "attempt-1", attempt_no: 1, status: "succeeded", error: null, failure_reason: null }],
    leaseCountsByAttempt: { "attempt-1": 1 },
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
  assert.match(result.reason, /沙箱内探测失败不能证明宿主机设备不可用/);
  assert.deepEqual(result.attempts.map((a) => a.state), ["lease_recorded_unverified"]);
});

test("#1211 重试时顶层跟随最新 Attempt，历史失败不被合并掩盖", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [
      { attempt_id: "attempt-2", attempt_no: 2, status: "active", error: null, failure_reason: null },
      { attempt_id: "attempt-1", attempt_no: 1, status: "failed", error: "没有可用设备", failure_reason: "device_not_available" },
    ],
    leaseCountsByAttempt: { "attempt-2": 1 },
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
  assert.deepEqual(result.attempts.map((a) => [a.attempt_no, a.state]), [
    [2, "lease_recorded_unverified"],
    [1, "acquire_failed"],
  ]);
  assert.equal(result.attempts.length, 2);
  assert.match(result.reason, /最新 Attempt #2/);
  assert.equal(result.lease_count, 1);
  assert.equal(result.leases_truncated, false);
});

test("#1211 分档判定用全租约计数，不依赖 32 条显示窗口", () => {
  // 显示窗口的 32 条全是 attempt-x；attempt-0 的旧租约被截断了，但按计数仍应为租约档。
  const windowRow = (attemptId: string) => ({
    attempt_id: attemptId,
    state: "released",
    device_key: "local-sim-01",
    rig_id: "local-sim",
    granted_at: null,
    expires_at: null,
    released_at: null,
    release_reason: "attempt_terminal",
  });
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [
      { attempt_id: "attempt-1", attempt_no: 2, status: "active", error: null, failure_reason: null },
      { attempt_id: "attempt-0", attempt_no: 1, status: "failed", error: null, failure_reason: null },
    ],
    leaseCountsByAttempt: { "attempt-0": 40, "attempt-1": 0 },
    leases: [...Array.from({ length: 32 }, () => windowRow("attempt-x")), ...Array.from({ length: 8 }, () => windowRow("attempt-0"))],
    leaseCountTotal: 80,
  });
  const attempt0 = result.attempts.find((a) => a.attempt_id === "attempt-0")!;
  assert.equal(attempt0.state, "lease_recorded_unverified");
  assert.equal(attempt0.leases.length, 0);
  assert.match(attempt0.reason, /已记录 40 条设备租约/);
  // 顶层跟随最新 Attempt：attempt-1 还没有租约，属于申请进行中，不被历史租约盖掉。
  assert.equal(result.state, "attempted_no_lease");
  assert.equal(result.lease_count, 80);
  assert.equal(result.leases_truncated, true);
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
    attempts: Array.from({ length: 30 }, (_, index) => ({
      attempt_id: `attempt-${index}`,
      attempt_no: 30 - index,
      status: "failed",
      error: null,
      failure_reason: null,
    })),
    leaseCountsByAttempt: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`attempt-${index}`, 2])),
    leaseCountTotal: 60,
    attemptCount: 45,
  });
  assert.equal(result.leases.length, 32);
  assert.equal(result.lease_count, 60);
  assert.equal(result.leases_truncated, true);
  assert.equal(result.attempts.length, 20);
  assert.equal(result.attempts_truncated, true);
  assert.equal(result.state, "lease_recorded_unverified");
  assert.equal(result.attempts[0]!.state, "lease_recorded_unverified");
  assert.equal(result.attempts[19]!.state, "lease_recorded_unverified");
});

test("#1211 租约行投影保留 Attempt 归属、时间与释放原因", () => {
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
test("#1211 非设备 provision 失败不冒充租约申请失败", () => {
  const result = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [
      {
        attempt_id: "attempt-1",
        attempt_no: 1,
        status: "failed",
        error: "materializeSharedAssetBlob failed",
        failure_reason: "exception",
      },
    ],
  });
  assert.equal(result.state, "lease_unrecorded");
  assert.doesNotMatch(result.reason, /acquire_failed|租约申请失败/);
  assert.match(result.reason, /无法判断它是否走到租约申请/);
  assert.match(result.reason, /共享资产\/卷\/凭据准备失败/);
});

test("#1211 设备未授权与不可用都归入 acquire_failed，其它终态原因不归", () => {
  const unauthorized = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [
      { attempt_id: "a", attempt_no: 1, status: "failed", error: "未授权", failure_reason: "device_not_authorized" },
    ],
  });
  assert.equal(unauthorized.state, "acquire_failed");
  assert.match(unauthorized.reason, /device_not_authorized/);
  const other = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [
      { attempt_id: "a", attempt_no: 1, status: "timeout", error: "timeout", failure_reason: "reaper_timeout" },
    ],
  });
  assert.equal(other.state, "lease_unrecorded");
});

test("#1211 终态边界：cancelled / orphan / interrupted / unknown 都不冒充「还在申请」", () => {
  for (const status of ["cancelled", "orphan", "interrupted", "unknown"]) {
    const result = deriveDeviceBinding({
      snapshot: snapshotWith(requirement),
      canvasTarget: {},
      roleName: "test",
      attempts: [{ attempt_id: "attempt-1", attempt_no: 1, status, error: null, failure_reason: null }],
    });
    assert.equal(result.state, "lease_unrecorded", status);
    assert.match(result.reason, new RegExp(`status=${status}`));
    assert.doesNotMatch(result.reason, /租约申请失败/);
  }
  const active = deriveDeviceBinding({
    snapshot: snapshotWith(requirement),
    canvasTarget: {},
    roleName: "test",
    attempts: [{ attempt_id: "attempt-1", attempt_no: 1, status: "active", error: null, failure_reason: null }],
  });
  assert.equal(active.state, "attempted_no_lease");
});
