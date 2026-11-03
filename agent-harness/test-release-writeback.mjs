import assert from "node:assert/strict";
import { runWriteback, WritebackError } from "./release-writeback.mjs";

// The release writeback decides whether the default branch moves. It must be
// covered without git, gh or network: every command is injected and recorded.

function harness({ dispatchFails = false, conclusions = ["success"], pushDefaultFails = false, deleteFails = false } = {}) {
  const calls = [];
  let pollIndex = 0;
  const run = (file, args) => {
    calls.push([file, ...args].join(" "));
    const joined = [file, ...args].join(" ");
    if (joined.startsWith("git push origin HEAD:refs/heads/")) return { status: 0, stdout: "" };
    if (joined.startsWith("gh workflow run")) {
      return dispatchFails ? { status: 1, stderr: "HTTP 403: Resource not accessible" } : { status: 0, stdout: "" };
    }
    if (joined.startsWith("gh api")) {
      const conclusion = conclusions[Math.min(pollIndex, conclusions.length - 1)];
      pollIndex += 1;
      return { status: 0, stdout: `${conclusion}\n` };
    }
    if (joined.startsWith("git push origin HEAD:")) {
      return pushDefaultFails ? { status: 1, stderr: "! [rejected] main -> main (non-fast-forward)" } : { status: 0, stdout: "" };
    }
    if (joined.startsWith("git push origin --delete")) {
      return deleteFails ? { status: 1, stderr: "remote ref does not exist" } : { status: 0, stdout: "" };
    }
    return { status: 0, stdout: "" };
  };
  return { calls, run };
}

const base = {
  repo: "SummerSec/DeepSonar", branch: "bot/sync-runtime-registry-v0.6.7",
  sha: "a".repeat(40), defaultBranch: "main",
};
const env = { GH_TOKEN: "test-token" };
const quiet = async () => {};

// 1. gh CLI authentication is part of the contract: without it the step would
//    push the branch and then die at dispatch, exactly the reviewed defect.
await assert.rejects(
  () => runWriteback({ ...base, env: {}, run: () => ({ status: 0 }), sleep: quiet }),
  (error) => error instanceof WritebackError && error.code === "WRITEBACK_INPUT_MISSING" && /GH_TOKEN/.test(error.message),
);

// 2. dispatch failure must not move the default branch and must keep the branch.
{
  const { calls, run } = harness({ dispatchFails: true });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_DISPATCH_FAILED" && /was not modified/.test(error.message));
  assert.ok(!calls.some((call) => call === "git push origin HEAD:main"), "must not push main after a failed dispatch");
  assert.ok(!calls.some((call) => call.startsWith("git push origin --delete")), "must keep the branch for inspection");
}

// 3. every blocking conclusion keeps the default branch where it was.
for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
  const { calls, run } = harness({ conclusions: [conclusion] });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_CHECK_FAILED" && error.message.includes(conclusion));
  assert.ok(!calls.some((call) => call === "git push origin HEAD:main"), `must not push main on ${conclusion}`);
  assert.ok(!calls.some((call) => call.startsWith("git push origin --delete")), `must keep the branch on ${conclusion}`);
}

// 4. timeout budget is honoured.
{
  const { calls, run } = harness({ conclusions: ["pending"] });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet, pollLimit: 3 }),
    (error) => error.code === "WRITEBACK_CHECK_TIMEOUT" && /3 polls/.test(error.message));
  assert.ok(!calls.some((call) => call === "git push origin HEAD:main"));
}

// 5. transient API errors do not abort the wait; a later success still lands.
{
  const calls = [];
  let polls = 0;
  const run = (file, args) => {
    const joined = [file, ...args].join(" ");
    calls.push(joined);
    if (joined.startsWith("gh api")) {
      polls += 1;
      if (polls === 1) return { status: 1, stderr: "unexpected EOF" };
      return { status: 0, stdout: "success\n" };
    }
    return { status: 0, stdout: "" };
  };
  const result = await runWriteback({ ...base, env, run, sleep: quiet });
  assert.equal(result.conclusion, "success");
  assert.ok(calls.includes("git push origin HEAD:main"));
  assert.ok(calls.some((call) => call.startsWith("git push origin --delete")));
}

// 6. a rejected fast-forward keeps the branch and never claims cleanup.
{
  const { calls, run } = harness({ pushDefaultFails: true });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_PUSH_CONFLICT" && /kept for inspection/.test(error.message));
  assert.ok(!calls.some((call) => call.startsWith("git push origin --delete")), "must keep the branch when main was not updated");
}

console.log("release writeback control flow: auth, dispatch, blocking conclusions, timeout, transient retry and conflicts passed");
