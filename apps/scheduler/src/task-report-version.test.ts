import assert from "node:assert/strict";
import test from "node:test";
import { planTaskReportVersion } from "./task-report-version.js";

test("成功版本输入未变化时保持幂等", () => {
  assert.deepEqual(
    planTaskReportVersion({ version: 3, status: "succeeded", input_sha256: "same" }, "same"),
    { alreadySucceeded: true, reuseVersion: false, version: 4 },
  );
});

test("成功版本输入变化时追加版本", () => {
  assert.deepEqual(
    planTaskReportVersion({ version: 3, status: "succeeded", input_sha256: "old" }, "new"),
    { alreadySucceeded: false, reuseVersion: false, version: 4 },
  );
});

test("失败版本使用相同输入重试时复用版本", () => {
  assert.deepEqual(
    planTaskReportVersion({ version: 3, status: "failed", input_sha256: "same" }, "same"),
    { alreadySucceeded: false, reuseVersion: true, version: 3 },
  );
});

test("无历史报告时从版本一开始", () => {
  assert.deepEqual(
    planTaskReportVersion(null, "first"),
    { alreadySucceeded: false, reuseVersion: false, version: 1 },
  );
});
