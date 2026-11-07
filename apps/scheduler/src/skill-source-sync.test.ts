import assert from "node:assert/strict";
import test from "node:test";
import { cloneSkillSource, skillSourceCatalogChanged } from "./skill-sources.js";
import { probeSkillSourceRemoteHead } from "./skill-source-drift.js";
import { skillSourceSyncErrorCode } from "./skill-source-catalog-lifecycle.js";

test("remote probe matches the full configured ref, not ls-remote's first line", async () => {
  const sha = "a".repeat(40);
  const result = await probeSkillSourceRemoteHead({ repoUrl: "https://127.0.0.1/skills.git", branch: "main",
    execFile: async (_file, args) => {
      assert.equal(args.at(-1), "refs/heads/main");
      return { stdout: `${"b".repeat(40)}\trefs/heads/not-main\n${sha}\trefs/heads/main\n` };
    } });
  assert.equal(result, sha);
  assert.equal(await probeSkillSourceRemoteHead({ repoUrl: "https://127.0.0.1/skills.git", branch: "main",
    execFile: async () => ({ stdout: `${sha}\trefs/heads/main-other\n` }) }), null);
});

test("missing configured branch never clones the default branch", async () => {
  let calls = 0;
  await assert.rejects(cloneSkillSource({ repoUrl: "https://127.0.0.1/skills.git", branch: "missing", destination: "/tmp/unused",
    execFile: async () => { calls++; throw new Error("branch missing"); } }), /branch missing/);
  assert.equal(calls, 1);
});

test("sync failure state never retains stderr, credentials or URL queries", () => {
  assert.equal(skillSourceSyncErrorCode(new Error("fatal https://user:secret@127.0.0.1/repo?token=secret")), "sync_failed");
});

test("首次同步（旧 sha/hash 为空）算更新", () => {
  assert.equal(skillSourceCatalogChanged({
    previousCommitSha: null,
    previousContentHash: null,
    lastCommitSha: "abc1234deadbeef",
    lastContentHash: "hash-1",
  }), true);
});

test("commit sha 变化算更新", () => {
  assert.equal(skillSourceCatalogChanged({
    previousCommitSha: "aaa1111",
    previousContentHash: "hash-1",
    lastCommitSha: "bbb2222",
    lastContentHash: "hash-1",
  }), true);
});

test("内容哈希变化算更新", () => {
  assert.equal(skillSourceCatalogChanged({
    previousCommitSha: "aaa1111",
    previousContentHash: "hash-old",
    lastCommitSha: "aaa1111",
    lastContentHash: "hash-new",
  }), true);
});

test("sha 与哈希都没变则不算更新（忽略 synced_at）", () => {
  assert.equal(skillSourceCatalogChanged({
    previousCommitSha: "aaa1111",
    previousContentHash: "hash-1",
    lastCommitSha: "aaa1111",
    lastContentHash: "hash-1",
  }), false);
});

test("空白与 null 视为同一空值", () => {
  assert.equal(skillSourceCatalogChanged({
    previousCommitSha: "",
    previousContentHash: null,
    lastCommitSha: null,
    lastContentHash: "",
  }), false);
});
