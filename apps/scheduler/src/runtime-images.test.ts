import assert from "node:assert/strict";
import test from "node:test";
import {
  hostRuntimePlatform,
  runtimeImageRegistryNextSyncDelayMs,
  shouldReconcileRuntimeImagePromotions,
  type RuntimeImageRegistry,
} from "./runtime-images.js";

const registry = (fallback: boolean): RuntimeImageRegistry => ({
  schema: "deepsonar.registry/v1",
  images: [],
  source: fallback ? "bundled" : "remote",
  fallback,
});

test("bundled fallback 不是可覆盖数据库状态的权威清单", () => {
  assert.equal(shouldReconcileRuntimeImagePromotions(registry(true)), false);
  assert.equal(shouldReconcileRuntimeImagePromotions(registry(false)), true);
});

test("远端同步失败后缩短下一次重试等待", () => {
  assert.equal(runtimeImageRegistryNextSyncDelayMs(3_600_000, true), 60_000);
  assert.equal(runtimeImageRegistryNextSyncDelayMs(3_600_000, false), 3_600_000);
  assert.equal(runtimeImageRegistryNextSyncDelayMs(30_000, true), 30_000);
});

test("宿主架构映射为运行时镜像平台", () => {
  assert.equal(hostRuntimePlatform("x64"), "linux/amd64");
  assert.equal(hostRuntimePlatform("arm64"), "linux/arm64");
  assert.throws(() => hostRuntimePlatform("s390x"), /不支持的 Scheduler 宿主架构/);
});
