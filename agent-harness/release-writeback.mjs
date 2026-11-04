#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
// Release writeback control flow (issues #865, #877).
//
// The default branch requires `ci-summary` and rejects direct pushes that the rule
// engine cannot match to a completed run, even when the check already passed on the
// exact SHA (v0.6.7: "ci-summary passed" then "push declined due to repository rule
// violations"). Pushing harder is not the answer, and a ruleset bypass or a
// writable PAT would let any workflow write the default branch.
//
// The writeback therefore lands the same way a person lands it: push a bot branch,
// dispatch ci.yml on it (a GITHUB_TOKEN push does not trigger workflows), wait for
// the required check, then open a pull request and merge it. Every failure path
// leaves the default branch untouched and keeps the branch for inspection.
//
// The flow is a pure function over an injected `run`, so the control flow is
// covered by agent-harness/test-release-writeback.mjs without git, gh or network.

const SUMMARY_CHECK = "ci-summary";
const BLOCKING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "skipped"]);
const UNMERGEABLE_STATES = new Set(["DIRTY", "CONFLICTING", "BEHIND", "UNKNOWN"]);

export class WritebackError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WritebackError";
    this.code = code;
  }
}

function requireValue(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new WritebackError(`${name} is required for the release writeback`, "WRITEBACK_INPUT_MISSING");
  return value;
}

/**
 * Keep the operator-visible reason, not just the exit code: `git push` rejected by a
 * ruleset explains itself on `remote:` lines that the tail of stderr does not show.
 */
function failureDetail(result) {
  const raw = String(result?.stderr ?? "").trim() || String(result?.stdout ?? "").trim();
  if (!raw) return "";
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const remote = lines.filter((line) => /^(remote:|error:|fatal:|!)/u.test(line));
  const chosen = remote.length > 0 ? remote : lines.slice(-3);
  return chosen.slice(0, 6).join(" | ").slice(0, 600);
}

function assertOk(result, what) {
  if (!result || result.status !== 0) {
    const detail = failureDetail(result);
    throw new WritebackError(`${what} failed (exit ${result?.status ?? "unknown"})${detail ? `: ${detail}` : ""}`, "WRITEBACK_COMMAND_FAILED");
  }
  return result;
}

function summaryConclusion(result) {
  const text = String(result?.stdout ?? "").trim();
  return text || "pending";
}

function parseJson(result, what) {
  try {
    return JSON.parse(String(result?.stdout ?? ""));
  } catch (error) {
    throw new WritebackError(`${what} returned unparsable JSON: ${error instanceof Error ? error.message : String(error)}`, "WRITEBACK_OUTPUT_INVALID");
  }
}

async function waitForSummaryCheck({ repo, branch, sha, run, sleep, pollLimit, log }) {
  let conclusion = "pending";
  for (let attempt = 1; attempt <= pollLimit; attempt += 1) {
    await sleep(attempt);
    const poll = run("gh", ["api", `repos/${repo}/commits/${sha}/check-runs`, "--jq",
      `[.check_runs[] | select(.name == "${SUMMARY_CHECK}")] | .[0].conclusion // "pending"`]);
    if (poll?.status !== 0) continue; // transient API hiccup: keep polling inside the budget
    conclusion = summaryConclusion(poll);
    if (conclusion === "success") break;
    if (BLOCKING_CONCLUSIONS.has(conclusion)) {
      throw new WritebackError(`${SUMMARY_CHECK} on ${branch} concluded ${conclusion}; the default branch was not modified`,
        "WRITEBACK_CHECK_FAILED");
    }
  }
  if (conclusion !== "success") {
    throw new WritebackError(`${SUMMARY_CHECK} on ${branch} did not conclude within ${pollLimit} polls; the default branch was not modified`,
      "WRITEBACK_CHECK_TIMEOUT");
  }
  log(`${SUMMARY_CHECK} passed on ${sha}`);
  return conclusion;
}

async function openOrReusePullRequest({ repo, branch, defaultBranch, sha, run, log }) {
  const listed = run("gh", ["pr", "list", "--repo", repo, "--head", branch, "--base", defaultBranch,
    "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]);
  assertOk(listed, `lookup of an existing pull request for ${branch}`);
  const existing = String(listed.stdout ?? "").trim();
  if (existing) {
    log(`reusing pull request #${existing} for ${branch}`);
    return existing;
  }
  const created = run("gh", ["pr", "create", "--repo", repo, "--base", defaultBranch, "--head", branch,
    "--title", `chore(release): sync bundled runtime catalog (${sha.slice(0, 8)})`,
    "--body", [
      "自动生成的发布回写：把本次发布校验通过的 bundled 清单与 `deploy/.env.example` 平台镜像 digest 同步到默认分支。",
      "",
      `- 来源提交：\`${sha}\``,
      `- 必需检查：\`${SUMMARY_CHECK}\` 已在该提交上通过，github-actions 之外不做任何绕过。`,
      "- 由 `agent-harness/release-writeback.mjs` 打开并合并；不再直推默认分支（#865 / #877）。",
      "",
      "<!-- dsh-superagent:worker -->",
    ].join("\n")]);
  assertOk(created, `pull request creation for ${branch}`);
  const url = String(created.stdout ?? "").trim();
  const number = url.match(/\/pull\/(\d+)\s*$/u)?.[1];
  if (!number) {
    throw new WritebackError(`pull request creation returned no number: ${url || "(empty)"}`, "WRITEBACK_OUTPUT_INVALID");
  }
  log(`opened pull request #${number} for ${branch}`);
  return number;
}

async function mergePullRequest({ repo, number, branch, defaultBranch, run, sleep, pollLimit, log }) {
  let lastState = "UNKNOWN";
  for (let attempt = 1; attempt <= pollLimit; attempt += 1) {
    const view = run("gh", ["pr", "view", number, "--repo", repo, "--json", "mergeStateStatus,state"]);
    assertOk(view, `pull request #${number} state lookup`);
    const payload = parseJson(view, `pull request #${number} state lookup`);
    lastState = String(payload.mergeStateStatus ?? "UNKNOWN");
    const state = String(payload.state ?? "");
    if (state === "MERGED") {
      log(`pull request #${number} is already merged`);
      return { merged: true, via: "already_merged" };
    }
    if (state === "CLOSED") {
      throw new WritebackError(`pull request #${number} was closed without merging; branch ${branch} kept for inspection`,
        "WRITEBACK_PR_MERGED_FAILED");
    }
    if (lastState === "CLEAN") break;
    if (UNMERGEABLE_STATES.has(lastState)) {
      throw new WritebackError(`pull request #${number} is ${lastState} and cannot be merged; branch ${branch} kept for inspection`,
        "WRITEBACK_PR_MERGED_FAILED");
    }
    // BLOCKED / UNSTABLE / has_hooks: checks are still settling, keep waiting.
    await sleep(attempt);
  }
  if (lastState !== "CLEAN") {
    throw new WritebackError(`pull request #${number} did not become mergeable within ${pollLimit} polls (last ${lastState}); branch ${branch} kept for inspection`,
      "WRITEBACK_PR_TIMEOUT");
  }
  const merged = run("gh", ["pr", "merge", number, "--repo", repo, "--merge"]);
  assertOk(merged, `merge of pull request #${number}`);
  log(`merged pull request #${number} into ${defaultBranch}`);
  return { merged: true, via: "pr_merge" };
}

async function assertLanded({ repo, sha, defaultBranch, run, log }) {
  const tip = run("gh", ["api", `repos/${repo}/commits/${defaultBranch}`, "--jq", ".sha"]);
  assertOk(tip, `lookup of ${defaultBranch}`);
  const tipSha = String(tip.stdout ?? "").trim();
  // The merge commit contains the writeback commit; verify containment rather than
  // equality so a merge commit is accepted and anything else fails closed.
  const contains = run("gh", ["api", `repos/${repo}/compare/${sha}...${tipSha}`, "--jq", ".status"]);
  assertOk(contains, `comparison of ${sha} with ${defaultBranch}`);
  const status = String(contains.stdout ?? "").trim();
  if (status !== "ahead" && status !== "identical") {
    throw new WritebackError(`${defaultBranch} does not contain ${sha} after the merge (compare status ${status || "empty"})`,
      "WRITEBACK_NOT_LANDED");
  }
  log(`verified ${defaultBranch} contains ${sha}`);
}

/**
 * @param {object} options
 * @param {(file: string, args: string[]) => {status: number, stdout?: string, stderr?: string}} options.run
 * @param {Record<string, string | undefined>} [options.env]
 */
export async function runWriteback({
  repo, branch, sha, defaultBranch = "main", env = process.env,
  run, sleep = () => new Promise((resolve) => setTimeout(resolve, 60_000)),
  pollLimit = 90, log = () => {},
}) {
  requireValue(repo, "repo");
  requireValue(branch, "branch");
  requireValue(sha, "sha");
  requireValue(defaultBranch, "defaultBranch");
  // gh CLI authentication: actions/checkout configures git credentials only and
  // the job-level GH_TOKEN does not reach this step on its own.
  requireValue(env.GH_TOKEN, "GH_TOKEN");
  if (typeof run !== "function") throw new WritebackError("run is required", "WRITEBACK_INPUT_MISSING");

  assertOk(run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]), `push of ${branch}`);
  log(`pushed ${branch}`);

  try {
    assertOk(run("gh", ["workflow", "run", "ci.yml", "--repo", repo, "--ref", branch]), "ci.yml dispatch");
  } catch (error) {
    // Without a run there is no ci-summary to wait for; never touch the default branch.
    throw new WritebackError(`${error.message}; ${defaultBranch} was not modified`, "WRITEBACK_DISPATCH_FAILED");
  }
  log("dispatched ci.yml on the writeback branch");

  const conclusion = await waitForSummaryCheck({ repo, branch, sha, run, sleep, pollLimit, log });
  const number = await openOrReusePullRequest({ repo, branch, defaultBranch, sha, run, log });
  const merge = await mergePullRequest({ repo, number, branch, defaultBranch, run, sleep, pollLimit, log });
  await assertLanded({ repo, sha, defaultBranch, run, log });
  assertOk(run("git", ["push", "origin", "--delete", branch]), `cleanup of ${branch}`);
  return { conclusion, branch, defaultBranch, sha, pullRequest: number, via: merge.via };
}

// Exact file identity: `endsWith("release-writeback.mjs")` would also match
// agent-harness/test-release-writeback.mjs and run the CLI inside its test.
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { execFileSync } = await import("node:child_process");
  const run = (file, args) => {
    try {
      const stdout = execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stdout };
    } catch (error) {
      return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
    }
  };
  try {
    const result = await runWriteback({
      repo: process.env.GITHUB_REPOSITORY,
      branch: process.env.WRITEBACK_BRANCH,
      sha: process.env.WRITEBACK_SHA,
      defaultBranch: process.env.DEFAULT_BRANCH,
      run,
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof WritebackError ? `${error.code}: ${error.message}` : String(error));
    process.exitCode = 1;
  }
}
