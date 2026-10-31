import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./components/ProjectSkillSourceAllowlistPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const roleConfig = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");

test("项目设置挂载 Skill 源白名单面板，并强调控制面/Hub 选型", () => {
  assert.match(settings, /ProjectSkillSourceAllowlistPanel/);
  assert.match(panel, /Skill 源启用白名单/);
  assert.match(panel, /平台只划定项目可启用/);
  assert.match(panel, /Hub 运行时从已启用集合选型/);
  assert.match(panel, /平台控制能力始终由 Scheduler 强制注入/);
  assert.doesNotMatch(panel, /deepsonar-control/);
  assert.match(panel, /历史 RoleConfig/);
  assert.match(panel, /projectSkillSources/);
  assert.match(panel, /setProjectSkillSourceEnabled/);
});

test("RoleConfig 模块勾选标注过渡态并过滤项目白名单", () => {
  assert.match(roleConfig, /enabledSkillSourceIds/);
  assert.match(roleConfig, /pickerSources/);
  assert.match(roleConfig, /过渡/);
  assert.match(roleConfig, /#603/);
});
