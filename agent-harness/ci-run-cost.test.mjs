import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectRunCost, renderRunCost, summarizeRunCost } from "./ci-run-cost.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 10, 7) + seconds * 1000).toISOString();
const step = (name, start, end, conclusion = "success") => ({ name, status: "completed", conclusion, started_at: at(start), completed_at: at(end) });
const run = (overrides = {}) => ({ id: 992, run_attempt: 1, status: "completed", conclusion: "success", head_sha: "head-not-merge-sha",
  event: "pull_request", path: ".github/workflows/ci.yml", repository: { full_name: "SummerSec/DeepSonar" },
  created_at: at(0), run_started_at: at(2), ...overrides });
const job = (id, overrides = {}) => ({ id, run_id: 992, run_attempt: 1, name: "gate-runtime", status: "completed", conclusion: "success",
  labels: ["ubuntu-24.04"], created_at: at(10), started_at: at(13), completed_at: at(50),
  steps: [step("Run pnpm install --frozen-lockfile", 14, 18), step("Run pnpm -r typecheck", 18, 23),
    step("Run pnpm -r build", 23, 30), step("Run actions/upload-artifact@v4", 40, 42)], ...overrides });

test("parallel runner cost is summed, wall time is not; dependency wait is not runner queue", () => {
  const result = summarizeRunCost({ run: run(), jobs: [job(1), job(2, { name: "gate-contract" })] });
  assert.equal(result.workflow_wall_ms, 48_000);
  assert.equal(result.runner_ms, 74_000);
  assert.equal(result.queue_ms, 6_000);
  assert.equal(result.initial_queue_ms, 2_000);
  assert.equal(result.jobs[0].pre_job_ms, 8_000);
  assert.equal(result.setup_ms, 8_000);
  assert.equal(result.typecheck_ms, 10_000);
  assert.equal(result.workspace_build_ms, 14_000);
  assert.equal(result.artifact_transfer_ms, 4_000);
  assert.equal(summarizeRunCost({ run: run(), jobs: [job(1, { steps: [step("Upload Plan offline replay report", 40, 42)] })] }).artifact_transfer_ms, 2_000);
  assert.equal(result.tested_checkout_sha, "unknown");
});

test("a planned skipped job has zero runner and setup cost, not a test-pass verdict", () => {
  const result = summarizeRunCost({ run: run(), jobs: [job(1, { conclusion: "skipped", steps: undefined })] });
  assert.equal(result.runner_ms, 0);
  assert.equal(result.setup_ms, 0);
  assert.equal(result.jobs[0].conclusion, "skipped");
  const mixed = summarizeRunCost({ run: run(), jobs: [job(1), job(2, { conclusion: "skipped", started_at: null, completed_at: null, steps: [] })] });
  assert.equal(mixed.workflow_wall_ms, 48_000, "a skipped runner has no execution endpoint to require");
});

test("missing, invalid, reversed and unfinished timestamps never become free work", () => {
  for (const overrides of [{ completed_at: null }, { started_at: "invalid" }, { started_at: at(60) }, { status: "in_progress" }]) {
    const result = summarizeRunCost({ run: run(), jobs: [job(1, overrides)] });
    assert.equal(result.runner_ms, null);
    assert.match(renderRunCost(result), /unknown/u);
  }
  const result = summarizeRunCost({ run: run(), jobs: [job(1, { steps: [step("Run pnpm -r build", 40, 30)] })] });
  assert.equal(result.workspace_build_ms, null);
  assert.equal(summarizeRunCost({ run: run(), jobs: [job(1, { steps: undefined })] }).setup_ms, null);
});

test("an in-progress summary reports partial observations without pretending the workflow passed", () => {
  const result = summarizeRunCost({ run: run({ status: "in_progress", conclusion: null }),
    jobs: [job(1), job(2, { name: "ci-summary", status: "in_progress", conclusion: null, completed_at: null })] });
  assert.equal(result.complete, false);
  assert.equal(result.workflow_wall_ms, null);
  assert.equal(result.runner_ms, null);
  assert.equal(result.observed_completed_runner_ms, 37_000);
  assert.match(renderRunCost(result), /partial/u);
});

test("retry cost counts this attempt only, never the original run's creation gap", () => {
  const result = summarizeRunCost({ run: run({ run_attempt: 2, run_started_at: at(1000) }),
    jobs: [job(2, { run_attempt: 2, created_at: at(1001), started_at: at(1002), completed_at: at(1032), steps: [] })] });
  assert.equal(result.initial_queue_ms, null);
  assert.equal(result.workflow_wall_ms, 32_000);
  assert.equal(result.runner_ms, 30_000);
  assert.throws(() => summarizeRunCost({ run: run({ run_attempt: 2 }), jobs: [job(1)] }), /another run or attempt/u);
  assert.throws(() => summarizeRunCost({ run: run(), jobs: [job(1, { run_id: 993 })] }), /another run or attempt/u);
  assert.throws(() => summarizeRunCost({ run: run(), jobs: [job(1), job(1)] }), /duplicate job/u);
  assert.throws(() => summarizeRunCost({ run: run(), jobs: [] }), /missing attempt jobs/u);
});

test("native rerun clones are zero additional work only after matching prior-attempt evidence", () => {
  const old = job(1, { runner_id: 42 });
  const retained = job(2, { run_attempt: 2, runner_id: 42, created_at: at(1001) });
  const retry = job(3, { run_attempt: 2, name: "ci-summary", created_at: at(1002), started_at: at(1003), completed_at: at(1005), steps: [] });
  const input = { run: run({ run_attempt: 2, run_started_at: at(1000) }), jobs: [retained, retry], previousJobs: [old] };
  const result = summarizeRunCost(input);
  assert.equal(result.runner_ms, 2000);
  assert.equal(result.setup_ms, 0);
  assert.equal(result.workflow_wall_ms, 5000);
  assert.equal(result.jobs[0].execution, "retained_previous_result");
  assert.equal(result.jobs[0].retained_from_job_id, 1);
  for (const overrides of [{ runner_id: 99 }, { name: "different" }, { run_id: 991 }, { run_attempt: 2 }, { conclusion: "failure" }, { steps: [] }]) {
    const unproven = summarizeRunCost({ ...input, previousJobs: [{ ...old, ...overrides }] });
    assert.equal(unproven.runner_ms, null);
    assert.equal(unproven.jobs[0].execution, "unknown");
  }
  assert.equal(summarizeRunCost({ ...input, previousJobs: [] }).runner_ms, null);
});

test("the collector reads exact attempt APIs, checks source identity and requires complete pagination", () => {
  const calls = [];
  const options = { repository: "SummerSec/DeepSonar", runId: 992, attempt: 1 };
  const api = (endpoint, paginate) => {
    calls.push([endpoint, paginate]);
    return paginate ? [{ total_count: 2, jobs: [job(1)] }, { total_count: 2, jobs: [job(2)] }] : run();
  };
  assert.equal(collectRunCost({ ...options, api }).jobs.length, 2);
  assert.deepEqual(calls, [["repos/SummerSec/DeepSonar/actions/runs/992/attempts/1", undefined],
    ["repos/SummerSec/DeepSonar/actions/runs/992/attempts/1/jobs?per_page=100", true]]);
  assert.throws(() => collectRunCost({ ...options, api: () => run({ run_attempt: 2 }) }), /source identity/u);
  assert.throws(() => collectRunCost({ ...options, api: () => run({ repository: { full_name: "other/repository" } }) }), /source identity/u);
  assert.throws(() => collectRunCost({ ...options, api: (_, pages) => pages ? [{ total_count: 2, jobs: [job(1)] }] : run() }), /pagination/u);
  for (const input of [{ runId: "../992" }, { attempt: 0 }, { repository: "https://127.0.0.1/repo" }]) {
    assert.throws(() => collectRunCost({ ...options, ...input, api: () => assert.fail("must not call API") }), /invalid/u);
  }
});

test("summary tables do not reinterpret job names as Markdown structure or a verified benchmark", () => {
  const result = summarizeRunCost({ run: run(), jobs: [job(1, { name: "bad|name\n`injected`" })] });
  assert.match(renderRunCost(result), /bad name  injected /u);
  assert.match(renderRunCost(result), /not a verified benchmark/u);
});

test("core and Reverse summaries expose attempt costs without weakening result checks", () => {
  for (const [file, jobName] of [["ci.yml", "ci-summary"], ["reverse-runtime.yml", "reverse-runtime-acceptance"]]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const block = workflow.split(`  ${jobName}:`)[1];
    assert.match(block, /actions: read/u);
    assert.match(block, /node agent-harness\/ci-run-cost\.mjs/u);
    assert.match(block, /--attempt "\$GITHUB_RUN_ATTEMPT"/u);
    assert.match(block, /if: always\(\)/u);
    assert.doesNotMatch(block, /continue-on-error:|actions: write|pull_request_target/u);
  }
});
