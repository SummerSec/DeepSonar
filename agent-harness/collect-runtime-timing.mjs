#!/usr/bin/env node
/**
 * #961 P0: turn GitHub Actions job/step timestamps into runtime-build-timing
 * evidence WITHOUT instrumenting the build workflows.
 *
 * Why not inline steps in ci.yml / release.yml: Chrome Fuzz arm64 is built in
 * one job and natively smoked in another (both in ci.yml and release.yml), so
 * a timing state file needs an artifact hop to cross jobs. On top of that,
 * PRs #964 and #965 are both still editing ci.yml. The Actions API already
 * exposes started_at/completed_at for every step, which gives real evidence,
 * works for all three workflows, and can backfill historical runs so cold /
 * warm / invalidated samples can actually accumulate.
 *
 * This script is deliberately offline: it never calls the network and never
 * reads a token. The workflow assembles the payload with `gh api`; fixtures
 * make every mapping decision testable without a GitHub run.
 *
 * Input JSON: one `{ run, jobs }` object, or an array of them.
 *   run  - subset of GET /actions/runs/{id}
 *   jobs - the `jobs[]` array from GET /actions/runs/{id}/jobs
 *
 * CLI:
 *   node collect-runtime-timing.mjs --input FILE --out-dir DIR \
 *     [--scenario cold|warm|invalidated|unknown|auto] [--failure-class C] \
 *     [--aggregate] [--min-samples 3] [--summary FILE] [--json-out FILE]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA, SCENARIOS, FAILURE_CLASSES, COMBINED_SMOKE_STAGE, DEFAULT_MIN_SAMPLES,
  newRun, setMeta, startStage, stopStage, skipStage, finalise, summarise,
  markdownRun, aggregate, markdownAggregate, defaultDir,
  collectorProvenance, hasTrustedProvenance, trustedCollector,
} from "./runtime-build-timing.mjs";

export const IMAGE_KEY = "deepsonar-chrome-fuzz";
export const PLATFORM = "linux/arm64";

/** ci.yml names its steps; release.yml does not name its build-push step, so
 * it cannot be selected reliably from the API payload. Rather than guess a
 * duration, we leave the stage missing and let fail-closed exclude the run. */
export const BUILD_JOB_PATTERNS = Object.freeze([
  /^chrome-fuzz-arm64-build$/i,
  /chrome-image-builds.*chrome-fuzz.*arm64/i,
]);
export const SMOKE_JOB_PATTERNS = Object.freeze([
  /^chrome-fuzz-arm64$/i,
  /^chrome-fuzz-arm64-smoke/i,
]);
export const BUILD_STEP_PATTERNS = Object.freeze([
  /build chrome fuzz arm64 by digest/i,
]);
export const SMOKE_STEP_PATTERNS = Object.freeze([
  /原生执行 chrome fuzz/i,
  /test-chrome-runtime/i,
  /chrome fuzz arm64 smoke/i,
]);

function firstMatch(items, patterns, key = "name") {
  if (!Array.isArray(items)) return null;
  return items.find((item) => patterns.some((re) => re.test(String(item?.[key] ?? "")))) || null;
}

function normalise(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be a { run, jobs } object");
  }
  const run = payload.run || payload;
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  if (!Number.isFinite(Number(run?.id))) throw new Error("run.id is required");
  return { run, jobs };
}

/** A planned skip (docs-only / draft / #965 routing) is not a build sample. */
export function isPlannedSkip(run, buildJob, smokeJob) {
  if (!buildJob && !smokeJob) return true;
  return buildJob?.conclusion === "skipped" && smokeJob?.conclusion === "skipped";
}

/** Only a src-cache reuse can be inferred from step metadata. Distinguishing
 * cold from invalidated needs BuildKit cache-hit events (P2), not timestamps;
 * an explicit --scenario from a controlled benchmark is the honest override. */
export function inferScenario({ buildStep } = {}) {
  if (!buildStep) return "unknown";
  return buildStep.conclusion === "skipped" ? "warm" : "unknown";
}

/** A cache hit never substitutes for a passing native ARM smoke. The verdict
 * is scoped to the measured ARM chain: an unrelated Windows/DB job failing in
 * the same CI run does not invalidate a complete build+smoke observation. The
 * run-level conclusion is still kept in `source` for traceability. */
export function deriveOutcome(run, buildJob, smokeJob) {
  const relevant = [buildJob?.conclusion, smokeJob?.conclusion].filter(Boolean);
  if (relevant.some((v) => ["cancelled", "timed_out", "action_required"].includes(v))) return "cancelled";
  if (run?.conclusion === "cancelled" || run?.status === "cancelled") return "cancelled";
  if (!smokeJob || smokeJob.conclusion !== "success") return "failure";
  if (buildJob && !["success", "skipped"].includes(buildJob.conclusion)) return "failure";
  return "success";
}

function record(run, stage, step) {
  if (!step?.started_at || !step?.completed_at) return false;
  const outcome = step.conclusion === "success" ? "success"
    : step.conclusion === "skipped" ? "skipped" : "failure";
  try {
    startStage(run, stage, step.started_at);
    stopStage(run, stage, outcome, step.completed_at);
    return true;
  } catch {
    // A malformed/backwards clock is not evidence. Drop the stage so the run
    // stays incomplete instead of contributing a fabricated duration.
    delete run.stages[stage];
    return false;
  }
}

export function collectRun(payload, opts = {}) {
  const { run, jobs } = normalise(payload);
  const buildJob = firstMatch(jobs, opts.buildJobPatterns || BUILD_JOB_PATTERNS);
  const smokeJob = firstMatch(jobs, opts.smokeJobPatterns || SMOKE_JOB_PATTERNS);
  if (isPlannedSkip(run, buildJob, smokeJob)) return null;

  const buildStep = firstMatch(buildJob?.steps, opts.buildStepPatterns || BUILD_STEP_PATTERNS);
  const smokeStep = firstMatch(smokeJob?.steps, opts.smokeStepPatterns || SMOKE_STEP_PATTERNS);
  const scenario = opts.scenario || inferScenario({ buildStep });
  if (!SCENARIOS.includes(scenario)) throw new Error(`invalid scenario: ${scenario}`);
  const outcome = deriveOutcome(run, buildJob, smokeJob);
  const failureClass = opts.failureClass || (outcome === "success" ? "none" : "unknown");
  if (!FAILURE_CLASSES.includes(failureClass)) throw new Error(`invalid failure_class: ${failureClass}`);

  const runAttempt = Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 ? run.run_attempt : "unknown";
  const runId = `gha-${run.id}-attempt-${runAttempt}`;
  const timing = newRun({
    runId, image: IMAGE_KEY, platform: PLATFORM, scenario,
    now: run.run_started_at || run.created_at || undefined,
  });
  setMeta(timing, "head_sha", String(run.head_sha || "unknown"));
  // Run metadata is not checkout evidence. In particular a PR head is not its
  // tested merge commit. Do not consume a payload-supplied tested SHA, or query
  // today's mutable refs/pull/<n>/merge to fill a historical observation.
  setMeta(timing, "tested_checkout_sha", "unknown");
  timing.provenance = opts.collector ? collectorProvenance(opts.collector, opts.policy) : null;
  setMeta(timing, "base_sha", String(opts.baseSha || "unknown"));
  // The Actions job payload exposes step timings but not step outputs.
  setMeta(timing, "fingerprint", "unknown");
  setMeta(timing, "base_digest", "unknown");
  setMeta(timing, "src_reuse", buildStep?.conclusion === "skipped" ? "reused" : "rebuilt");
  setMeta(timing, "buildkit_cache", "unknown");
  setMeta(timing, "matched_inputs", "unknown");

  // Waiting for the upstream `changes` job is reported separately from the
  // build/smoke wall clock, never folded into the comparable total.
  if (run.run_started_at && buildJob?.started_at) {
    record(timing, "queue", {
      started_at: run.run_started_at,
      completed_at: buildJob.started_at,
      conclusion: "success",
    });
  }
  if (buildJob?.completed_at && smokeJob?.started_at) {
    record(timing, "handoff", {
      started_at: buildJob.completed_at,
      completed_at: smokeJob.started_at,
      conclusion: "success",
    });
  }
  if (buildStep) {
    if (buildStep.conclusion === "skipped") {
      skipStage(timing, "build", "src cache reused; build-push-action skipped");
    } else {
      record(timing, "build", buildStep);
    }
  }
  // One Actions step covers `docker pull` + test-chrome-runtime.mjs. The
  // combined observation is honest; inventing a pull/smoke split is not.
  if (smokeStep) record(timing, COMBINED_SMOKE_STAGE, smokeStep);

  const finished = finalise(timing, outcome, failureClass);
  const source = {
      schema: `${SCHEMA}.source`,
      collection: "github-actions-step-timestamps",
      workflow: String(run.name || "unknown"),
      run_id: Number(run.id),
      run_conclusion: String(run.conclusion || "unknown"),
      run_url: String(run.html_url || ""),
      head_branch: String(run.head_branch || ""),
      source_sha: String(run.head_sha || "unknown"),
      tested_checkout_sha: "unknown",
      checkout_evidence: "unavailable-in-run-jobs-api",
      run_attempt: runAttempt,
      event: String(run.event || "unknown"),
      repository: String(run.repository?.full_name || "unknown"),
      workflow_path: String(run.path || "unknown"),
      build_job: buildJob?.name || null,
      smoke_job: smokeJob?.name || null,
      build_step: buildStep?.name || null,
      smoke_step: smokeStep?.name || null,
  };
  const state = { ...finished, source };
  delete state.summary;
  const report = { ...state, summary: summarise(state) };
  return { runId, state, report };
}

/** One malformed payload must not discard the rest of the batch. */
export function collectAll(payloads, opts = {}) {
  const list = Array.isArray(payloads) ? payloads : [payloads];
  const collected = [];
  const skipped = [];
  list.forEach((payload, index) => {
    try {
      const result = collectRun(payload, opts);
      if (result) collected.push(result);
      else skipped.push({ index, reason: "planned skip or no ARM jobs" });
    } catch (error) {
      skipped.push({ index, reason: `collection failed: ${error.message}` });
    }
  });
  return { collected, skipped };
}

/** Only import records whose producer was independently verified through Actions.
 * Legacy samples are never upgraded or stamped with the current collector identity. */
export function importHistory(directory, outDir, trust, producerRunId) {
  const result = { imported: 0, excluded: 0 };
  const producer = trust?.collectors?.find((record) => record.id === producerRunId);
  if (!trustedCollector(producer, trust?.policy)) return { ...result, excluded: 1, reason: "untrusted artifact producer" };
  if (!existsSync(directory)) return result;
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".json") || file.name.endsWith(".report.json")) continue;
    let sample;
    try { sample = JSON.parse(readFileSync(join(directory, file.name), "utf8")); } catch { result.excluded++; continue; }
    if (!hasTrustedProvenance(sample, trust) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sample.runId ?? "")) {
      result.excluded++; continue;
    }
    mkdirSync(outDir, { recursive: true });
    const destination = join(outDir, `${sample.runId}.json`);
    if (!existsSync(destination)) writeFileSync(destination, `${JSON.stringify(sample, null, 2)}\n`);
    result.imported++;
  }
  return result;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(token);
  }
  return out;
}

function appendSummary(path, text) {
  if (!path) return;
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text, { flag: "a" });
}

function runCli(argv, env = process.env) {
  const args = parseArgs(argv);
  const trust = args.trust ? JSON.parse(readFileSync(args.trust, "utf8")) : null;
  if (args["validate-collector"]) {
    const record = JSON.parse(readFileSync(args["validate-collector"], "utf8"));
    if (!trustedCollector(record, trust?.policy)) throw new Error("untrusted collector run metadata");
    return { trusted: true };
  }
  if (args["import-history"]) return importHistory(args["import-history"], resolve(args["out-dir"]), trust, Number(args["producer-run-id"]));
  if (!args.input) throw new Error("--input is required");
  if (!existsSync(args.input)) throw new Error(`no input file: ${args.input}`);
  const outDir = resolve(args["out-dir"] || defaultDir());
  mkdirSync(outDir, { recursive: true });
  const payloads = JSON.parse(readFileSync(args.input, "utf8"));

  const opts = { policy: trust?.policy,
    collector: trust?.collectors?.find((record) => record.id === trust.policy.current_run_id) };
  if (args.scenario && args.scenario !== true && args.scenario !== "auto") opts.scenario = args.scenario;
  if (args["failure-class"] && args["failure-class"] !== true) opts.failureClass = args["failure-class"];
  if (args["base-sha"] && args["base-sha"] !== true) opts.baseSha = args["base-sha"];

  const { collected, skipped } = collectAll(payloads, opts);
  for (const { runId, state, report } of collected) {
    writeFileSync(join(outDir, `${runId}.json`), `${JSON.stringify(state, null, 2)}\n`);
    writeFileSync(join(outDir, `${runId}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
  }

  const summary = args.summary || env.GITHUB_STEP_SUMMARY;
  appendSummary(summary, [
    "### #961 P0 运行镜像构建证据采集",
    "",
    `本轮写入 ${collected.length} 条；跳过 ${skipped.length} 条（计划跳过 / 无 ARM job / 采集失败）。`,
    "",
  ].join("\n"));
  for (const { report } of collected) appendSummary(summary, markdownRun(report));
  for (const item of skipped) appendSummary(summary, `- 跳过 #${item.index}: ${item.reason}\n`);

  let result = null;
  if (args.aggregate) {
    result = aggregate(outDir, Number(args["min-samples"] || DEFAULT_MIN_SAMPLES), trust);
    appendSummary(summary, markdownAggregate(result));
    if (args["json-out"] && args["json-out"] !== true) {
      writeFileSync(args["json-out"], `${JSON.stringify(result, null, 2)}\n`);
    }
  }
  return { collected: collected.map((c) => c.runId), skipped, aggregate: result };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`collect-runtime-timing: ${error.message}\n`);
    process.exitCode = 1;
  }
}
