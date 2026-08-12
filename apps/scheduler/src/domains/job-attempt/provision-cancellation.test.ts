import assert from "node:assert/strict";
import test from "node:test";
import { interruptProvision, registerProvisionCancellation } from "./provision-cancellation.js";

test("取消先中止 signal 再等待 provider 清理，重复取消保持幂等", async () => {
  const abortController = new AbortController();
  const calls: string[] = [];
  const unregister = registerProvisionCancellation("job-provision-1", {
    attemptId: "attempt-1",
    abortController,
    cancelProvision: async () => {
      calls.push(abortController.signal.aborted ? "cancel-after-abort" : "cancel-before-abort");
    },
  });
  try {
    assert.equal(await interruptProvision("job-provision-1", "attempt-other"), false);
    assert.equal(await interruptProvision("job-provision-1", "attempt-1"), true);
    assert.equal(await interruptProvision("job-provision-1", "attempt-1"), true);
    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(calls, ["cancel-after-abort"]);
  } finally {
    unregister();
  }
  assert.equal(await interruptProvision("job-provision-1"), false);
});

test("同一 Job 不允许覆盖另一个 Attempt 的活动 provision 句柄", () => {
  const first = registerProvisionCancellation("job-provision-2", {
    attemptId: "attempt-1",
    abortController: new AbortController(),
  });
  try {
    assert.throws(
      () => registerProvisionCancellation("job-provision-2", {
        attemptId: "attempt-2",
        abortController: new AbortController(),
      }),
      /其他 Attempt/,
    );
  } finally {
    first();
  }
});
