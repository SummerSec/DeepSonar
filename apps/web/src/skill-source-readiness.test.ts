import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSkillSourceBinding } from "./api";
import { describeSkillSourceReadiness, hasUsableCatalog, skillSourceRegisteredHint, skillSourceWritePermissionHint } from "./skill-source-readiness";

function binding(overrides: Partial<ProjectSkillSourceBinding> = {}): ProjectSkillSourceBinding {
  return {
    skill_source_id: "11111111-1111-4111-8111-111111111111", name: "team-skills",
    repo_url: "https://127.0.0.1/team-skills", branch: "main", trust_status: "trusted",
    source_enabled: true, project_enabled: true, module_count: 3, last_commit_sha: "a".repeat(40),
    last_content_hash: "a".repeat(64), catalog_snapshot_hash: "a".repeat(64),
    source_instance_id: "22222222-2222-4222-8222-222222222222", revocation_epoch: "0",
    candidate_hash: null, candidate_json: null, last_checked_at: null, last_sync_error: null,
    synced_at: "2026-11-06T00:00:00.000Z", ...overrides,
  };
}

const describe = (source: ProjectSkillSourceBinding, projectEnabled = source.project_enabled) => describeSkillSourceReadiness({ source, projectEnabled });

test("only persisted project flags, platform trust/enabled and a nonempty approved hash grant usability", () => {
  assert.equal(describe(binding()).usable, true);
  assert.equal(describe(binding({ project_enabled: false })).usable, false);
  assert.equal(describe(binding({ source_enabled: false })).usable, false);
  assert.equal(describe(binding({ trust_status: "quarantined" })).usable, false);
  assert.equal(describe(binding({ module_count: 0 })).usable, false);
  for (const hash of [null, "", "hash", "g".repeat(64), "a".repeat(63)]) {
    assert.equal(hasUsableCatalog(binding({ catalog_snapshot_hash: hash })), false);
  }
  assert.deepEqual(describe(binding()).blockers, []);
});

test("unsaved enable is pending, not effective; unsaved disable cannot revoke persisted usability", () => {
  const pendingOn = describe(binding({ project_enabled: false }), true);
  assert.equal(pendingOn.usable, false);
  assert.equal(pendingOn.label, "本项目已停用");
  assert.match(pendingOn.nextStep ?? "", /启用待保存/);
  const pendingOff = describe(binding(), false);
  assert.equal(pendingOff.usable, true);
  assert.match(pendingOff.nextStep ?? "", /停用待保存/);
});

test("unknown/stale sync timestamp is freshness evidence, not an access gate", () => {
  assert.equal(describe(binding({ synced_at: null })).usable, true);
  assert.equal(describe(binding({ synced_at: "2000-01-01T00:00:00.000Z" })).usable, true);
  assert.equal(describe(binding({ synced_at: null, catalog_snapshot_hash: null })).usable, false);
});

test("pending candidate B does not invalidate approved catalog A", () => {
  const source = binding({ candidate_hash: "b".repeat(64) });
  source.candidate_json = {
    schema: "deepsonar.skill-source-candidate/v1", source_instance_id: source.source_instance_id!,
    repo_url: source.repo_url, branch: source.branch, revocation_epoch: "0",
    commit_sha: "b".repeat(40), content_hash: "b".repeat(64), module_count: 4,
    synced_at: "2026-11-07T00:00:00.000Z", synced_by: null,
  };
  assert.equal(describe(source).usable, true);
});

test("quarantined registration and disabled/empty sources give actionable reasons", () => {
  const registered = describe(binding({ trust_status: "quarantined", source_enabled: false, module_count: 0, catalog_snapshot_hash: null }));
  assert.equal(registered.label, "待平台信任");
  assert.equal(registered.usable, false);
  assert.match(registered.nextStep ?? "", /同步候选/);
  const disabled = describe(binding({ trust_status: "disabled", source_enabled: false }));
  assert.equal(disabled.tone, "blocked");
  assert.match(disabled.nextStep ?? "", /管理员/);
  assert.match(describe(binding({ module_count: 0 })).nextStep ?? "", /SKILL\.md/);
});

test("permission hints distinguish project writes from global supply-chain authority", () => {
  assert.match(skillSourceWritePermissionHint(false, false) ?? "", /缺少 skills:write 权限/);
  assert.match(skillSourceWritePermissionHint(true, false) ?? "", /未限定项目的全局 skills:write/);
  assert.equal(skillSourceWritePermissionHint(true, true), null);
  const registered = { name: "fixture", trust_status: "quarantined" as const, enabled: false };
  assert.match(skillSourceRegisteredHint(registered), /仍是隔离状态/);
  assert.match(skillSourceRegisteredHint(registered), /所有未显式停用/);
  assert.doesNotMatch(skillSourceRegisteredHint(registered), /在本项目勾选/);
  assert.match(skillSourceRegisteredHint({ name: "actual", trust_status: "trusted", enabled: true }), /actual.*trusted.*平台已启用/);
});
