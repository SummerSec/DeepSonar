import assert from "node:assert/strict";
import test from "node:test";
import { isProjectRuntimeImageAvailable, isRuntimeImageBelowPlatformMin, isRuntimeImagePinStale, runtimeImageKindHint, runtimeImageOptionLabel, runtimeImagePinLabel, runtimeImageSelectOption } from "./runtime-image-option";
import { officialRuntimeImageBoundary, WEB_SPECIALTY_IMAGE_KEYS } from "./runtime-image-boundary";
import { optionTitle } from "./searchable-select-model";

const openharmony = {
  name: "DeepSonar OpenHarmony Audit",
  image_key: "deepsonar-openharmony-audit",
  official: true,
  project_opt_in: true,
  project_enabled: true,
};

test("runtime image options keep the product name intact and put kind in the hint", () => {
  const option = runtimeImageSelectOption(openharmony, "project-1");
  assert.equal(option.label, "DeepSonar OpenHarmony Audit");
  assert.ok(option.hint !== undefined);
  assert.match(option.hint, /^专项 · 不包含：/);
  assert.match(optionTitle(option), /^DeepSonar OpenHarmony Audit · 专项 · 不包含：/);
  assert.equal(runtimeImageOptionLabel(openharmony, "project-1"), "DeepSonar OpenHarmony Audit · 专项");
  assert.doesNotMatch(option.label, /OpenHarm\.\.\./);
});

test("#691 project pins removed: pin helpers are inert", () => {
  assert.equal(isRuntimeImagePinStale({
    pin_stale: true,
    selected_version_id: "99999999-9999-4999-8999-999999999999",
  }), false);
  assert.equal(runtimeImagePinLabel({
    selected_version_id: "99999999-9999-4999-8999-999999999999",
    selected_version: "0.1.38",
    latest_version: "0.1.39",
    pin_stale: true,
  }), "跟随平台最新 trusted");
});

test("below-platform-min flag is an explicit boolean from the scheduler row", () => {
  assert.equal(isRuntimeImageBelowPlatformMin({ below_platform_min: true }), true);
  assert.equal(isRuntimeImageBelowPlatformMin({ below_platform_min: false }), false);
  assert.equal(isRuntimeImageBelowPlatformMin({}), false);
});

test("runtime image kind hint distinguishes specialty from base; official default-on", () => {
  assert.equal(runtimeImageKindHint({
    image_key: "deepsonar-base",
    official: true,
    project_opt_in: false,
    project_enabled: null,
  }, null), "底座");
  assert.equal(runtimeImageKindHint({
    ...openharmony,
    project_enabled: null,
  }, "project-1"), "专项");
  assert.equal(runtimeImageKindHint({
    ...openharmony,
    project_enabled: false,
  }, "project-1"), "专项 · 已在项目排除");
  assert.equal(isProjectRuntimeImageAvailable({ official: true, project_enabled: null, image_key: "deepsonar-audit" }), true);
  assert.equal(isProjectRuntimeImageAvailable({ official: true, project_enabled: false, image_key: "deepsonar-audit" }), false);
  assert.equal(isProjectRuntimeImageAvailable({ official: true, project_enabled: false, image_key: "deepsonar-base" }), true);
  assert.equal(isProjectRuntimeImageAvailable({ official: false, project_enabled: null, image_key: "third-party" }), false);
  assert.equal(isProjectRuntimeImageAvailable({ official: false, project_enabled: true, image_key: "third-party" }), true);
});

test("official image boundary one-liners cover specialty keys used by scheduler injection", () => {
  for (const key of WEB_SPECIALTY_IMAGE_KEYS) {
    const boundary = officialRuntimeImageBoundary(key);
    assert.ok(boundary?.toolset, key);
    assert.ok(boundary?.not_included, key);
  }
  assert.equal(officialRuntimeImageBoundary("deepsonar-chrome-test")?.not_included.includes("Selenium"), true);
});
