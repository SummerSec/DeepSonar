// #961 P0: the timing evidence must stay comparable. A missing stage may never
// become a zero, an insufficient sample set may never produce a P95, and a
// failed/cancelled run may never be counted as a successful warm build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_MIN_SAMPLES,
  aggregate,
  finalise,
  markdownAggregate,
  markdownRun,
  median,
  newRun,
  percentile,
  setScenario,
  setMeta,
  skipStage,
  startStage,
  stopStage,
  summarise,
} from "./runtime-build-timing.mjs";

const CLI = fileURLToPath(new URL("./runtime-build-timing.mjs", import.meta.url));
const T0 = "2026-11-07T00:00:00.000Z";
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "deepsonar-timing-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function cli(dir, ...args) {
  return spawnSync(process.execPath, [CLI, "--dir", dir, ...args], { encoding: "utf8" });
}
function ok(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}
function baseRun(overrides = {}) {
  return {
    ...newRun({ runId: "r1", image: "deepsonar-chrome-fuzz", platform: "linux/arm64", scenario: "cold", now: T0 }),
    ...overrides,
  };
}
function completeRun({ scenario = "cold", outcome = "success", failureClass = "none", offset = 0 } = {}) {
  let run = baseRun({ runId: `run-${scenario}-${offset}`, scenario });
  setMeta(run, "failure_class", failureClass);
  const plan = [
    ["queue", 0, 100], ["build", 100, 5100], ["pull", 5100, 5600], ["smoke", 5600, 6000],
  ];
  for (const [stage, a, b] of plan) {
    startStage(run, stage, at(a + offset));
    stopStage(run, stage, "success", at(b + offset));
  }
  run.outcome = outcome;
  return run;
}

test("median and nearest-rank P95 are deterministic for small samples", () => {
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  assert.equal(percentile([5, 1, 3], 0.95), 5);
  assert.equal(percentile([], 0.95), null);
});

test("newRun validates identity and scenario, and rejects path traversal in --run", () => {
  assert.throws(() => newRun({ runId: "../escape", image: "x", platform: "y" }), /invalid --run id/);
  assert.throws(() => newRun({ runId: "r1", image: "x", platform: "y", scenario: "fast" }), /invalid scenario/);
  const run = newRun({ runId: "r1", image: "x\ny", platform: "linux/arm64", now: T0 });
  assert.equal(run.image, "x y", "GITHUB_OUTPUT values must stay on one line");
  assert.equal(run.meta.failure_class, "unknown", "an unclassified run is not silently a success");
});

test("scenario is classified after the src cache verdict is known", () => {
  const run = baseRun();
  setScenario(run, "warm");
  assert.equal(run.scenario, "warm");
  setScenario(run, "invalidated");
  assert.equal(run.scenario, "invalidated");
  assert.throws(() => setScenario(run, "fast"), /invalid scenario/);
});

test("meta keys are whitelisted and failure_class is validated", () => {
  const run = baseRun();
  setMeta(run, "fingerprint", "abc");
  assert.equal(run.meta.fingerprint, "abc");
  assert.throws(() => setMeta(run, "secret", "x"), /unknown meta key/);
  assert.throws(() => setMeta(run, "failure_class", "typo"), /invalid failure_class/);
});

test("stage lifecycle rejects unknown, duplicate and unstarted stages", () => {
  const run = baseRun();
  assert.throws(() => startStage(run, "typo"), /unknown stage/);
  assert.throws(() => stopStage(run, "build"), /not started/);
  startStage(run, "build", T0);
  assert.throws(() => startStage(run, "build"), /already recorded/);
  assert.throws(() => stopStage(run, "build", "success", at(-1)), /clock went backwards/);
  stopStage(run, "build", "success", at(100));
  assert.throws(() => stopStage(run, "build"), /already stopped/);
  assert.equal(run.stages.build.duration_ms, 100);
});

test("missing stages stay missing and never count as zero", () => {
  let run = baseRun();
  startStage(run, "build", T0);
  stopStage(run, "build", "success", at(5000));
  let s = summarise(run);
  assert.equal(s.total_ms, 5000);
  assert.deepEqual(s.missing_stages, ["pull", "smoke"], "unsplit build is the expected fallback, not a missing stage");
  assert.equal(s.comparable, false, "no native smoke means no comparable sample");
  assert.match(markdownRun(run), /证据不完整/);
  startStage(run, "smoke", at(5000));
  stopStage(run, "smoke", "success", at(5500));
  assert.equal(summarise(run).comparable, false, "unfinished run is not a success sample");
  run = finalise(run, "success", "none");
  assert.equal(summarise(run).comparable, false, "pull is still missing");
});

test("queue is reported separately and fine-grained build stages are not double counted", () => {
  const run = baseRun();
  for (const [stage, a, b] of [
    ["queue", 0, 900], ["download", 900, 1400], ["compile", 1400, 4400],
    ["export_push", 4400, 4900], ["pull", 4900, 5300], ["smoke", 5300, 5800],
  ]) { startStage(run, stage, at(a)); stopStage(run, stage, "success", at(b)); }
  run.outcome = "success";
  setMeta(run, "failure_class", "none");
  const s = summarise(run);
  assert.equal(s.queue_ms, 900);
  assert.equal(s.total_ms, 4900, "download+compile+export+pull+smoke, excluding queue");
  assert.deepEqual(s.build_stages, ["download", "compile", "export_push"]);
  assert.equal(s.missing_stages.length, 0);
  assert.equal(s.comparable, true);
  assert.doesNotMatch(markdownRun(run), /证据不完整/);
});

test("failure, cancellation and unclassified failures are never comparable samples", () => {
  assert.equal(summarise(finalise(completeRun(), "failure", "apt_external")).comparable, false);
  assert.equal(summarise(finalise(completeRun(), "cancelled", "none")).comparable, false);
  assert.equal(summarise(finalise(completeRun(), "success", "unknown")).comparable, false);
  assert.equal(summarise(finalise(completeRun(), "success", "none")).comparable, true);
  assert.throws(() => finalise(completeRun(), "maybe", "none"), /invalid outcome/);
});

test("aggregate groups scenarios, withholds P95 until enough comparable samples", () => {
  const { dir, cleanup } = fixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      const run = completeRun({ scenario: "cold", offset: i * 10 });
      writeFileSync(join(dir, `cold-${i}.json`), JSON.stringify(run));
    }
    writeFileSync(join(dir, "warm-0.json"), JSON.stringify(completeRun({ scenario: "warm", offset: 100 })));
    writeFileSync(join(dir, "failed.json"), JSON.stringify(finalise(completeRun({ scenario: "cold" }), "failure", "apt_external")));
    writeFileSync(join(dir, "cancelled.json"), JSON.stringify(finalise(completeRun({ scenario: "cold" }), "cancelled", "none")));
    const result = aggregate(dir, DEFAULT_MIN_SAMPLES);
    assert.equal(result.totalRuns, 6);
    assert.equal(result.scenarios.cold.count, 3);
    assert.equal(result.scenarios.cold.median_ms, 5900);
    assert.equal(result.scenarios.cold.p95_ms, 5900);
    assert.equal(result.scenarios.cold.sufficient, true);
    assert.equal(result.scenarios.warm.count, 1);
    assert.equal(result.scenarios.warm.p95_ms, null, "no P95 from a single sample");
    assert.equal(result.excluded.failed, 1);
    assert.equal(result.excluded.cancelled, 1);
    assert.match(markdownAggregate(result), /样本不足（需 3）/);
    assert.match(markdownAggregate(result), /不报告 P95/);
  } finally { cleanup(); }
});

test("real CLI: init -> meta -> stages -> report writes JSON, summary and single-line GITHUB_OUTPUT", () => {
  const { dir, cleanup } = fixture();
  try {
    const output = join(dir, "github-output.txt");
    const summary = join(dir, "step-summary.md");
    ok(cli(dir, "init", "--run", "ci-1", "--image", "deepsonar-chrome-fuzz", "--platform", "linux/arm64", "--scenario", "cold"), "init");
    assert.match(cli(dir, "init", "--run", "ci-1", "--image", "x", "--platform", "y").stderr, /already exists/);
    ok(cli(dir, "meta", "--run", "ci-1", "--key", "fingerprint", "--value", "fp-1"), "meta");
    ok(cli(dir, "meta", "--run", "ci-1", "--key", "base_digest", "--value", "sha256:abc"), "base digest");
    assert.match(cli(dir, "start", "--run", "ci-1", "--stage", "nope").stderr, /unknown stage/);
    ok(cli(dir, "start", "--run", "ci-1", "--stage", "queue"), "start queue");
    ok(cli(dir, "stop", "--run", "ci-1", "--stage", "queue"), "stop queue");
    ok(cli(dir, "start", "--run", "ci-1", "--stage", "build"), "start build");
    ok(cli(dir, "stop", "--run", "ci-1", "--stage", "build"), "stop build");
    ok(cli(dir, "start", "--run", "ci-1", "--stage", "pull"), "start pull");
    ok(cli(dir, "stop", "--run", "ci-1", "--stage", "pull"), "stop pull");
    ok(cli(dir, "start", "--run", "ci-1", "--stage", "smoke"), "start smoke");
    ok(cli(dir, "stop", "--run", "ci-1", "--stage", "smoke"), "stop smoke");
    ok(cli(dir, "report", "--run", "ci-1", "--outcome", "success", "--failure-class", "none",
      "--summary", summary, "--github-output", output), "report");
    const report = JSON.parse(readFileSync(join(dir, "ci-1.report.json"), "utf8"));
    assert.equal(report.meta.fingerprint, "fp-1");
    assert.equal(report.outcome, "success");
    assert.equal(report.summary.comparable, true);
    assert.match(readFileSync(summary, "utf8"), /运行镜像构建分项耗时/);
    const lines = readFileSync(output, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "GITHUB_OUTPUT must not contain embedded newlines");
    assert.match(lines[0], /^timing_json=\{/);
    assert.match(lines[1], /^timing_total_ms=\d+$/);
    assert.equal(JSON.parse(lines[0].slice("timing_json=".length)).comparable, true);
  } finally { cleanup(); }
});

test("real CLI: aggregate reads only run files and never reports P95 for thin samples", () => {
  const { dir, cleanup } = fixture();
  try {
    const summary = join(dir, "aggregate.md");
    const jsonOut = join(dir, "aggregate.json");
    writeFileSync(join(dir, "warm-0.json"), JSON.stringify(completeRun({ scenario: "warm", offset: 0 })));
    writeFileSync(join(dir, "ignored.report.json"), JSON.stringify({ schema: "junk" }));
    const result = ok(cli(dir, "aggregate", "--min-samples", "3", "--summary", summary, "--json-out", jsonOut), "aggregate");
    assert.equal(result.totalRuns, 1);
    assert.equal(result.scenarios.warm.p95_ms, null);
    assert.equal(JSON.parse(readFileSync(jsonOut, "utf8")).scenarios.warm.count, 1);
    assert.match(readFileSync(summary, "utf8"), /不报告 P95/);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 3);
  } finally { cleanup(); }
});

test("CLI fails closed on a bad run id without touching the filesystem", () => {
  const { dir, cleanup } = fixture();
  try {
    const result = cli(dir, "init", "--run", "../../etc/passwd", "--image", "x", "--platform", "y");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid --run id/);
    assert.equal(existsSync(join(dir, "passwd.json")), false);
  } finally { cleanup(); }
});

test("native_smoke is comparable with split pull/smoke but never additive with it", () => {
  let run = baseRun();
  startStage(run, "build", at(100));
  stopStage(run, "build", "success", at(5100));
  startStage(run, "native_smoke", at(5100));
  stopStage(run, "native_smoke", "success", at(6000));
  run.outcome = "success";
  setMeta(run, "failure_class", "none");
  const s = summarise(run);
  assert.equal(s.total_ms, 5900);
  assert.deepEqual(s.counted_stages, ["build", "native_smoke"]);
  assert.deepEqual(s.missing_stages, []);
  assert.equal(s.smokeGranularity, "combined");
  assert.equal(s.comparable, true);
  assert.match(markdownRun(run), /native_smoke/);
  assert.match(markdownRun(run), /合并观测/);

  // Mixing both granularities would double count the same wall-clock window.
  let mixed = baseRun();
  startStage(mixed, "build", at(100));
  stopStage(mixed, "build", "success", at(5100));
  startStage(mixed, "pull", at(5100));
  stopStage(mixed, "pull", "success", at(5600));
  startStage(mixed, "smoke", at(5600));
  stopStage(mixed, "smoke", "success", at(6000));
  startStage(mixed, "native_smoke", at(5100));
  stopStage(mixed, "native_smoke", "success", at(6000));
  mixed.outcome = "success";
  setMeta(mixed, "failure_class", "none");
  const ms = summarise(mixed);
  assert.equal(ms.mixedSmoke, true);
  assert.equal(ms.evidenceComplete, false);
  assert.equal(ms.comparable, false);
  assert.match(markdownRun(mixed), /口径冲突/);
});

test("an observed skip is evidence; a missing stage still is not", () => {
  const observed = baseRun();
  skipStage(observed, "build", "src cache reused");
  startStage(observed, "pull", at(0));
  stopStage(observed, "pull", "success", at(100));
  startStage(observed, "smoke", at(100));
  stopStage(observed, "smoke", "success", at(200));
  observed.outcome = "success";
  setMeta(observed, "failure_class", "none");
  const s = summarise(observed);
  assert.equal(s.total_ms, 200);
  assert.deepEqual(s.missing_stages, []);
  assert.equal(s.comparable, true);
  assert.match(markdownRun(observed), /skipped \(observed: src cache reused\)/);

  const missing = baseRun();
  startStage(missing, "pull", at(0));
  stopStage(missing, "pull", "success", at(100));
  startStage(missing, "smoke", at(100));
  stopStage(missing, "smoke", "success", at(200));
  assert.deepEqual(summarise(missing).missing_stages, ["build"]);
  assert.equal(summarise(missing).comparable, false);
  assert.throws(() => skipStage(observed, "build", "twice"), /already recorded/);
  assert.throws(() => skipStage(baseRun(), "not_a_stage", "x"), /unknown stage/);
});

test("CLI skip command writes an observed zero-duration stage", () => {
  const { dir, cleanup } = fixture();
  try {
    ok(cli(dir, "init", "--run", "r-warm", "--image", "deepsonar-chrome-fuzz", "--platform", "linux/arm64", "--scenario", "warm"), "init");
    ok(cli(dir, "skip", "--run", "r-warm", "--stage", "build", "--reason", "src cache reused"), "skip");
    const run = JSON.parse(readFileSync(join(dir, "r-warm.json"), "utf8"));
    assert.equal(run.stages.build.observed, true);
    assert.equal(run.stages.build.duration_ms, 0);
    assert.equal(run.stages.build.reason, "src cache reused");
  } finally { cleanup(); }
});
