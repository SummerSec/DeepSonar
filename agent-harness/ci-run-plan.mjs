#!/usr/bin/env node
/**
 * Build the pull-request run plan for the CI tier split (#836).
 *
 * One classifier, one plan: this module reuses classify-ci-changes.mjs instead
 * of inventing a second notion of "what changed". It only decides WHICH suites
 * this run must execute and whether the run is a Draft fast check or the full
 * merge-candidate verification. Nothing here may be used to skip a suite that
 * the plan says is required, and a failed classification always widens the plan.
 *
 * Baseline discipline (#836 step 1): the specialist suites are derived from the
 * path filters the specialist workflows already declare, read from the workflow
 * files at plan time. A workflow can therefore not drift from the plan, and no
 * coverage is narrowed by copying a stale table.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CLASSIFIER_MODES,
  CLASSIFIER_STATUSES,
  classifyRecords,
  parseGitNameStatusZ,
} from "./classify-ci-changes.mjs";

export const RUN_MODES = Object.freeze({
  DOCS: "docs",
  DRAFT_FAST: "draft-fast",
  READY_FULL: "ready-full",
});

export const PLAN_STATUSES = Object.freeze({
  OK: "ok",
  FAILED: "failed",
});

/** Repository variable that gates the rollout; anything but `tiered` is full. */
export const CI_PR_MODE_VARIABLE = "CI_PR_MODE";
export const TIERED_MODE = "tiered";

/** Specialist workflows that ci.yml can call, and the file that owns their paths. */
export const SPECIALIST_WORKFLOWS = Object.freeze({
  reverse: ".github/workflows/reverse-runtime.yml",
  chrome: ".github/workflows/chrome-runtime.yml",
  clickhouse: ".github/workflows/clickhouse-runtime.yml",
  mobile: ".github/workflows/mobile-runtime.yml",
  openharmony: ".github/workflows/openharmony-runtime.yml",
});

/**
 * Draft fast checks: existing no-service suites only. Every entry must be a
 * `pnpm` script that runs without PostgreSQL, Docker or a browser.
 */
export const FAST_SUITE_ROUTES = Object.freeze([
  Object.freeze({ paths: Object.freeze(["apps/web/**"]), script: "ci:unit:web-facts" }),
  Object.freeze({ paths: Object.freeze(["apps/scheduler/**"]), script: "ci:unit:bounded-contexts" }),
  Object.freeze({ paths: Object.freeze(["packages/shared-types/**"]), script: "ci:unit:finding-protocol" }),
  Object.freeze({ paths: Object.freeze(["deploy/**"]), script: "ci:unit:deploy-ps1" }),
]);

const unquote = (value) => value.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");

/**
 * Read the `pull_request.paths` filter a workflow declares. Text-based on
 * purpose: the CI image has no YAML dependency, and these blocks are simple
 * indented lists.
 */
export function readWorkflowPullRequestPaths(contents) {
  const lines = String(contents).split(/\r?\n/);
  const paths = [];
  let inOn = false;
  let inPullRequest = false;
  let inPaths = false;
  let pathsIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      inOn = trimmed === "on:";
      inPullRequest = false;
      inPaths = false;
      continue;
    }
    if (!inOn) continue;
    if (indent === 2) {
      inPullRequest = trimmed.startsWith("pull_request:");
      inPaths = false;
      continue;
    }
    if (!inPullRequest) continue;
    if (!inPaths && /^paths:\s*$/u.test(trimmed)) {
      inPaths = true;
      pathsIndent = indent;
      continue;
    }
    if (!inPaths) continue;
    if (indent <= pathsIndent && !trimmed.startsWith("- ")) {
      inPaths = false;
      continue;
    }
    if (trimmed.startsWith("- ")) paths.push(unquote(trimmed.slice(2)));
  }
  return paths;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Translate a workflows `paths` pattern into a matcher. */
export function pathPatternToRegExp(pattern) {
  const segments = String(pattern).split("/");
  const source = segments
    .map((segment, index) => {
      if (segment === "**") return index === segments.length - 1 ? "(?:.*)?" : "(?:[^/]+/)*";
      const body = escapeRegExp(segment).replaceAll("\\*", "[^/]*");
      return index === segments.length - 1 ? body : `${body}/`;
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

export function matchesPathPattern(pattern, path) {
  return pathPatternToRegExp(pattern).test(path);
}

export const matchesAnyPath = (patterns, path) =>
  patterns.some((pattern) => matchesPathPattern(pattern, path));

/** Suites whose declared path filter is hit by any changed path, in stable order. */
export function matchSuites(suitePaths, paths) {
  return Object.keys(suitePaths)
    .filter((suite) => paths.some((path) => matchesAnyPath(suitePaths[suite], path)))
    .sort();
}

export function fastSuitesFor(paths) {
  return FAST_SUITE_ROUTES
    .filter((route) => paths.some((path) => matchesAnyPath(route.paths, path)))
    .map((route) => route.script);
}

/** Only `tiered` enables the Draft split; unset, invalid or `full` restore full PR runs. */
export const isTiered = (ciPrMode) => String(ciPrMode ?? "").trim() === TIERED_MODE;

/**
 * @param {{eventName?: string, base?: string, head?: string, draft?: boolean,
 *   diffBytes?: Buffer|string, classifier?: object, ciPrMode?: string,
 *   suitePaths?: Record<string, string[]>}} input
 */
export function buildRunPlan({
  eventName,
  base,
  head,
  draft = false,
  diffBytes,
  classifier,
  ciPrMode,
  suitePaths = {},
} = {}) {
  const suites = Object.keys(suitePaths).sort();
  const tiered = isTiered(ciPrMode);
  const plan = {
    status: PLAN_STATUSES.OK,
    mode: RUN_MODES.READY_FULL,
    docsOnly: false,
    requiredSuites: [],
    fastSuites: [],
    tiered,
    reasons: [],
    base: base ?? "",
    head: head ?? "",
  };

  if (eventName !== "pull_request") {
    plan.reasons.push("non_pull_request_event");
    return plan;
  }
  if (!base || !head) {
    plan.status = PLAN_STATUSES.FAILED;
    plan.reasons.push("missing_pull_request_revision");
    plan.requiredSuites = suites;
    plan.fastSuites = [...new Set(FAST_SUITE_ROUTES.map((route) => route.script))];
    return plan;
  }

  let records;
  try {
    const bytes = diffBytes ?? readGitDiff(base, head);
    records = parseGitNameStatusZ(bytes);
    plan.reasons.push("diff_parsed");
  } catch {
    plan.status = PLAN_STATUSES.FAILED;
    plan.reasons.push("diff_read_failed");
    plan.requiredSuites = suites;
    plan.fastSuites = [...new Set(FAST_SUITE_ROUTES.map((route) => route.script))];
    return plan;
  }

  const classification = classifier ?? classifyRecords(records, { eventName, base, head });
  if (classification.status === CLASSIFIER_STATUSES.FAILED) {
    plan.status = PLAN_STATUSES.FAILED;
    plan.reasons.push(`classifier_failed:${classification.reason}`);
    plan.requiredSuites = suites;
    plan.fastSuites = [...new Set(FAST_SUITE_ROUTES.map((route) => route.script))];
    return plan;
  }

  const paths = records.flatMap((record) => (record.status[0] === "R" || record.status[0] === "C" ? record.paths : record.paths));
  if (classification.mode === CLASSIFIER_MODES.DOCS_ONLY) {
    plan.mode = RUN_MODES.DOCS;
    plan.docsOnly = true;
    plan.reasons.push("docs_only");
    return plan;
  }

  const matched = matchSuites(suitePaths, paths);
  plan.fastSuites = fastSuitesFor(paths);
  if (matched.length === 0) plan.reasons.push("no_specialist_suite_matched");
  else plan.reasons.push(...matched.map((suite) => `suite:${suite}`));

  if (!tiered) {
    // Rollback path: keep the pre-#836 full PR acceptance for code changes and
    // let every specialist run from its own pull_request trigger.
    plan.reasons.push("ci_pr_mode_full");
    return plan;
  }
  if (draft) {
    plan.mode = RUN_MODES.DRAFT_FAST;
    plan.reasons.push("draft_fast_path");
    return plan;
  }
  plan.reasons.push("ready_for_review_full_path");
  plan.requiredSuites = matched;
  return plan;
}

function readGitDiff(base, head, cwd = process.cwd()) {
  const output = spawnSync("git", ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (output.error || output.status !== 0) throw new Error("git diff failed");
  return output.stdout;
}

/** Load every specialist suite's declared pull-request path filter. */
export function loadSuitePaths(root, workflows = SPECIALIST_WORKFLOWS) {
  const paths = {};
  for (const [suite, file] of Object.entries(workflows)) {
    paths[suite] = readWorkflowPullRequestPaths(readFileSync(`${root}/${file}`, "utf8"));
  }
  return paths;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--event-name") options.eventName = argv[++index];
    else if (argument === "--base") options.base = argv[++index];
    else if (argument === "--head") options.head = argv[++index];
    else if (argument === "--draft") options.draft = argv[++index] === "true";
    else if (argument === "--ci-pr-mode") options.ciPrMode = argv[++index];
    else if (argument === "--root") options.root = argv[++index];
    else if (argument === "--diff-file") options.diffFile = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node agent-harness/ci-run-plan.mjs --event-name <name> [--base <sha> --head <sha>] [--draft true|false] [--ci-pr-mode tiered|full]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function writeGitHubOutput(plan) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, [
    `mode=${plan.mode}`,
    `plan_status=${plan.status}`,
    `docs_only=${plan.docsOnly}`,
    `tiered=${plan.tiered}`,
    `required_suites=${plan.requiredSuites.join(",")}`,
    `fast_suites=${plan.fastSuites.join(",")}`,
    `reasons=${plan.reasons.join(",")}`,
    `base=${plan.base}`,
    `head=${plan.head}`,
  ].join("\n") + "\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root ?? process.cwd();
  const plan = buildRunPlan({
    eventName: options.eventName,
    base: options.base,
    head: options.head,
    draft: options.draft,
    ciPrMode: options.ciPrMode ?? process.env[CI_PR_MODE_VARIABLE],
    suitePaths: loadSuitePaths(root),
    ...(options.diffFile ? { diffBytes: readFileSync(options.diffFile) } : {}),
  });
  writeGitHubOutput(plan);
  console.log(JSON.stringify(plan, null, 2));
  if (plan.status === PLAN_STATUSES.FAILED) process.exitCode = 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();