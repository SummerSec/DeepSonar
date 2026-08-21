import assert from "node:assert/strict";
import test from "node:test";
import { isRuntimeImagePinStale, runtimeImageKindHint, runtimeImageOptionLabel, runtimeImagePinLabel, runtimeImageSelectOption } from "./runtime-image-option";
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

test("stale project pin label is distinct from follow-latest and a still-valid pin", () => {
  assert.equal(isRuntimeImagePinStale({
    pin_stale: true,
    selected_version_id: "99999999-9999-4999-8999-999999999999",
  }), true);
  assert.equal(isRuntimeImagePinStale({
    pin_stale: true,
    selected_version_id: null,
  }), false);
  assert.equal(runtimeImagePinLabel({
    selected_version_id: null,
    selected_version: null,
    latest_version: "0.1.39",
    pin_stale: false,
  }), "自动（跟随最新 trusted）");
  assert.equal(runtimeImagePinLabel({
    selected_version_id: "99999999-9999-4999-8999-999999999999",
    selected_version: "0.1.38",
    latest_version: "0.1.39",
    pin_stale: true,
  }), "固定 0.1.38 · 已过期");
  assert.equal(runtimeImagePinLabel({
    selected_version_id: "99999999-9999-4999-8999-999999999999",
    selected_version: "0.1.38",
    latest_version: "0.1.39",
    pin_stale: false,
  }), "固定 0.1.38 · 最新 0.1.39");
  assert.equal(runtimeImagePinLabel({
    selected_version_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    selected_version: "0.1.43",
    latest_version: "0.1.43",
    pin_stale: false,
    official: true,
  }), "已随官方升到 0.1.43");
  assert.equal(runtimeImagePinLabel({
    selected_version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    selected_version: "1.2.3",
    latest_version: "1.2.3",
    pin_stale: false,
    official: false,
  }), "固定 1.2.3");
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
