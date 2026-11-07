import assert from "node:assert/strict";
import test from "node:test";
import { assertCurrentRuntimeImageKey, isRetiredRuntimeImageKey, RETIRED_RUNTIME_IMAGE_KEYS, RuntimeImageRetiredError } from "./runtime-image-retirement.js";

test("retirement matches only the three exact product keys, independently of source identity", () => {
  for (const key of RETIRED_RUNTIME_IMAGE_KEYS) {
    assert.equal(isRetiredRuntimeImageKey(key), true);
    assert.throws(() => assertCurrentRuntimeImageKey(key), (error: unknown) =>
      error instanceof RuntimeImageRetiredError && error.statusCode === 410
      && error.code === "RUNTIME_IMAGE_RETIRED" && error.imageKey === key);
    for (const lookalike of [`${key}-custom`, `vendor-${key}`, key.toUpperCase()]) {
      assert.equal(isRetiredRuntimeImageKey(lookalike), false);
      assert.doesNotThrow(() => assertCurrentRuntimeImageKey(lookalike));
    }
  }
  for (const value of [null, undefined, 1, "deepsonar-base", "deepsonar-audit", "deepsonar-clickhouse", "vendor-tool"]) {
    assert.equal(isRetiredRuntimeImageKey(value), false);
  }
});
