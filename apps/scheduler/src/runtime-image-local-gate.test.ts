import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("leftover local-docker inspect gate is gone", () => {
  const runtimeImages = readFileSync(new URL("./runtime-images.ts", import.meta.url), "utf8");
  const dispatcher = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const readiness = readFileSync(new URL("./readiness.ts", import.meta.url), "utf8");
  const core = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtimeImages, /shouldInspectLocalRuntimeImage|assertFrozenRuntimeImageLocal|RuntimeImageNotLocalError|RUNTIME_IMAGE_NOT_LOCAL/);
  assert.doesNotMatch(dispatcher, /shouldInspectLocalRuntimeImage|assertRuntimeImageAvailable/);
  assert.doesNotMatch(readiness, /localImagePresence|shouldInspectLocalRuntimeImage|RUNTIME_IMAGE_NOT_LOCAL/);
  assert.doesNotMatch(core, /assertFrozenRuntimeImageLocal/);
});
