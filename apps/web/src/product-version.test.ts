import assert from "node:assert/strict";
import test from "node:test";
import { formatHealthVersion, githubReleaseUrlForVersion } from "./product-version";
import { inferToastKind } from "./toast";

test("health version adds a v prefix when the deploy tag has none", () => {
  assert.equal(formatHealthVersion("0.1.37"), "v0.1.37");
  assert.equal(formatHealthVersion("v0.1.37"), "v0.1.37");
  assert.equal(formatHealthVersion("  "), null);
  assert.equal(formatHealthVersion(""), null);
  assert.equal(formatHealthVersion(undefined), null);
});

test("canonical versions link to the GitHub tag; dirty tags fall back to the releases index", () => {
  assert.equal(githubReleaseUrlForVersion("0.2.1"), "https://github.com/SummerSec/DeepSonar/releases/tag/v0.2.1");
  assert.equal(githubReleaseUrlForVersion("v0.2.1"), "https://github.com/SummerSec/DeepSonar/releases/tag/v0.2.1");
  assert.equal(githubReleaseUrlForVersion("0.1.46-os-compose"), "https://github.com/SummerSec/DeepSonar/releases");
  assert.equal(githubReleaseUrlForVersion("  "), null);
  assert.equal(githubReleaseUrlForVersion(undefined), null);
});

test("toast kind treats save failures as errors", () => {
  assert.equal(inferToastKind("规则已保存（下一 job 生效）"), "ok");
  assert.equal(inferToastKind("保存失败：网络中断"), "error");
  assert.equal(inferToastKind("角色标识必填"), "error");
});
