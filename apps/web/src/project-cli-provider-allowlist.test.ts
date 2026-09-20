import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./components/ProjectCliProviderAllowlistPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("项目设置挂载 CLI/Provider 启用面板，不再暴露软缺省控件", () => {
  assert.match(settings, /ProjectCliProviderAllowlistPanel/);
  assert.match(panel, /CLI \/ Provider 启用/);
  assert.match(panel, /启用 Agent 类型/);
  assert.match(panel, /启用 Provider 账号/);
  assert.match(panel, /enabled_agent_clis/);
  assert.match(panel, /enabled_credential_ids/);
  assert.doesNotMatch(panel, /缺省 CLI/);
  assert.doesNotMatch(panel, /缺省 Provider/);
  assert.doesNotMatch(panel, /缺省模型/);
  assert.doesNotMatch(panel, /Fallback 模型顺序/);
  assert.doesNotMatch(panel, /允许目录直通/);
  assert.doesNotMatch(panel, /不设（回退角色）/);
  assert.doesNotMatch(panel, /不设（Hub \/ 角色选择）/);
  assert.doesNotMatch(panel, /defaultAgentCli/);
  assert.doesNotMatch(panel, /allowModelCatalogPassthrough/);
  assert.doesNotMatch(settings, /defaultAgentCli=/);
  assert.doesNotMatch(settings, /allowModelCatalogPassthrough=/);
});

test("Provider 选项按已启用 CLI 过滤，并展示并发摘要", () => {
  assert.match(panel, /filteredByCli/);
  assert.match(panel, /concurrencySummary/);
  assert.match(panel, /账号并发/);
  assert.match(panel, /暂无兼容的 LLM Provider/);
});
