import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  collectRun as collectRawRun, collectAll, importHistory, inferScenario, deriveOutcome, isPlannedSkip,
  IMAGE_KEY, PLATFORM, BUILD_STEP_PATTERNS,
} from "./collect-runtime-timing.mjs";
import { SCHEMA, summarise, aggregate, collectorProvenance, trustedCollector } from "./runtime-build-timing.mjs";

const HEAD_SHA = "a".repeat(40), COLLECTOR_SHA = "b".repeat(40), TESTED_SHA = "c".repeat(40);
const policy = { repository: "SummerSec/DeepSonar", default_branch: "main", workflow_id: 700, current_run_id: 9001 };
const collector = { id: 9001, run_attempt: 1, head_sha: COLLECTOR_SHA, head_branch: "main", event: "workflow_run",
  path: ".github/workflows/runtime-build-timing.yml", workflow_id: 700, conclusion: "success", revision_is_ancestor: true,
  repository: { full_name: policy.repository }, head_repository: { full_name: policy.repository } };
const trust = { policy, collectors: [collector] };
const collectRun = (input, opts = {}) => collectRawRun(input, { collector, policy, ...opts });

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "agent-harness", "collect-runtime-timing.mjs");
const T0_MS = Date.parse("2026-11-07T03:00:00.000Z");
const T = (sec) => new Date(T0_MS + sec * 1000).toISOString();
const BUILD_STEP_NAME = "Build Chrome Fuzz arm64 by digest";
const SMOKE_STEP_NAME = "原生执行 Chrome Fuzz 不可变 digest 冒烟";

function payload(overrides = {}) {
  const run = {
    id: 1001, name: "ci", head_sha: HEAD_SHA, head_branch: "main", event: "push", run_attempt: 1,
    run_started_at: T(0), conclusion: "success",
    html_url: "https://github.com/SummerSec/DeepSonar/actions/runs/1001",
    ...(overrides.run || {}),
  };
  const buildJob = {
    name: "chrome-fuzz-arm64-build", conclusion: "success",
    started_at: T(5), completed_at: T(50),
    steps: [{ name: BUILD_STEP_NAME, conclusion: "success", started_at: T(10), completed_at: T(40) }],
    ...(overrides.buildJob || {}),
  };
  const smokeJob = {
    name: "chrome-fuzz-arm64", conclusion: "success",
    started_at: T(52), completed_at: T(70),
    steps: [{ name: SMOKE_STEP_NAME, conclusion: "success", started_at: T(55), completed_at: T(68) }],
    ...(overrides.smokeJob || {}),
  };
  return { run, jobs: overrides.jobs ?? [buildJob, smokeJob] };
}

test("a complete ci run preserves timings but unknown checkout/context prevents benchmark claims", () => {
  const result = collectRun(payload());
  assert.ok(result, "an ARM run with both jobs is a sample");
  const { state, report } = result;
  assert.equal(state.schema, SCHEMA);
  assert.equal(state.runId, "gha-1001-attempt-1");
  assert.equal(state.image, IMAGE_KEY);
  assert.equal(state.platform, PLATFORM);
  assert.equal(state.outcome, "success");
  assert.equal(state.meta.failure_class, "none");
  assert.equal(state.meta.head_sha, HEAD_SHA);
  assert.equal(state.meta.tested_checkout_sha, "unknown");
  assert.equal(state.source.source_sha, HEAD_SHA);
  assert.equal(state.provenance.collector_sha, COLLECTOR_SHA, "collector revision is not the observed source commit");
  assert.equal(state.meta.src_reuse, "rebuilt");
  // BuildKit splitting is P2; fingerprint / digest are step outputs, not API.
  assert.equal(state.meta.fingerprint, "unknown");
  assert.equal(state.meta.buildkit_cache, "unknown");
  assert.equal(report.source.collection, "github-actions-step-timestamps");
  assert.equal(report.source.build_step, BUILD_STEP_NAME);
  assert.equal(report.source.smoke_step, SMOKE_STEP_NAME);

  const s = summarise(state);
  assert.equal(s.total_ms, 43000, "build 30000 + native_smoke 13000");
  assert.equal(s.queue_ms, 5000, "waiting for `changes` is reported separately");
  assert.equal(s.handoff_ms, 2000, "build job -> native smoke job gap is explicit, not silently lost");
  assert.equal(s.excluded_ms, 7000);
  assert.deepEqual(s.counted_stages, ["build", "native_smoke"]);
  assert.deepEqual(s.missing_stages, []);
  assert.equal(s.buildGranularity, "unsplit");
  assert.equal(s.smokeGranularity, "combined");
  assert.equal(s.comparable, false);
  assert.ok(s.unknownContext.includes("tested_checkout_sha"));
  assert.equal(report.summary.comparable, false);
});

test("pull and smoke are one Actions step, so they are never split or double counted", () => {
  const { state } = collectRun(payload());
  assert.equal(state.stages.pull, undefined);
  assert.equal(state.stages.smoke, undefined);
  assert.equal(state.stages.native_smoke.duration_ms, 13000);
  assert.equal(BUILD_STEP_PATTERNS[0].test(BUILD_STEP_NAME), true);
});

test("src cache reuse is an observed zero-duration skip, not a missing stage", () => {
  const p = payload({
    buildJob: {
      steps: [{ name: BUILD_STEP_NAME, conclusion: "skipped" }],
    },
  });
  const { state } = collectRun(p);
  assert.equal(state.scenario, "warm");
  assert.equal(state.meta.src_reuse, "reused");
  assert.deepEqual(state.stages.build, {
    start: null, end: null, duration_ms: 0, outcome: "skipped",
    observed: true, reason: "src cache reused; build-push-action skipped",
  });
  const s = summarise(state);
  assert.equal(s.total_ms, 13000, "0ms build is observed, not fabricated");
  assert.deepEqual(s.missing_stages, []);
  assert.equal(s.comparable, false, "warm timing remains descriptive when checkout and build context are unknown");
});

test("a failed native smoke is never rescued by a successful build or cache hit", () => {
  const p = payload({
    smokeJob: {
      conclusion: "failure",
      steps: [{ name: SMOKE_STEP_NAME, conclusion: "failure", started_at: T(55), completed_at: T(60) }],
    },
  });
  const { state } = collectRun(p);
  assert.equal(state.outcome, "failure");
  assert.equal(state.meta.failure_class, "unknown", "unclassified failure stays excluded");
  assert.equal(state.stages.native_smoke.outcome, "failure");
  assert.equal(summarise(state).comparable, false);
  const dir = mkdtempSync(join(tmpdir(), "timing-failure-"));
  writeFileSync(join(dir, `${state.runId}.json`), JSON.stringify(state));
  assert.equal(aggregate(dir, 3, trust).excluded.failed, 1);
});

test("planned skips and runs without ARM jobs are not samples", () => {
  assert.equal(collectRun(payload({ jobs: [] })), null);
  assert.equal(collectRun(payload({
    jobs: [
      { name: "chrome-fuzz-arm64-build", conclusion: "skipped", steps: [] },
      { name: "chrome-fuzz-arm64", conclusion: "skipped", steps: [] },
    ],
  })), null);
  assert.equal(isPlannedSkip({}, null, null), true);
  assert.equal(isPlannedSkip({}, { conclusion: "success" }, { conclusion: "success" }), false);
});

test("missing step timestamps stay missing and never count as zero", () => {
  const p = payload({
    buildJob: { steps: [{ name: BUILD_STEP_NAME, conclusion: "success" }] },
  });
  const { state } = collectRun(p);
  assert.equal(state.stages.build, undefined);
  const s = summarise(state);
  assert.deepEqual(s.missing_stages, ["build"]);
  assert.equal(s.total_ms, 13000, "only the measured smoke contributes");
  assert.equal(s.comparable, false);
});

test("cold vs invalidated cannot be inferred from timestamps; explicit labels are checked", () => {
  assert.equal(inferScenario({ buildStep: { conclusion: "success" } }), "unknown");
  assert.equal(inferScenario({ buildStep: { conclusion: "skipped" } }), "warm");
  assert.equal(inferScenario({}), "unknown");
  const { state } = collectRun(payload(), { scenario: "cold" });
  assert.equal(state.scenario, "cold");
  assert.throws(() => collectRun(payload(), { scenario: "fast" }), /invalid scenario/);
  assert.throws(() => collectRun(payload(), { failureClass: "network" }), /invalid failure_class/);
});

test("cancellation, timeouts and a missing smoke job fail closed", () => {
  assert.equal(deriveOutcome({ conclusion: "cancelled" }, { conclusion: "success" }, { conclusion: "success" }), "cancelled");
  assert.equal(deriveOutcome({ conclusion: "success" }, { conclusion: "success" }, null), "failure");
  assert.equal(deriveOutcome({ conclusion: "success" }, { conclusion: "success" }, { conclusion: "skipped" }), "failure");
  assert.equal(deriveOutcome({ conclusion: "success" }, { conclusion: "success" }, { conclusion: "success" }), "success");
  // Timing is scoped to the ARM chain: an unrelated job failing in the same
  // CI run must not discard a complete build + native-smoke observation.
  assert.equal(deriveOutcome({ conclusion: "failure" }, { conclusion: "success" }, { conclusion: "success" }), "success");
  const { report } = collectRun(payload({ run: { conclusion: "failure" } }));
  assert.equal(report.source.run_conclusion, "failure");
  assert.equal(report.summary.comparable, false, "successful ARM steps do not invent missing provenance/context");
  assert.equal(deriveOutcome({ conclusion: "cancelled" }, { conclusion: "success" }, { conclusion: "success" }), "cancelled");
});

test("one malformed payload does not discard the rest of the batch", () => {
  const batch = collectAll([payload(), { run: { name: "ci" }, jobs: [] }, payload({ run: { id: 1002 } })]);
  assert.equal(batch.collected.length, 2, "a payload without run.id must not discard its neighbours");
  assert.equal(batch.skipped.length, 1);
  assert.match(batch.skipped[0].reason, /run.id is required/);
  assert.deepEqual(batch.collected.map((c) => c.runId), ["gha-1001-attempt-1", "gha-1002-attempt-1"]);
});

test("aggregate ignores its own result file and corrupt JSON in the evidence directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-aggregate-"));
  const { state } = collectRun(payload());
  writeFileSync(join(dir, `${state.runId}.json`), JSON.stringify(state));
  writeFileSync(join(dir, "aggregate.json"), JSON.stringify({ schema: SCHEMA, minSamples: 3 }));
  writeFileSync(join(dir, "broken.json"), "{not json");
  writeFileSync(join(dir, `${state.runId}.report.json`), JSON.stringify({ schema: SCHEMA }));
  const result = aggregate(dir, 3, trust);
  assert.equal(result.totalRuns, 1);
  assert.equal(result.excluded.unknown_context, 1);
  assert.equal(result.scenarios.unknown.count, 0);
  assert.equal(result.scenarios.unknown.p95_ms, null, "one sample cannot produce a P95");
  assert.equal(result.scenarios.unknown.sufficient, false);
});

test("real CLI: batch input writes state + report, summary and a thin-sample aggregate", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-cli-"));
  const input = join(dir, "input.json");
  const outDir = join(dir, "evidence");
  const summary = join(dir, "summary.md");
  const jsonOut = join(dir, "aggregate.json");
  const trustFile = join(dir, "trust.json");
  writeFileSync(trustFile, JSON.stringify(trust));
  const batch = [
    payload({ run: { id: 2001 } }),
    payload({ run: { id: 2002 }, buildJob: { steps: [{ name: BUILD_STEP_NAME, conclusion: "skipped" }] } }),
    payload({ jobs: [] }),
  ];
  writeFileSync(input, JSON.stringify(batch));
  const stdout = execFileSync(process.execPath, [
    SCRIPT,
    "--input", input, "--out-dir", outDir, "--aggregate",
    "--summary", summary, "--json-out", jsonOut, "--trust", trustFile,
  ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
  const parsed = JSON.parse(stdout.trim().split("\n").pop());
  assert.equal(parsed.collected.length, 2);
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.aggregate.scenarios.cold, undefined);
  assert.equal(parsed.aggregate.scenarios.unknown.count, 0);
  assert.equal(parsed.aggregate.scenarios.warm.count, 0);
  assert.equal(parsed.aggregate.excluded.unknown_context, 2);
  assert.equal(parsed.aggregate.scenarios.warm.p95_ms, null);

  for (const id of ["gha-2001-attempt-1", "gha-2002-attempt-1"]) {
    assert.equal(existsSync(join(outDir, `${id}.json`)), true);
    assert.equal(existsSync(join(outDir, `${id}.report.json`)), true);
  }
  const md = readFileSync(summary, "utf8");
  assert.match(md, /#961 P0 运行镜像构建证据采集/);
  assert.match(md, /native_smoke/);
  assert.match(md, /样本不足（需 3）/);
  assert.equal(JSON.parse(readFileSync(jsonOut, "utf8")).totalRuns, 2);
});

test("CLI fails closed on missing input without creating an evidence directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-cli-bad-"));
  const outDir = join(dir, "evidence");
  let failed = false;
  try {
    execFileSync(process.execPath, [
      SCRIPT,
      "--input", join(dir, "nope.json"), "--out-dir", outDir,
    ], { cwd: ROOT, encoding: "utf8", stdio: "pipe", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
  } catch (error) {
    failed = true;
    assert.match(String(error.stderr), /no input file/);
  }
  assert.equal(failed, true);
  assert.equal(existsSync(outDir), false);
});

test("collector trust requires API event, branch, repository, workflow and verified revision", () => {
  assert.equal(trustedCollector(collector, policy), true);
  for (const patch of [
    { event: "pull_request" }, { head_branch: "feature/timing" },
    { repository: { full_name: "fork/DeepSonar" } }, { head_repository: { full_name: "fork/DeepSonar" } },
    { path: ".github/workflows/another.yml" }, { workflow_id: 701 },
    { head_sha: "unknown" }, { revision_is_ancestor: false },
  ]) assert.equal(trustedCollector({ ...collector, ...patch }, policy), false, JSON.stringify(patch));
});

test("a successful PR artifact cannot enter history even when it forges a trusted collector's JSON", () => {
  const input = mkdtempSync(join(tmpdir(), "timing-pr-artifact-"));
  const output = join(input, "accepted");
  const sample = collectRun(payload()).state;
  assert.equal(sample.stages.native_smoke.outcome, "success");
  writeFileSync(join(input, "forged.json"), JSON.stringify(sample));
  const prCollector = { ...collector, id: 9002, event: "pull_request", conclusion: "success" };
  const result = importHistory(input, output, { policy, collectors: [collector, prCollector] }, prCollector.id);
  assert.equal(result.imported, 0);
  assert.match(result.reason, /untrusted artifact producer/);
  assert.equal(existsSync(output), false);
});

test("trusted history is retained without re-signing; legacy and mismatched collector revisions are excluded", () => {
  const input = mkdtempSync(join(tmpdir(), "timing-trusted-artifact-"));
  const output = join(input, "accepted");
  const sample = collectRun(payload()).state;
  writeFileSync(join(input, "valid.json"), JSON.stringify(sample));
  writeFileSync(join(input, "legacy.json"), JSON.stringify({ ...sample, schema: "deepsonar.runtime-build-timing.v1", provenance: undefined }));
  writeFileSync(join(input, "wrong-revision.json"), JSON.stringify({ ...sample,
    provenance: { ...sample.provenance, collector_revision: "1" } }));
  const result = importHistory(input, output, trust, collector.id);
  assert.deepEqual(result, { imported: 1, excluded: 2 });
  assert.deepEqual(JSON.parse(readFileSync(join(output, `${sample.runId}.json`), "utf8")), sample);
  const observed = aggregate(output, 3, trust);
  assert.equal(observed.totalRuns, 1);
  assert.equal(observed.excluded.untrusted, 0);
  assert.equal(observed.excluded.unknown_context, 1, "trusted origin does not make missing checkout evidence known");
  assert.equal(observed.scenarios.unknown.p95_ms, null);
});

test("rerun attempts preserve distinct observations instead of overwriting the earlier attempt", () => {
  const first = collectRun(payload()).state;
  const second = collectRun(payload({ run: { run_attempt: 2 } })).state;
  assert.notEqual(first.runId, second.runId);
  assert.equal(first.source.run_attempt, 1);
  assert.equal(second.source.run_attempt, 2);
});

test("observed PR head is never promoted to tested checkout SHA, including payload-supplied claims", () => {
  const { state, report } = collectRun(payload({ run: { event: "pull_request", head_sha: HEAD_SHA,
    tested_checkout_sha: TESTED_SHA, test_sha: TESTED_SHA,
    provenance: collectorProvenance(collector, policy) } }));
  assert.notEqual(HEAD_SHA, TESTED_SHA, "fixture models a distinct tested merge commit");
  assert.equal(state.meta.head_sha, HEAD_SHA);
  assert.equal(state.meta.tested_checkout_sha, "unknown");
  assert.equal(report.source.source_sha, HEAD_SHA);
  assert.equal(report.source.tested_checkout_sha, "unknown");
  assert.equal(report.source.event, "pull_request");
  assert.equal(report.summary.comparable, false);
});

test("workflow PR path runs only regression; collection pins the trusted default-branch workflow revision", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/runtime-build-timing.yml"), "utf8");
  const script = readFileSync(join(ROOT, ".github/ci/runtime-timing-collect.sh"), "utf8");
  assert.match(workflow, /regression:[\s\S]*node --test/);
  assert.match(workflow, /collect:[\s\S]*needs: regression[\s\S]*github\.event_name != 'pull_request'/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(script, /git merge-base --is-ancestor/);
  assert.match(script, /--validate-collector/);
  assert.match(script, /--import-history[\s\S]*--producer-run-id/);
  assert.doesNotMatch(script, /refs\/pull\/|cp -n/);
});
