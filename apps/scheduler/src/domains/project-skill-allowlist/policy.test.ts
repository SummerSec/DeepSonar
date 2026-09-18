import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSkillSourcesProjectEnabled,
  markSkillAllowlistConfigured,
  parseSkillAllowlistConfiguredFlag,
  skillSourceIdsFromModuleSelectors,
} from "./policy.js";

const SRC_A = "11111111-1111-4111-8111-111111111111";
const SRC_B = "22222222-2222-4222-8222-222222222222";

test("configured flag: 缺省 false；mark 后 true", () => {
  assert.equal(parseSkillAllowlistConfiguredFlag({}), false);
  const cfg: Record<string, unknown> = {};
  markSkillAllowlistConfigured(cfg);
  assert.equal(parseSkillAllowlistConfiguredFlag(cfg), true);
});

test("assert: 未配置不阻断；配置后 fail-closed", () => {
  const open = { configured: false, enabled_skill_source_ids: [] as string[] };
  assert.doesNotThrow(() => assertSkillSourcesProjectEnabled(open, [SRC_B]));

  const closed = { configured: true, enabled_skill_source_ids: [SRC_A] };
  assert.doesNotThrow(() => assertSkillSourcesProjectEnabled(closed, [SRC_A]));
  assert.throws(
    () => assertSkillSourcesProjectEnabled(closed, [SRC_B]),
    /不在本项目已启用 Skill 源白名单/,
  );
});

test("skillSourceIdsFromModuleSelectors: 解析 source/plugin/module selector", () => {
  const ids = skillSourceIdsFromModuleSelectors([
    `${SRC_A}:source:*`,
    `${SRC_A}:plugin:team/tools`,
    `${SRC_B}:skills/demo`,
    "bad",
  ]);
  assert.deepEqual(ids, [SRC_A, SRC_B]);
});

test("迁移契约：历史 RoleConfig selectors 必须能抽出 source_id 以种子白名单", () => {
  const selectors = [
    `${SRC_A}:source:*`,
    `${SRC_B}:plugin:pack`,
  ];
  assert.deepEqual(skillSourceIdsFromModuleSelectors(selectors), [SRC_A, SRC_B]);
});
