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

test("release URL uses the official tag page for a canonical vX.Y.Z", () => {
  assert.equal(
    githubReleaseUrlForVersion("0.2.1"),
    "https://github.com/SummerSec/DeepSonar/releases/tag/v0.2.1",
  );
  assert.equal(
    githubReleaseUrlForVersion("v0.2.1"),
    "https://github.com/SummerSec/DeepSonar/releases/tag/v0.2.1",
  );
});

test("release URL extracts vX.Y.Z from suffixed deploy versions", () => {
  assert.equal(
    githubReleaseUrlForVersion("0.1.46-os-compose"),
    "https://github.com/SummerSec/DeepSonar/releases/tag/v0.1.46",
  );
  assert.equal(
    githubReleaseUrlForVersion("v0.1.46-os-compose"),
    "https://github.com/SummerSec/DeepSonar/releases/tag/v0.1.46",
  );
});

test("release URL falls back to the releases index when no safe tag matches", () => {
  assert.equal(githubReleaseUrlForVersion("latest"), "https://github.com/SummerSec/DeepSonar/releases");
  assert.equal(githubReleaseUrlForVersion("dev"), "https://github.com/SummerSec/DeepSonar/releases");
  assert.equal(githubReleaseUrlForVersion("../evil"), "https://github.com/SummerSec/DeepSonar/releases");
  assert.doesNotMatch(githubReleaseUrlForVersion("not-a-tag") ?? "", /\/tag\//);
});

test("release URL stays hidden when the version is empty", () => {
  assert.equal(githubReleaseUrlForVersion(""), null);
  assert.equal(githubReleaseUrlForVersion("  "), null);
  assert.equal(githubReleaseUrlForVersion(undefined), null);
});

test("toast kind treats save failures as errors", () => {
  assert.equal(inferToastKind("规则已保存（下一 job 生效）"), "ok");
  assert.equal(inferToastKind("保存失败：网络中断"), "error");
  assert.equal(inferToastKind("角色标识必填"), "error");
});
