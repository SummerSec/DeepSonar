#!/usr/bin/env node
// Release writeback control flow (issue #865, review follow-up #866).
//
// The default branch requires `ci-summary`. A GITHUB_TOKEN push does not trigger
// workflows, so the writeback pushes a bot branch, dispatches ci.yml on it, waits
// for the required check on that exact SHA and only then fast-forwards the
// default branch. Every failure path must leave the default branch untouched and
// keep the bot branch for inspection.
//
// The flow is a pure function over an injected `run`, so the control flow is
// covered by agent-harness/test-release-writeback.mjs without git, gh or network.

const SUMMARY_CHECK = "ci-summary";
const BLOCKING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "skipped"]);

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

function assertOk(result, what) {
  if (!result || result.status !== 0) {
    const detail = String(result?.stderr ?? result?.stdout ?? "").trim().split("\n").slice(-3).join(" ");
    throw new WritebackError(`${what} failed (exit ${result?.status ?? "unknown"})${detail ? `: ${detail}` : ""}`, "WRITEBACK_COMMAND_FAILED");
  }
  return result;
}

function summaryConclusion(result) {
  const text = String(result?.stdout ?? "").trim();
  return text || "pending";
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

  let conclusion = "pending";
  for (let attempt = 1; attempt <= pollLimit; attempt += 1) {
    await sleep(attempt);
    const poll = run("gh", ["api", `repos/${repo}/commits/${sha}/check-runs`, "--jq",
      `[.check_runs[] | select(.name == "${SUMMARY_CHECK}")] | .[0].conclusion // "pending"`]);
    if (poll?.status !== 0) continue; // transient API hiccup: keep polling inside the budget
    conclusion = summaryConclusion(poll);
    if (conclusion === "success") break;
    if (BLOCKING_CONCLUSIONS.has(conclusion)) {
      throw new WritebackError(`${SUMMARY_CHECK} on ${branch} concluded ${conclusion}; ${defaultBranch} was not modified`,
        "WRITEBACK_CHECK_FAILED");
    }
  }
  if (conclusion !== "success") {
    throw new WritebackError(`${SUMMARY_CHECK} on ${branch} did not conclude within ${pollLimit} polls; ${defaultBranch} was not modified`,
      "WRITEBACK_CHECK_TIMEOUT");
  }
  log(`${SUMMARY_CHECK} passed on ${sha}`);

  try {
    assertOk(run("git", ["push", "origin", `HEAD:${defaultBranch}`]), `push to ${defaultBranch}`);
  } catch (error) {
    throw new WritebackError(`${error.message}; branch ${branch} kept for inspection`, "WRITEBACK_PUSH_CONFLICT");
  }
  assertOk(run("git", ["push", "origin", "--delete", branch]), `cleanup of ${branch}`);
  return { conclusion, branch, defaultBranch, sha };
}

const isMain = process.argv[1] && process.argv[1].endsWith("release-writeback.mjs");
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
