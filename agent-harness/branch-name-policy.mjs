#!/usr/bin/env node
// #931: development branches are named for their purpose, never for the AI tool that
// created them. The GitHub ruleset only rejects what it is configured to match, so this
// module is the shared definition used by docs, tests and any pre-push check.

/** Tools whose name must not start a branch. Kept in sync with ruleset 20986002. */
export const FORBIDDEN_BRANCH_PREFIX_TOKENS = [
  "agent",
  "codex",
  "cursor",
  "claude",
  "copilot",
  "chatgpt",
  "gemini",
  "openai",
];

/** Recommended semantic prefixes. Not an allowlist: other descriptive names are fine. */
export const RECOMMENDED_BRANCH_PREFIXES = ["feat", "fix", "docs", "refactor", "test", "chore"];

const SEPARATORS = new Set(["/", "-", "_"]);

/**
 * A name is blocked when a forbidden token is the whole first segment or is followed by
 * a separator, ignoring case. `feat/agent-migration` is allowed: only the start counts.
 */
export function branchNameViolation(name) {
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, reason: "empty" };
  }
  const value = name.trim();
  const lower = value.toLowerCase();
  for (const token of FORBIDDEN_BRANCH_PREFIX_TOKENS) {
    if (!lower.startsWith(token)) continue;
    const next = lower.charAt(token.length);
    if (next === "" || SEPARATORS.has(next)) {
      return { ok: false, reason: "tool-prefix", token };
    }
  }
  return { ok: true };
}

export function assertBranchName(name) {
  const result = branchNameViolation(name);
  if (!result.ok) {
    throw new Error(
      `branch name "${String(name)}" is not allowed: ${result.reason}`
      + (result.token ? ` (forbidden tool prefix "${result.token}")` : "")
      + `; use one of ${RECOMMENDED_BRANCH_PREFIXES.join(", ")} or another descriptive prefix`,
    );
  }
  return name;
}

/** ruleset ref patterns that must exist for the block to cover slash/hyphen/underscore. */
export function requiredRulesetPatterns() {
  return FORBIDDEN_BRANCH_PREFIX_TOKENS.flatMap((token) => {
    const capitalized = `${token.charAt(0).toUpperCase()}${token.slice(1)}`;
    return [token, capitalized].flatMap((base) => [
      `refs/heads/${base}*`,
      `refs/heads/${base}/**`,
    ]);
  });
}