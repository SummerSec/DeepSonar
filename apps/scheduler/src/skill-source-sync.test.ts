import assert from "node:assert/strict";
import test from "node:test";
import { skillSourceCatalogChanged } from "./skill-sources.js";

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
