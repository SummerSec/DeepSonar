import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSkillSourceBinding } from "./api";
import {
  describeSkillSourceReadiness,
  hasUsableCatalog,
  skillSourceRegisteredHint,
  skillSourceWritePermissionHint,
} from "./skill-source-readiness";

function binding(overrides: Partial<ProjectSkillSourceBinding> = {}): ProjectSkillSourceBinding {
  return {
    skill_source_id: "11111111-1111-4111-8111-111111111111",
    name: "team-skills",
    repo_url: "https://github.com/example/team-skills",
    branch: "main",
    trust_status: "trusted",
    source_enabled: true,
    project_enabled: true,
    module_count: 3,
    last_commit_sha: "abc1234",
    last_content_hash: "hash",
    synced_at: "2026-11-06T00:00:00.000Z",
    ...overrides,
  };
}

test("#953 四道门都满足才算本项目可用", () => {
  const ready = describeSkillSourceReadiness({ source: binding(), projectEnabled: true });
  assert.equal(ready.usable, true);
  assert.equal(ready.tone, "ready");
  assert.deepEqual(ready.blockers, []);
  assert.equal(ready.nextStep, null);
});

test("#953 新登记源按准入顺序列出阻塞原因，不表述成已可运行", () => {
  const registered = describeSkillSourceReadiness({
    source: binding({ trust_status: "quarantined", source_enabled: false, synced_at: null, module_count: 0, project_enabled: false }),
    projectEnabled: false,
  });
  assert.equal(registered.usable, false);
  assert.equal(registered.label, "待平台信任");
  assert.deepEqual(registered.blockers, [
    "待平台信任：登记成功不等于已审核，需要批准后才能下发",
    "平台未启用该源，Job 不会读取它的目录",
    "尚未同步：平台还没有该仓库的目录副本",
    "本项目未启用该源",
  ]);
  assert.match(registered.nextStep ?? "", /批准信任/);
});

test("#953 平台已禁用是硬阻塞，下一步指向平台管理员", () => {
  const disabled = describeSkillSourceReadiness({
    source: binding({ trust_status: "disabled", source_enabled: false }),
    projectEnabled: true,
  });
  assert.equal(disabled.tone, "blocked");
  assert.equal(disabled.label, "平台已禁用");
  assert.match(disabled.blockers[0] ?? "", /平台已禁用/);
  assert.match(disabled.nextStep ?? "", /管理员/);
});

test("#953 同步完成但没有可用 Skill 时给出可行动原因", () => {
  const empty = describeSkillSourceReadiness({
    source: binding({ module_count: 0 }),
    projectEnabled: true,
  });
  assert.equal(empty.usable, false);
  assert.equal(empty.label, "无可用 Skill");
  assert.match(empty.blockers[0] ?? "", /没有可用 Skill/);
  assert.match(empty.nextStep ?? "", /SKILL\.md/);
  assert.equal(hasUsableCatalog(binding({ module_count: 0 })), false);
  assert.equal(hasUsableCatalog(binding()), true);
});

test("#953 仅本项目未勾选时状态是可启用而不是平台未准入", () => {
  const off = describeSkillSourceReadiness({ source: binding({ project_enabled: false }), projectEnabled: false });
  assert.equal(off.label, "本项目已停用");
  assert.deepEqual(off.blockers, ["本项目未启用该源"]);
  assert.match(off.nextStep ?? "", /勾选/);
});

test("#953 draft 勾选优先于服务端状态", () => {
  const draftOn = describeSkillSourceReadiness({ source: binding({ project_enabled: false }), projectEnabled: true });
  assert.equal(draftOn.usable, true);
  assert.match(skillSourceWritePermissionHint(false) ?? "", /skills:write/);
  assert.equal(skillSourceWritePermissionHint(true), null);
  assert.match(skillSourceRegisteredHint("x-skills"), /仍是隔离状态/);
  assert.match(skillSourceRegisteredHint("x-skills"), /同步 → 批准信任 → 平台启用/);
});