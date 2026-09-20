import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./components/ProjectCliProviderAllowlistPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("项目设置挂载 CLI/Provider 启用面板，文案精简且保留软缺省语义", () => {
  assert.match(settings, /ProjectCliProviderAllowlistPanel/);
  assert.match(panel, /CLI \/ Provider 启用与缺省/);
  assert.match(panel, /启用边界与配额/);
  assert.match(panel, /缺省仅软回退/);
  assert.match(panel, /并发在凭据页/);
  assert.match(panel, /启用 Agent 类型/);
  assert.match(panel, /启用 Provider 账号/);
  assert.match(panel, /缺省 CLI/);
  assert.match(panel, /不设（回退角色）/);
  assert.match(panel, /允许目录直通（默认关）/);
  assert.doesNotMatch(panel, /每个角色必须绑死/);
  assert.doesNotMatch(panel, /角色并发/);
  assert.doesNotMatch(panel, /不会通过修改 Credential CLI/);
  assert.doesNotMatch(panel, /本项目相对全局/);
  assert.doesNotMatch(panel, /项目数据包请到/);
});

test("Provider 选项按已启用 CLI 过滤，并展示并发摘要", () => {
  assert.match(panel, /filteredByCli/);
  assert.match(panel, /concurrencySummary/);
  assert.match(panel, /账号并发/);
  assert.match(panel, /模型并发/);
  assert.match(panel, /暂无兼容的 LLM Provider/);
});
