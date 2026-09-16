import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./components/ProjectCliProviderAllowlistPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("项目设置挂载 CLI/Provider 启用面板，文案为组合积木与软缺省", () => {
  assert.match(settings, /ProjectCliProviderAllowlistPanel/);
  assert.match(panel, /CLI \/ Provider 启用与缺省/);
  assert.match(panel, /平台只划定启用边界与配额/);
  assert.match(panel, /自由组合 CLI×Provider×镜像/);
  assert.match(panel, /缺省是软回退/);
  assert.match(panel, /并发表在 Provider \/ 凭据上配置/);
  assert.match(panel, /启用 Agent 类型/);
  assert.match(panel, /启用 Provider 账号/);
  assert.match(panel, /缺省 Agent CLI（软回退）/);
  assert.match(panel, /不设缺省（回退 RoleConfig）/);
  assert.doesNotMatch(panel, /每个角色必须绑死/);
  assert.doesNotMatch(panel, /角色并发/);
});

test("Provider 选项按已启用 CLI 过滤，并展示并发摘要", () => {
  assert.match(panel, /filteredByCli/);
  assert.match(panel, /concurrencySummary/);
  assert.match(panel, /账号并发/);
  assert.match(panel, /模型并发/);
  assert.match(panel, /暂无与已启用 CLI 兼容的 LLM Provider/);
});
