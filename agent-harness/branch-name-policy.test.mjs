import assert from "node:assert/strict";
import test from "node:test";
import {
  FORBIDDEN_BRANCH_PREFIX_TOKENS,
  RECOMMENDED_BRANCH_PREFIXES,
  branchNameViolation,
  assertBranchName,
  requiredRulesetPatterns,
} from "./branch-name-policy.mjs";

// #931: the same shape must be rejected however it is written, and a token that only
// appears later in the name must stay allowed.

const blocked = [
  "agent/903-repair-lifecycle",
  "agent-903-repair-lifecycle",
  "agent_903",
  "agent",
  "AGENT/903",
  "Agent-903",
  "codex/fix-hub-plan-scope",
  "Codex/fix",
  "codex-anything",
  "cursor/x",
  "claude/x",
  "copilot/x",
  "chatgpt/x",
  "gemini/x",
  "openai/x",
  "agent/nested/deeper",
];

for (const name of blocked) {
  test(`rejects tool-named branch: ${name}`, () => {
    const result = branchNameViolation(name);
    assert.equal(result.ok, false, `${name} must be rejected`);
    assert.equal(result.reason, "tool-prefix");
    assert.throws(() => assertBranchName(name), /not allowed/);
  });
}

const allowed = [
  "feat/123-branch-naming",
  "fix/foo_bar",
  "docs/x",
  "refactor/a-b",
  "test/x",
  "chore/931-branch-naming",
  "feat/agent-migration",
  "fix/918-provider-headers",
  "chore/rename-agent-configs",
  "release/v0.6.15",
  "feature/agents-in-name",
  "bugfix/codex-compat",
];

for (const name of allowed) {
  test(`allows descriptive branch: ${name}`, () => {
    assert.deepEqual(branchNameViolation(name), { ok: true });
    assert.equal(assertBranchName(name), name);
  });
}

test("empty and non-string names are rejected instead of silently passing", () => {
  assert.equal(branchNameViolation("").ok, false);
  assert.equal(branchNameViolation("   ").ok, false);
  assert.equal(branchNameViolation(undefined).reason, "empty");
  assert.equal(branchNameViolation(null).reason, "empty");
});

test("recommended prefixes are descriptive and never tool names", () => {
  assert.deepEqual(RECOMMENDED_BRANCH_PREFIXES, ["feat", "fix", "docs", "refactor", "test", "chore"]);
  for (const prefix of RECOMMENDED_BRANCH_PREFIXES) {
    assert.equal(FORBIDDEN_BRANCH_PREFIX_TOKENS.includes(prefix), false);
  }
});

test("required ruleset patterns cover slash, hyphen, underscore and case variants", () => {
  const patterns = requiredRulesetPatterns();
  for (const token of FORBIDDEN_BRANCH_PREFIX_TOKENS) {
    assert.ok(patterns.includes(`refs/heads/${token}*`), token);
    assert.ok(patterns.includes(`refs/heads/${token}/**`), token);
  }
  const capitalized = `${FORBIDDEN_BRANCH_PREFIX_TOKENS[0].charAt(0).toUpperCase()}${FORBIDDEN_BRANCH_PREFIX_TOKENS[0].slice(1)}`;
  assert.ok(patterns.includes(`refs/heads/${capitalized}*`));
  assert.equal(new Set(patterns).size, patterns.length, "no duplicate patterns");
});

test("AGENTS.md documents the policy instead of requiring agent/ branches", async () => {
  const { readFileSync } = await import("node:fs");
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.doesNotMatch(agents, /`agent\/` 任务分支/);
  assert.match(agents, /分支命名/);
  for (const prefix of RECOMMENDED_BRANCH_PREFIXES) {
    assert.match(agents, new RegExp(`\\b${prefix}/`));
  }
  for (const token of FORBIDDEN_BRANCH_PREFIX_TOKENS) {
    assert.match(agents, new RegExp(`\\b${token}\\b`), `AGENTS.md must name ${token}`);
  }
});