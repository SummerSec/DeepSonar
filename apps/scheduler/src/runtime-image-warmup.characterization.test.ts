import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const dispatcherSource = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./domains/settings/routes.ts", import.meta.url), "utf8");
const imageRoutesSource = readFileSync(new URL("./domains/runtime-image/routes.ts", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../../../database/schema.sql", import.meta.url), "utf8");

test("Base preparation completes before dispatcher startup", () => {
  assert.ok(indexSource.indexOf("await prepareBaseRuntimeImageOnBoot()") < indexSource.indexOf("startDispatcher()"));
});

test("new installations select Aliyun ACR without registry fallback", () => {
  assert.match(schemaSource, /runtime_registry_channel text NOT NULL DEFAULT 'aliyun-acr'/);
  assert.match(indexSource, /await prepareBaseRuntimeImageOnBoot\(\)/);
});

test("dispatcher only asserts local image readiness", () => {
  assert.match(dispatcherSource, /await assertRuntimeImageAvailable\(runtimeImage\)/);
  assert.doesNotMatch(dispatcherSource, /ensureRuntimeImageAvailable|prepareRuntimeImage/);
});

test("project image policy and bindings prepare before persistence succeeds", () => {
  assert.ok(settingsSource.indexOf("await prepareProjectRuntimeImages(id, cfg)") < settingsSource.indexOf("UPDATE projects SET config_json"));
  assert.match(imageRoutesSource, /await prepareRuntimeImage\(snapshot\.image_ref\)/);
  assert.match(imageRoutesSource, /code: "runtime_image_prepare_failed"/);
});
