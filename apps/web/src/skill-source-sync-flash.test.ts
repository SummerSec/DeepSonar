import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillSourceSyncFlash } from "./skill-source-sync-flash.js";

test("未变化时展示当前 commit，不说已更新", () => {
  assert.equal(
    formatSkillSourceSyncFlash({
      changed: false,
      modules: 12,
      previous_commit_sha: "aaaaaaaaaaaaaaaa",
      last_commit_sha: "aaaaaaaaaaaaaaaa",
    }),
    "已是最新：commit aaaaaaaaaa，12 个模块",
  );
});

test("commit 变化时展示新旧短 sha", () => {
  assert.equal(
    formatSkillSourceSyncFlash({
      changed: true,
      modules: 8,
      previous_commit_sha: "oldoldoldoldold",
      last_commit_sha: "newnewnewnewnew",
    }),
    "已更新 commit oldoldoldo → newnewnewn，8 个模块",
  );
});

test("首次同步只有新 commit", () => {
  assert.equal(
    formatSkillSourceSyncFlash({
      changed: true,
      modules: 3,
      previous_commit_sha: null,
      last_commit_sha: "firstcommitxx",
    }),
    "已更新到 commit firstcommi，3 个模块",
  );
});
