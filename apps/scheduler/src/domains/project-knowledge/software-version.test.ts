import assert from "node:assert/strict";
import test from "node:test";
import { appliesToSoftwareVersion } from "./software-version.js";

test("#1219 未声明适用版本的条目对所有版本通用", () => {
  assert.equal(appliesToSoftwareVersion(["巡检", "日志"], "16.0"), true);
  assert.equal(appliesToSoftwareVersion(undefined, "16.0"), true);
});

test("#1219 声明了 sw:<version> 的条目只在该版本匹配时适用", () => {
  assert.equal(appliesToSoftwareVersion(["sw:16.0", "巡检"], "16.0"), true);
  assert.equal(appliesToSoftwareVersion(["sw:16.0", "巡检"], "15.0"), false);
  assert.equal(appliesToSoftwareVersion(["sw:15.0", "sw:16.0"], "16.0"), true);
});

test("#1219 未指定版本时不按版本过滤（旧调用方行为不变）", () => {
  assert.equal(appliesToSoftwareVersion(["sw:16.0"], ""), true);
  assert.equal(appliesToSoftwareVersion([], ""), true);
});
