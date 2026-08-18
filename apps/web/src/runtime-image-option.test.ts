import assert from "node:assert/strict";
import test from "node:test";
import { runtimeImageKindHint, runtimeImageOptionLabel, runtimeImageSelectOption } from "./runtime-image-option";
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
  assert.equal(option.hint, "专项·项目启用");
  assert.equal(optionTitle(option), "DeepSonar OpenHarmony Audit · 专项·项目启用");
  assert.equal(runtimeImageOptionLabel(openharmony, "project-1"), "DeepSonar OpenHarmony Audit · 专项·项目启用");
  assert.doesNotMatch(option.label, /OpenHarm\.\.\./);
});

test("runtime image kind hint distinguishes specialty opt-in from base", () => {
  assert.equal(runtimeImageKindHint({
    image_key: "deepsonar-base",
    official: true,
    project_opt_in: false,
    project_enabled: null,
  }, null), "底座");
  assert.equal(runtimeImageKindHint({
    ...openharmony,
    project_enabled: false,
  }, "project-1"), "专项·项目启用 · 未在项目启用");
});
