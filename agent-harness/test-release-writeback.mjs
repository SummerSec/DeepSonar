import assert from "node:assert/strict";
import { runWriteback, WritebackError } from "./release-writeback.mjs";

// The release writeback decides whether the default branch moves. It must be
// covered without git, gh or network: every command is injected and recorded.

function harness({
  dispatchFails = false,
  conclusions = ["success"],
  prNumber = "42",
  existingPr = "",
  mergeStates = ["CLEAN"],
  mergeFails = false,
  compareStatusAfterMerge = "ahead",
  createFails = false,
  deleteFails = false,
  prPermissionAllowed = true,
  prPermissionUnreadable = false,
  awaitingApproval = false,
} = {}) {
  const calls = [];
  let pollIndex = 0;
  let mergeIndex = 0;
  const run = (file, args) => {
    const joined = [file, ...args].join(" ");
    calls.push(joined);
    if (joined.startsWith("git push")) return { status: 0, stdout: "" };
    if (joined.startsWith("gh api") && joined.includes("/actions/permissions/workflow")) {
      if (prPermissionUnreadable) return { status: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" };
      return prPermissionAllowed
        ? { status: 0, stdout: `${JSON.stringify({ default_workflow_permissions: "read", can_approve_pull_request_reviews: true })}\n` }
        : { status: 0, stdout: `${JSON.stringify({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false })}\n` };
    }
    if (joined.startsWith("gh workflow run")) {
      return dispatchFails ? { status: 1, stderr: "HTTP 403: Resource not accessible" } : { status: 0, stdout: "" };
    }
    if (joined.startsWith("gh api") && joined.includes("/actions/runs?head_sha=")) {
      return awaitingApproval
        ? { status: 0, stdout: '{"id":4242,"name":"ci","status":"waiting"}\n' }
        : { status: 0, stdout: "\n" };
    }
    if (joined.startsWith("gh pr view") && joined.includes("statusCheckRollup")) {
      const conclusion = conclusions[Math.min(pollIndex, conclusions.length - 1)];
      pollIndex += 1;
      return { status: 0, stdout: `${conclusion}\n` };
    }

    if (joined.startsWith("gh pr list")) return { status: 0, stdout: `${existingPr}\n` };
    if (joined.startsWith("gh pr create")) {
      return createFails
        ? { status: 1, stderr: "GraphQL: could not create pull request" }
        : { status: 0, stdout: `https://github.com/SummerSec/DeepSonar/pull/${prNumber}\n` };
    }
    if (joined.startsWith("gh pr view")) {
      const state = mergeStates[Math.min(mergeIndex, mergeStates.length - 1)];
      mergeIndex += 1;
      return { status: 0, stdout: `${JSON.stringify({ mergeStateStatus: state, state: "OPEN" })}\n` };
    }
    if (joined.startsWith("gh pr merge")) {
      return mergeFails ? { status: 1, stderr: "GraphQL: Pull Request is not mergeable" } : { status: 0, stdout: "" };
    }
    if (joined.includes("/commits/main")) return { status: 0, stdout: `${"b".repeat(40)}\n` };
    if (joined.includes("/compare/")) return { status: 0, stdout: `${compareStatusAfterMerge}\n` };
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
const neverMutatesMain = (calls) => {
  assert.ok(!calls.some((call) => call === "git push origin HEAD:main"), "must never push the default branch directly");
  assert.ok(!calls.some((call) => call.startsWith("gh pr merge")), "must not merge when a precondition failed");
  assert.ok(!calls.some((call) => call.startsWith("git push origin --delete")), "must keep the branch for inspection");
};

// 1. gh CLI authentication is part of the contract: without it the step would
//    push the branch and then die at dispatch, exactly the reviewed defect.
await assert.rejects(
  () => runWriteback({ ...base, env: {}, run: () => ({ status: 0 }), sleep: quiet }),
  (error) => error instanceof WritebackError && error.code === "WRITEBACK_INPUT_MISSING" && /GH_TOKEN/.test(error.message),
);

// 2. the writeback opens the pull request first, so ci.yml is triggered by the normal
//    pull_request event (a dispatched run never satisfies the PR's required check).
{
  const { calls, run } = harness();
  await runWriteback({ ...base, env, run, sleep: quiet });
  const createIndex = calls.findIndex((call) => call.startsWith("gh pr create"));
  assert.ok(createIndex >= 0, "a pull request is opened");
  const creation = calls[createIndex];
  assert.ok(creation.includes("使用 SummerSec 账号"), "the generated body discloses the automation identity");
  assert.ok(creation.includes("等待本 PR 的 `ci-summary`"), "new PRs report that checks are pending");
  assert.ok(!creation.includes("已在该提交上通过"), "PR creation must not claim checks already passed");
  assert.ok(!calls.some((call) => call.startsWith("gh workflow run")),
    "no workflow_dispatch: its check-runs are not part of the PR rollup");
  const rollupIndex = calls.findIndex((call) => call.includes("statusCheckRollup"));
  assert.ok(rollupIndex > createIndex, "the required check is read from the pull request after it opens");
}

// 3. every blocking conclusion keeps the default branch where it was.
for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
  const { calls, run } = harness({ conclusions: [conclusion] });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_CHECK_FAILED" && error.message.includes(conclusion));
  neverMutatesMain(calls);
}

// 4. timeout budget is honoured.
{
  const { calls, run } = harness({ conclusions: ["pending"] });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet, pollLimit: 3 }),
    (error) => error.code === "WRITEBACK_CHECK_TIMEOUT" && /3 polls/.test(error.message));
  neverMutatesMain(calls);
}

// 5. transient API errors do not abort the wait; a later success still lands.
{
  const calls = [];
  let polls = 0;
  const run = (file, args) => {
    const joined = [file, ...args].join(" ");
    calls.push(joined);
    if (joined.startsWith("gh api") && joined.includes("/actions/permissions/workflow")) {
      return { status: 0, stdout: '{"can_approve_pull_request_reviews":true}\n' };
    }
    if (joined.startsWith("gh api") && joined.includes("/actions/runs?head_sha=")) return { status: 0, stdout: "\n" };
    if (joined.startsWith("gh api") && joined.includes("/actions/runs?head_sha=")) {
      return awaitingApproval
        ? { status: 0, stdout: '{"id":4242,"name":"ci","status":"waiting"}\n' }
        : { status: 0, stdout: "\n" };
    }
    if (joined.startsWith("gh api") && joined.includes("/actions/runs?head_sha=")) return { status: 0, stdout: "\n" };
    if (joined.startsWith("gh pr view") && joined.includes("statusCheckRollup")) {
      polls += 1;
      return polls === 1 ? { status: 1, stderr: "unexpected EOF" } : { status: 0, stdout: "success\n" };
    }
    if (joined.startsWith("gh pr list")) return { status: 0, stdout: "\n" };
    if (joined.startsWith("gh pr create")) return { status: 0, stdout: "https://github.com/o/r/pull/7\n" };
    if (joined.startsWith("gh pr view")) return { status: 0, stdout: `${JSON.stringify({ mergeStateStatus: "CLEAN", state: "OPEN" })}\n` };
    if (joined.includes("/compare/")) return { status: 0, stdout: "ahead\n" };
    if (joined.includes("/commits/main")) return { status: 0, stdout: `${"b".repeat(40)}\n` };
    return { status: 0, stdout: "" };
  };
  const result = await runWriteback({ ...base, env, run, sleep: quiet });
  assert.equal(result.conclusion, "success");
  assert.equal(result.via, "pr_merge");
  assert.ok(calls.some((call) => call.startsWith("gh pr merge 7")), "the writeback lands through a pull request");
  assert.ok(!calls.some((call) => call === "git push origin HEAD:main"), "never pushes the default branch");
  assert.ok(calls.some((call) => call.startsWith("git push origin --delete")), "cleans the branch after landing");
}

// 6. #877: a rejected direct push is no longer the mechanism, and the reason is
//    kept in the message when a merge cannot proceed.
{
  const { calls, run } = harness({ mergeStates: ["DIRTY"] });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_PR_MERGED_FAILED" && /DIRTY/.test(error.message) && /kept for inspection/.test(error.message));
  neverMutatesMain(calls);
}

// 7. UNKNOWN/BLOCKED right after opening are transient: keep polling, then merge.
{
  const { calls, run } = harness({ mergeStates: ["UNKNOWN", "BLOCKED", "CLEAN"] });
  const result = await runWriteback({ ...base, env, run, sleep: quiet });
  assert.equal(result.via, "pr_merge");
  assert.ok(calls.filter((call) => call.startsWith("gh pr view")).length >= 3);
}

// 8. merge failure surfaces the remote reason instead of a bare exit code.
{
  const { calls, run } = harness({ mergeFails: true });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_COMMAND_FAILED" && /not mergeable/i.test(error.message));
  // The merge was attempted (that is the case under test); what must not happen is a
  // direct push to the default branch or a cleanup that hides the failure.
  assert.ok(!calls.some((call) => call === "git push origin HEAD:main"), "must never push the default branch directly");
  assert.ok(!calls.some((call) => call.startsWith("git push origin --delete")), "must keep the branch for inspection");
}

// 9. a merge that did not actually land the commit fails closed.
{
  const { calls, run } = harness({ compareStatusAfterMerge: "diverged" });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_NOT_LANDED" && /does not contain/.test(error.message));
  assert.ok(!calls.some((call) => call.startsWith("git push origin --delete")), "keeps the branch when the commit did not land");
}

// 10. an existing open PR is reused instead of opening a duplicate.
{
  const { calls, run } = harness({ existingPr: "11" });
  const result = await runWriteback({ ...base, env, run, sleep: quiet });
  assert.equal(result.pullRequest, "11");
  assert.ok(!calls.some((call) => call.startsWith("gh pr create")), "must not open a second pull request");
  assert.ok(calls.some((call) => call.startsWith("gh pr merge 11")));
}

// 11. PR creation failure keeps the default branch untouched.
{
  const { calls, run } = harness({ createFails: true });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_COMMAND_FAILED" && /pull request/i.test(error.message));
  neverMutatesMain(calls);
}

// 12. a repository that forbids Actions from creating pull requests fails in seconds
//     with one actionable message instead of after the PR could not be opened.
{
  let gateDispatched = false;
  const run = (file, args) => {
    const joined = [file, ...args].join(" ");
    if (joined.includes("/actions/permissions/workflow")) return { status: 0, stdout: '{"can_approve_pull_request_reviews":false}\n' };
    if (joined.startsWith("gh workflow run")) gateDispatched = true;
    return { status: 0, stdout: "" };
  };
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_PR_PERMISSION_MISSING"
      && /Allow GitHub Actions to create and approve pull requests/u.test(error.message));
  assert.equal(gateDispatched, false, "the preflight must run before any gate work starts");
}

// 12b. an unreadable permission endpoint is inconclusive: a workflow token cannot read
//      it, and blocking on that would fail every release (v0.6.9).
{
  const { calls, run } = harness({ prPermissionUnreadable: true });
  const result = await runWriteback({ ...base, env, run, sleep: quiet });
  assert.equal(result.via, "pr_merge", "the writeback still lands when the preflight cannot be read");
  assert.ok(calls.some((call) => call.startsWith("gh pr create")), "the pull request is still opened");
}

// 12c. a run held for approval fails fast with the action a maintainer must take,
//      instead of burning the whole poll budget (v0.6.10 waited ~90 minutes).
{
  const s0 = Date.now();
  await assert.rejects(
    () => runWriteback({ ...base, env, run: harness({ awaitingApproval: true, conclusions: ["pending"] }).run, sleep: quiet, pollLimit: 5 }),
    (error) => error.code === "WRITEBACK_RUN_AWAITING_APPROVAL"
      && /approve it in the Actions UI/u.test(error.message)
      && /re-run this release job/u.test(error.message),
  );
  assert.ok(Date.now() - s0 < 5_000, "the failure is immediate, not a timeout");
}

// 13. the bot branch is workflow-owned: a leftover branch from an earlier attempt is
//     overwritten with a lease instead of stranding the release on a non-fast-forward.
{
  const { calls, run } = harness();
  await runWriteback({ ...base, env, run, sleep: quiet });
  assert.ok(calls.some((call) => call.startsWith("git push --force-with-lease origin HEAD:refs/heads/bot/")),
    "the bot branch is force-pushed with a lease");
}

// 14. a local git rejection still keeps the remote reason (ruleset lines).
{
  const calls = [];
  const run = (file, args) => {
    const joined = [file, ...args].join(" ");
    calls.push(joined);
    if (joined.includes("/actions/permissions/workflow")) return { status: 0, stdout: '{"can_approve_pull_request_reviews":true}\n' };
    if (joined.startsWith("git push")) {
      return { status: 1, stderr: [
        "To https://github.com/o/r",
        "remote: error: GH013: Repository rule violations found for refs/heads/main.",
        "remote: - Required status check \"ci-summary\" is expected.",
        "! [remote rejected] HEAD -> main (push declined due to repository rule violations)",
      ].join("\n") };
    }
    return { status: 0, stdout: "" };
  };
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_COMMAND_FAILED" && /GH013/.test(error.message) && /ci-summary/.test(error.message));
}

// 15. gh renders `statusCheckRollup` conclusions as GraphQL enum literals in upper case.
//     v0.6.17 PR #1028 was green and mergeable, yet the writeback read "SUCCESS", matched
//     neither branch below, and failed only after the 90-poll budget as a timeout.
{
  const { calls, run } = harness({ conclusions: ["SUCCESS"] });
  const result = await runWriteback({ ...base, env, run, sleep: quiet });
  assert.equal(result.conclusion, "success", "an upper-case SUCCESS still breaks the wait loop");
  assert.equal(result.via, "pr_merge", "the writeback lands instead of timing out");
  assert.ok(calls.filter((call) => call.includes("statusCheckRollup")).length === 1,
    "a ready check is read once, not polled to the budget");
}

// 15b. upper-case blocking conclusions must stay blocking, not fall through to a timeout.
for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "SKIPPED"]) {
  const { calls, run } = harness({ conclusions: [conclusion] });
  await assert.rejects(() => runWriteback({ ...base, env, run, sleep: quiet }),
    (error) => error.code === "WRITEBACK_CHECK_FAILED" && error.message.includes(conclusion.toLowerCase()));
  neverMutatesMain(calls);
}

console.log("release writeback: permission preflight, auth, dispatch, blocking conclusions, GraphQL enum case, timeout, transient retry, PR merge, branch lease, conflicts and landing verification passed");
