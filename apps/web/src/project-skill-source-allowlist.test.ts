import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./components/ProjectSkillSourceAllowlistPanel.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const roleConfig = readFileSync(new URL("./RoleConfigEditor.tsx", import.meta.url), "utf8");
const readiness = readFileSync(new URL("./skill-source-readiness.ts", import.meta.url), "utf8");

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

test("#953 项目面板无论有无源都提供自定义添加入口，并复用平台登记/同步/信任能力", () => {
  // 添加入口不在 sources.length 分支里：空态与有源时都能登记。
  assert.match(panel, /添加 Skill 源/);
  assert.match(panel, /api\.createSkillSource/);
  assert.match(panel, /SkillSourceCatalogActions/);
  assert.doesNotMatch(panel, /api\.(syncSkillSource|trustSkillSource)/);
  assert.match(panel, /官方源只是预置项/);
  // 不允许绕过平台准入：没有直接写库或跳过信任的路径。
  assert.doesNotMatch(panel, /trust_status: "trusted".*create/);
});

test("#953 状态与阻塞原因来自共用判定模型，登记成功不表述为已可运行", () => {
  assert.match(panel, /describeSkillSourceReadiness/);
  assert.match(panel, /readiness\.blockers/);
  assert.match(panel, /readiness\.nextStep/);
  assert.match(panel, /skillSourceRegisteredHint/);
  assert.match(panel, /登记成功不等于已可运行/);
});

test("#953 权限不足时说明缺少 skills:write 与具体下一步", () => {
  assert.match(panel, /canAccessAnyScope\(me, \["skills:write"\]\)/);
  assert.match(panel, /skillSourceWritePermissionHint/);
  assert.match(readiness, /缺少 skills:write 权限/);
  assert.match(readiness, /管理员/);
});

test("#953 添加入口不使用原生 select，也不放宽 URL 校验收口", () => {
  assert.doesNotMatch(panel, /<select/);
  assert.match(panel, /仅支持 https Git 地址/);
  assert.match(panel, /登记成功不等于已可运行，也不自动信任/);
});
