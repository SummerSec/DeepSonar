import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./components/ProjectModelPolicyPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const wrap = readFileSync(new URL("./components/ProjectCompositionPolicyPanels.tsx", import.meta.url), "utf8");

test("项目设置挂载模型允许/缺省/fallback 面板", () => {
  assert.match(settings, /ProjectCompositionPolicyPanels/);
  assert.match(wrap, /ProjectModelPolicyPanel/);
  assert.match(panel, /模型允许 \/ 缺省 \/ Fallback/);
  assert.match(panel, /list_available_models/);
  assert.match(panel, /fail-closed/);
  assert.match(panel, /缺省模型（软回退）/);
  assert.match(panel, /Fallback 模型/);
  assert.match(panel, /启用模型（来自已启用 Provider 的模型目录）/);
  assert.match(panel, /不暴露密钥/);
  assert.doesNotMatch(panel, /sk-[a-zA-Z0-9]/);
  assert.doesNotMatch(panel, /每个角色必须绑死/);
});

test("设置页挂载组合策略面板（CLI/Provider + 模型）", () => {
  assert.match(wrap, /enabled_model_ids/);
  assert.match(wrap, /model_policy_configured/);
  assert.match(wrap, /ProjectCliProviderAllowlistPanel/);
});
