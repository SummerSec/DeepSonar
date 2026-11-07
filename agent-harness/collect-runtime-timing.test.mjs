import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  collectRun, collectAll, inferScenario, deriveOutcome, isPlannedSkip,
  IMAGE_KEY, PLATFORM, BUILD_STEP_PATTERNS,
} from "./collect-runtime-timing.mjs";
import { SCHEMA, summarise, aggregate } from "./runtime-build-timing.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "agent-harness", "collect-runtime-timing.mjs");
const T0_MS = Date.parse("2026-11-07T03:00:00.000Z");
const T = (sec) => new Date(T0_MS + sec * 1000).toISOString();
const BUILD_STEP_NAME = "Build Chrome Fuzz arm64 by digest";
const SMOKE_STEP_NAME = "原生执行 Chrome Fuzz 不可变 digest 冒烟";

function payload(overrides = {}) {
  const run = {
    id: 1001, name: "ci", head_sha: "abc123", head_branch: "main",
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

test("a complete ci run becomes one comparable end-to-end sample", () => {
  const result = collectRun(payload());
  assert.ok(result, "an ARM run with both jobs is a sample");
  const { state, report } = result;
  assert.equal(state.schema, SCHEMA);
  assert.equal(state.runId, "gha-1001");
  assert.equal(state.image, IMAGE_KEY);
  assert.equal(state.platform, PLATFORM);
  assert.equal(state.outcome, "success");
  assert.equal(state.meta.failure_class, "none");
  assert.equal(state.meta.head_sha, "abc123");
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
  assert.equal(s.comparable, true);
  assert.equal(report.summary.comparable, true);
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
  assert.equal(s.comparable, true, "warm samples must be able to accumulate");
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
  assert.equal(aggregate(dir).excluded.failed, 1);
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
  assert.equal(report.summary.comparable, true);
  assert.equal(deriveOutcome({ conclusion: "cancelled" }, { conclusion: "success" }, { conclusion: "success" }), "cancelled");
});

test("one malformed payload does not discard the rest of the batch", () => {
  const batch = collectAll([payload(), { run: { name: "ci" }, jobs: [] }, payload({ run: { id: 1002 } })]);
  assert.equal(batch.collected.length, 2, "a payload without run.id must not discard its neighbours");
  assert.equal(batch.skipped.length, 1);
  assert.match(batch.skipped[0].reason, /run.id is required/);
  assert.deepEqual(batch.collected.map((c) => c.runId), ["gha-1001", "gha-1002"]);
});

test("aggregate ignores its own result file and corrupt JSON in the evidence directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-aggregate-"));
  const { state } = collectRun(payload());
  writeFileSync(join(dir, `${state.runId}.json`), JSON.stringify(state));
  writeFileSync(join(dir, "aggregate.json"), JSON.stringify({ schema: SCHEMA, minSamples: 3 }));
  writeFileSync(join(dir, "broken.json"), "{not json");
  writeFileSync(join(dir, `${state.runId}.report.json`), JSON.stringify({ schema: SCHEMA }));
  const result = aggregate(dir);
  assert.equal(result.totalRuns, 1);
  assert.equal(result.scenarios.unknown.count, 1);
  assert.equal(result.scenarios.unknown.p95_ms, null, "one sample cannot produce a P95");
  assert.equal(result.scenarios.unknown.sufficient, false);
});

test("real CLI: batch input writes state + report, summary and a thin-sample aggregate", () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-cli-"));
  const input = join(dir, "input.json");
  const outDir = join(dir, "evidence");
  const summary = join(dir, "summary.md");
  const jsonOut = join(dir, "aggregate.json");
  const batch = [
    payload({ run: { id: 2001 } }),
    payload({ run: { id: 2002 }, buildJob: { steps: [{ name: BUILD_STEP_NAME, conclusion: "skipped" }] } }),
    payload({ jobs: [] }),
  ];
  writeFileSync(input, JSON.stringify(batch));
  const stdout = execFileSync(process.execPath, [
    SCRIPT,
    "--input", input, "--out-dir", outDir, "--aggregate",
    "--summary", summary, "--json-out", jsonOut,
  ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
  const parsed = JSON.parse(stdout.trim().split("\n").pop());
  assert.equal(parsed.collected.length, 2);
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.aggregate.scenarios.cold, undefined);
  assert.equal(parsed.aggregate.scenarios.unknown.count, 1);
  assert.equal(parsed.aggregate.scenarios.warm.count, 1);
  assert.equal(parsed.aggregate.scenarios.warm.p95_ms, null);

  for (const id of ["gha-2001", "gha-2002"]) {
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
