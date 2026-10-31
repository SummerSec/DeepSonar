import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const settingsPanel = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const imagePolicyPath = fileURLToPath(new URL("./components/ProjectImagePolicySection.tsx", import.meta.url));

test("#674 设置页不再挂载项目镜像策略组件", () => {
  assert.equal(existsSync(imagePolicyPath), false);
  assert.doesNotMatch(settingsPanel, /ProjectImagePolicySection/);
  assert.doesNotMatch(settingsPanel, /projectRuntimeImageChoices/);
  assert.doesNotMatch(settingsPanel, /saveImagePolicy|imageStrategy|role_runtime_images/);
  assert.doesNotMatch(settingsPanel, /镜像缺省已保存/);
});
