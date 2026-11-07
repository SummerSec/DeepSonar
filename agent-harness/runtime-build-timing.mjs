#!/usr/bin/env node
/**
 * #961 P0: comparable, fail-closed timing evidence for runtime image builds.
 *
 * This is measurement only. It never decides whether a build passed, never
 * fabricates a missing stage as zero, and never reports a P95 from a sample
 * set smaller than the declared minimum. A run whose stages are incomplete is
 * still written out, but is excluded from comparable samples.
 *
 * CLI:
 *   init   --run ID --image KEY --platform P [--scenario cold|warm|invalidated]
 *   meta   --run ID --key K --value V
 *   start  --run ID --stage S
 *   stop   --run ID --stage S [--outcome success|failure|skipped]
 *   skip   --run ID --stage S --reason R   (observed 0ms reuse, never a missing stage)
 *   report --run ID [--outcome success|failure|cancelled] [--failure-class C]
 *   aggregate --dir D [--min-samples 3]
 *
 * State lives in $RUNNER_TEMP by default so GitHub Actions steps can share it
 * within one job. Cross-job correlation uses the run id, not a shared file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "deepsonar.runtime-build-timing.v1";
/** Issue #961 asks for these stages; `build` is the honest fallback when
 * BuildKit has not yet been split into download/compile/export (P2), and
 * `native_smoke` is the honest combined observation when the native ARM smoke
 * job runs pull + test-chrome-runtime.mjs in one Actions step. */
export const STAGES = Object.freeze([
  "queue", "handoff", "download", "compile", "export_push", "build", "pull", "smoke", "native_smoke",
]);
/** Reported alongside the total, never folded into it. `queue` is run start ->
 * build job start; `handoff` is build job end -> native smoke job start. */
export const EXCLUDED_STAGES = Object.freeze(["queue", "handoff"]);
export const COMBINED_SMOKE_STAGE = "native_smoke";
export const BUILD_SUBSTAGES = Object.freeze(["download", "compile", "export_push"]);
export const NON_QUEUE_STAGES = Object.freeze([...BUILD_SUBSTAGES, "build", "pull", "smoke"]);
export const SCENARIOS = Object.freeze(["cold", "warm", "invalidated", "unknown"]);
export const OUTCOMES = Object.freeze(["in_progress", "success", "failure", "cancelled"]);
export const FAILURE_CLASSES = Object.freeze([
  "none", "apt_external", "compile", "cache_invalidation", "unknown",
]);
export const META_KEYS = Object.freeze([
  "base_sha", "head_sha", "test_sha", "fingerprint", "base_digest",
  "src_reuse", "buildkit_cache", "matched_inputs", "failure_class",
]);
export const DEFAULT_MIN_SAMPLES = 3;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_VALUE = 512;

export function defaultDir() {
  return join(process.env.RUNNER_TEMP || tmpdir(), "deepsonar-runtime-timing");
}

function stagePath(runId, dir) {
  if (!RUN_ID.test(runId || "")) throw new Error(`invalid --run id: ${JSON.stringify(runId)}`);
  return join(resolve(dir || defaultDir()), `${runId}.json`);
}

function clean(value, label) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  if (text.length > MAX_VALUE) throw new Error(`${label} exceeds ${MAX_VALUE} chars`);
  return text;
}

function load(runId, dir) {
  const path = stagePath(runId, dir);
  if (!existsSync(path)) throw new Error(`no timing run at ${path}; call init first`);
  const run = JSON.parse(readFileSync(path, "utf8"));
  if (run.schema !== SCHEMA || run.runId !== runId) throw new Error(`unexpected timing schema at ${path}`);
  return { run, path };
}

function save(run, path) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
}

export function newRun({ runId, image, platform, scenario = "unknown", now }) {
  if (!RUN_ID.test(runId || "")) throw new Error(`invalid --run id: ${JSON.stringify(runId)}`);
  if (!SCENARIOS.includes(scenario)) throw new Error(`invalid scenario: ${scenario}`);
  return {
    schema: SCHEMA,
    runId,
    image: clean(image, "image"),
    platform: clean(platform, "platform"),
    scenario,
    createdAt: now || new Date().toISOString(),
    outcome: "in_progress",
    meta: { failure_class: "unknown" },
    stages: {},
  };
}

/** The src-cache verdict is only known after `resolve`, i.e. after init. */
export function setScenario(run, value) {
  if (!SCENARIOS.includes(value)) throw new Error(`invalid scenario: ${value}`);
  run.scenario = value;
  return run;
}

export function setMeta(run, key, value) {
  if (!META_KEYS.includes(key)) throw new Error(`unknown meta key: ${key}`);
  if (key === "failure_class" && !FAILURE_CLASSES.includes(value)) {
    throw new Error(`invalid failure_class: ${value}`);
  }
  run.meta[key] = clean(value, key);
  return run;
}

export function startStage(run, stage, now) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
  if (run.stages[stage]) throw new Error(`stage already recorded: ${stage}`);
  run.stages[stage] = { start: now || new Date().toISOString(), end: null, duration_ms: null, outcome: null };
  return run;
}

/** An explicitly observed skip (e.g. src cache reuse) is real evidence with a
 * zero duration. It is NOT a missing stage silently counted as zero. */
export function skipStage(run, stage, reason) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
  if (run.stages[stage]) throw new Error(`stage already recorded: ${stage}`);
  run.stages[stage] = {
    start: null, end: null, duration_ms: 0, outcome: "skipped",
    observed: true, reason: clean(reason, "reason"),
  };
  return run;
}

export function stopStage(run, stage, outcome = "success", now) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
  const entry = run.stages[stage];
  if (!entry) throw new Error(`stage not started: ${stage}`);
  if (entry.end) throw new Error(`stage already stopped: ${stage}`);
  if (!["success", "failure", "skipped"].includes(outcome)) throw new Error(`invalid stage outcome: ${outcome}`);
  const end = now || new Date().toISOString();
  const duration = Date.parse(end) - Date.parse(entry.start);
  if (!Number.isFinite(duration) || duration < 0) throw new Error(`clock went backwards for ${stage}`);
  entry.end = end;
  entry.duration_ms = duration;
  entry.outcome = outcome;
  return run;
}

/** Missing stages stay missing; total never silently treats them as zero. */
export function summarise(run) {
  const measured = (names) => names.filter((name) => {
    const s = run.stages[name];
    return s && (s.end || s.observed) && Number.isFinite(s.duration_ms);
  });
  const detailed = measured(BUILD_SUBSTAGES);
  // P2 has not split the BuildKit step yet. If none of the three fine-grained
  // stages were timed, `build` is the honest whole-step fallback. Once any of
  // them is present, all three are required: mixing granularities would make
  // samples incomparable. Never count both the parts and the whole.
  const useDetailed = detailed.length > 0;
  const expectedBuild = useDetailed ? BUILD_SUBSTAGES : ["build"];
  const buildNames = useDetailed ? detailed : measured(["build"]);
  // A single Actions step can only be timed as a whole. `native_smoke` covers
  // exactly the same wall-clock window as pull + smoke together, so it is
  // comparable with a split observation — but never additive with it.
  const combinedSmoke = measured([COMBINED_SMOKE_STAGE]);
  const splitSmoke = measured(["pull", "smoke"]);
  const useCombined = combinedSmoke.length > 0;
  const smokeNames = useCombined ? combinedSmoke : splitSmoke;
  const expectedSmoke = useCombined ? [COMBINED_SMOKE_STAGE] : ["pull", "smoke"];
  const counted = [...buildNames, ...smokeNames];
  const queue = measured(["queue"]);
  const handoff = measured(["handoff"]);
  const total_ms = counted.reduce((sum, name) => sum + run.stages[name].duration_ms, 0);
  const missing = [...expectedBuild, ...expectedSmoke].filter((name) => !measured([name]).length);
  const mixedSmoke = combinedSmoke.length > 0 && splitSmoke.length > 0;
  const evidenceComplete = missing.length === 0 && !mixedSmoke;
  const comparable = evidenceComplete && run.outcome === "success" && run.meta.failure_class === "none";
  return {
    total_ms,
    queue_ms: queue.reduce((sum, name) => sum + run.stages[name].duration_ms, 0),
    handoff_ms: handoff.reduce((sum, name) => sum + run.stages[name].duration_ms, 0),
    excluded_ms: [...queue, ...handoff].reduce((sum, name) => sum + run.stages[name].duration_ms, 0),
    build_stages: buildNames,
    smoke_stages: smokeNames,
    counted_stages: counted,
    missing_stages: missing,
    evidenceComplete,
    buildGranularity: useDetailed ? "detailed" : "unsplit",
    smokeGranularity: useCombined ? "combined" : "split",
    mixedSmoke,
    comparable,
  };
}

export function finalise(run, outcome, failureClass) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);
  run.outcome = outcome;
  if (failureClass) setMeta(run, "failure_class", failureClass);
  return { ...run, summary: summarise(run) };
}

export function markdownRun(run) {
  const s = summarise(run);
  const lines = [
    `### 运行镜像构建分项耗时 · ${run.image} (${run.platform})`,
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    `| run | \`${run.runId}\` |`,
    `| 场景 | \`${run.scenario}\` |`,
    `| 结果 | \`${run.outcome}\` / \`${run.meta.failure_class}\` |`,
    `| base / head / test SHA | \`${run.meta.base_sha || "n/a"}\` / \`${run.meta.head_sha || "n/a"}\` / \`${run.meta.test_sha || "n/a"}\` |`,
    `| fingerprint | \`${run.meta.fingerprint || "n/a"}\` |`,
    `| base digest | \`${run.meta.base_digest || "n/a"}\` |`,
    `| src 复用 / BuildKit 缓存 | \`${run.meta.src_reuse || "unknown"}\` / \`${run.meta.buildkit_cache || "unknown"}\` |`,
    `| 命中输入 | ${run.meta.matched_inputs || "n/a"} |`,
    `| 可比样本 | ${s.comparable ? "yes" : "no"} |`,
    "",
    "| 阶段 | 耗时 (ms) | 状态 |",
    "| --- | ---: | --- |",
  ];
  for (const name of STAGES) {
    const entry = run.stages[name];
    const value = entry?.end || entry?.observed ? entry.duration_ms : "—";
    const state = !entry ? "missing" : entry.observed ? `skipped (observed: ${entry.reason})`
      : !entry.end ? "unfinished" : entry.outcome;
    lines.push(`| ${name} | ${value} | ${state} |`);
  }
  lines.push("", `- 合计（不含排队/交接）: **${s.total_ms} ms**；排队单列: ${s.queue_ms} ms；跨 job 交接单列: ${s.handoff_ms} ms。`);
  if (s.mixedSmoke) lines.push("- ⚠️ 同时记录了 `native_smoke` 与拆分 pull/smoke：口径冲突，本条不计入可比样本。");
  if (!s.evidenceComplete) lines.push("- ⚠️ 证据不完整：缺失阶段不按 0 计，本条不计入可比样本。");
  else if (s.buildGranularity === "unsplit") lines.push("- 当前 BuildKit 构建未拆分 download/compile/export_push，以 `build` 整段计时；可用于整段比较，不能用于阶段归因。");
  if (s.smokeGranularity === "combined") lines.push("- 原生冒烟的 pull 与 test-chrome-runtime 位于同一 Actions step，以 `native_smoke` 合并观测；可用于端到端比较，不能用于 pull/smoke 归因。");
  if (!s.comparable) lines.push("- 本条不计入可比样本（结果、失败分类或阶段证据不满足条件）。");
  return `${lines.join("\n")}\n`;
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: deterministic, no interpolation, honest for small samples.
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function aggregate(dir, minSamples = DEFAULT_MIN_SAMPLES) {
  const root = resolve(dir || defaultDir());
  const files = existsSync(root) ? readdirSync(root).filter((f) => f.endsWith(".json") && !f.endsWith(".report.json")) : [];
  // The aggregate result itself lives in this directory, alongside unrelated
  // artifacts. Only well-formed run records are samples; corrupt files are
  // skipped rather than crashing the whole report.
  const isRun = (r) => r && r.schema === SCHEMA && typeof r.runId === "string" && r.stages && r.meta;
  const runs = files.map((f) => {
    try { return JSON.parse(readFileSync(join(root, f), "utf8")); } catch { return null; }
  }).filter(isRun);
  const groups = {};
  const excluded = { incomplete: 0, failed: 0, cancelled: 0, unclassified_failure: 0 };
  for (const run of runs) {
    const s = summarise(run);
    const scenario = SCENARIOS.includes(run.scenario) ? run.scenario : "unknown";
    groups[scenario] ||= { samples: [], stages: {} };
    if (run.outcome === "failure") excluded.failed += 1;
    else if (run.outcome === "cancelled") excluded.cancelled += 1;
    else if (run.meta.failure_class !== "none") excluded.unclassified_failure += 1;
    else if (!s.comparable) excluded.incomplete += 1;
    else groups[scenario].samples.push(s.total_ms);
  }
  const result = { schema: SCHEMA, minSamples, totalRuns: runs.length, excluded, scenarios: {} };
  for (const [scenario, group] of Object.entries(groups)) {
    const n = group.samples.length;
    result.scenarios[scenario] = {
      count: n,
      median_ms: median(group.samples),
      p95_ms: n >= minSamples ? percentile(group.samples, 0.95) : null,
      sufficient: n >= minSamples,
    };
  }
  return result;
}

export function markdownAggregate(result) {
  const lines = [
    "### #961 冷/热/失效可比样本",
    "",
    `样本总数 ${result.totalRuns}；排除：失败 ${result.excluded.failed}、取消 ${result.excluded.cancelled}、失败未分类 ${result.excluded.unclassified_failure}、证据不完整 ${result.excluded.incomplete}。`,
    "",
    "| 场景 | 可比样本 | 中位数 (ms) | P95 (ms) | 判定 |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const [scenario, s] of Object.entries(result.scenarios)) {
    const p95 = s.sufficient ? s.p95_ms : `样本不足（需 ${result.minSamples}）`;
    lines.push(`| ${scenario} | ${s.count} | ${s.median_ms ?? "—"} | ${p95} | ${s.sufficient ? "可报告" : "不报告 P95"} |`);
  }
  lines.push("", "排队与跨 job 交接耗时、失败/取消样本单列，不计入合计；缓存命中不能替代原生冒烟通过。", "");
  return `${lines.join("\n")}\n`;
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

function append(path, text) {
  if (!path) return;
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text, { flag: "a" });
}

function runCli(argv, env = process.env) {
  const args = parseArgs(argv);
  const [command] = args._;
  const dir = args.dir || defaultDir();
  const runId = args.run;
  const write = (run) => save(run, stagePath(runId, dir));
  if (command === "init") {
    const path = stagePath(runId, dir);
    if (existsSync(path)) throw new Error(`timing run already exists: ${path}`);
    const run = newRun({ runId, image: args.image, platform: args.platform, scenario: args.scenario });
    save(run, path);
    return { ok: true, path };
  }
  if (!["meta", "scenario", "start", "stop", "skip", "report", "aggregate"].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (command === "aggregate") {
    const result = aggregate(dir, Number(args["min-samples"] || DEFAULT_MIN_SAMPLES));
    append(args.summary || env.GITHUB_STEP_SUMMARY, markdownAggregate(result));
    if (args["json-out"]) writeFileSync(args["json-out"], `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const { run, path } = load(runId, dir);
  if (command === "meta") { setMeta(run, args.key, args.value); write(run); return { ok: true, path }; }
  if (command === "scenario") { setScenario(run, args.value); write(run); return { ok: true, path }; }
  if (command === "start") { startStage(run, args.stage); write(run); return { ok: true, path }; }
  if (command === "stop") { stopStage(run, args.stage, args.outcome || "success"); write(run); return { ok: true, path }; }
  if (command === "skip") { skipStage(run, args.stage, args.reason || "unspecified"); write(run); return { ok: true, path }; }
  const finished = finalise(run, args.outcome || "success", args["failure-class"]);
  delete finished.summary;
  save(finished, path);
  const jsonOut = args["json-out"] || join(resolve(dir), `${runId}.report.json`);
  writeFileSync(jsonOut, `${JSON.stringify({ ...finished, summary: summarise(finished) }, null, 2)}\n`);
  append(args.summary || env.GITHUB_STEP_SUMMARY, markdownRun(finished));
  const output = args["github-output"] || env.GITHUB_OUTPUT;
  if (output) {
    const compact = JSON.stringify({ runId, scenario: finished.scenario, ...summarise(finished) });
    append(output, `timing_json=${compact}\ntiming_total_ms=${summarise(finished).total_ms}\n`);
  }
  return { ok: true, path, jsonOut };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`runtime-build-timing: ${error.message}\n`);
    process.exitCode = 1;
  }
}
