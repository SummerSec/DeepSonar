import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillSourceRegistrationFlash, formatSkillSourceSyncFlash } from "./skill-source-sync-flash.js";
import type { SkillSource } from "./api";

test("登记复用展示响应真实名称/信任状态，不冒充新建隔离", () => {
  const existing = formatSkillSourceRegistrationFlash({ name: "canonical-source", existing: true, trust_status: "trusted", enabled: true } as SkillSource & { existing: boolean });
  assert.match(existing, /已复用现有源「canonical-source」：已信任 \/ 已启用/);
  assert.doesNotMatch(existing, /已登记源|隔离中/);
  const fresh = formatSkillSourceRegistrationFlash({ name: "new-source", existing: false, trust_status: "quarantined", enabled: false } as SkillSource & { existing: boolean });
  assert.match(fresh, /已登记源「new-source」：隔离中 \/ 未启用/);
  const unknown = formatSkillSourceRegistrationFlash({ name: "loading", existing: true } as SkillSource & { existing: boolean });
  assert.match(unknown, /信任状态未知 \/ 启用状态未知/);
});

test("候选 hash 表示待批，changed=false 也不冒充已发布", () => {
  const message = formatSkillSourceSyncFlash({ candidate_hash: "candidate-b", changed: false, modules: 12, last_commit_sha: "bbbbbbbbbbbbbbbb" });
  assert.match(message, /候选已同步，待批准：candidate-b/);
  assert.match(message, /commit bbbbbbbbbb，12 个模块/);
  assert.match(message, /已批准目录与权限未改变/);
  assert.doesNotMatch(message, /已更新|已是最新/);
});

test("明确 null 才表示 live 健康核验，不宣称发布", () => {
  const message = formatSkillSourceSyncFlash({ candidate_hash: null, changed: false, modules: 8, last_commit_sha: "aaaaaaaaaaaaaaaa" });
  assert.match(message, /已批准 live 目录健康核验完成：commit aaaaaaaaaa/);
  assert.match(message, /没有发布新候选/);
});

test("候选字段缺失或空串不猜测已可用", () => {
  for (const candidate_hash of [undefined, "", "  "]) {
    const message = formatSkillSourceSyncFlash({ candidate_hash, changed: true, modules: 3 });
    assert.match(message, /候选状态未知/);
    assert.match(message, /请刷新源元数据/);
    assert.doesNotMatch(message, /已是最新|已更新|健康核验完成/);
  }
});
