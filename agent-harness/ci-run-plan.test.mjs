// #836 step 1: the run plan decides which suites a PR run must execute, and
// must never turn a missing/partial diff into a smaller required set.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  FAST_SUITE_ROUTES,
  PLAN_STATUSES,
  RUN_MODES,
  SPECIALIST_WORKFLOWS,
  buildRunPlan,
  isTiered,
  loadSuitePaths,
  matchSuites,
  matchesPathPattern,
  readWorkflowPullRequestPaths,
} from "./ci-run-plan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const diff = (...records) => Buffer.from(records.flat().join("\0") + "\0", "utf8");
const change = (path) => ["M", path];
const pr = { eventName: "pull_request", base: "base-sha", head: "head-sha", ciPrMode: "tiered" };
const SUITE_PATHS = loadSuitePaths(ROOT);
const SUITES = Object.keys(SUITE_PATHS).sort();

test("specialist suite paths are read from the workflows that own them", () => {
  assert.deepEqual(SUITES, ["chrome", "clickhouse", "mobile", "openharmony", "reverse"]);
  for (const suite of SUITES) {
    assert.ok(SUITE_PATHS[suite].length > 3, `${suite} must keep its declared filter`);
    assert.ok(!SUITE_PATHS[suite].includes("**"), `${suite} must not be widened to a catch-all`);
  }
  assert.ok(SUITE_PATHS.reverse.includes("packages/runtime-sandbox/**"));
  assert.ok(SUITE_PATHS.chrome.includes("deploy/Dockerfile.agent-chrome-*"));
  assert.ok(SUITE_PATHS.mobile.some((pattern) => pattern.includes("openharmony-hdc")), "HDC vendor must hit Mobile");
  // ci.yml itself has no pull_request.paths; the plan must not invent one.
  assert.deepEqual(readWorkflowPullRequestPaths(readFileSync(`${ROOT}/.github/workflows/ci.yml`, "utf8")), []);
});

test("workflow path patterns are matched literally, per segment", () => {
  assert.equal(matchesPathPattern("packages/runtime-sandbox/**", "packages/runtime-sandbox/src/index.ts"), true);
  // `dir/**` selects everything *inside* the directory, not the directory entry.
  assert.equal(matchesPathPattern("packages/runtime-sandbox/**", "packages/runtime-sandbox"), false);
  assert.equal(matchesPathPattern("packages/runtime-sandbox/**", "packages/runtime-sandbox-other/x.ts"), false);
  assert.equal(matchesPathPattern("deploy/Dockerfile.agent*", "deploy/Dockerfile.agent"), true);
  assert.equal(matchesPathPattern("deploy/Dockerfile.agent*", "deploy/Dockerfile.agent-reverse"), true);
  assert.equal(matchesPathPattern("apps/scheduler/src/dispatcher*.ts", "apps/scheduler/src/dispatcher-core.ts"), true);
  assert.equal(matchesPathPattern("apps/scheduler/src/dispatcher*.ts", "apps/scheduler/src/domains/dispatcher.ts"), false);
  assert.equal(matchesPathPattern("package.json", "package.json"), true);
  assert.equal(matchesPathPattern("docs/README.md", "docs/README.md.bak"), false);
});

test("each specialist suite is hit by its own inputs and missed by unrelated ones", () => {
  // Derive one representative path from each suite's own filter instead of
  // hard-coding a second copy of the matrices.
  for (const suite of SUITES) {
    const sample = SUITE_PATHS[suite][0].replaceAll("*", "x");
    assert.ok(matchSuites(SUITE_PATHS, [sample]).includes(suite), `${suite} representative path must hit`);
  }
  const allMatched = matchSuites(SUITE_PATHS, [
    "packages/runtime-sandbox/src/sandbox.ts",
    "deploy/Dockerfile.chrome-audit",
    "deploy/Dockerfile.clickhouse-test",
    "deploy/Dockerfile.mobile-test",
    "deploy/Dockerfile.openharmony-test",
  ]);
  assert.deepEqual(allMatched, SUITES.filter((suite) => allMatched.includes(suite)));
  assert.ok(allMatched.length >= 1);
  assert.deepEqual(matchSuites(SUITE_PATHS, ["docs/README.md"]), []);
  assert.deepEqual(matchSuites(SUITE_PATHS, ["apps/web/src/App.tsx"]), []);
});

test("docs-only changes plan a docs run with no heavy or specialist work", () => {
  const plan = buildRunPlan({ ...pr, draft: true, diffBytes: diff(change("docs/README.md")) });
  assert.equal(plan.mode, RUN_MODES.DOCS);
  assert.equal(plan.docsOnly, true);
  assert.deepEqual(plan.requiredSuites, []);
  assert.equal(plan.status, PLAN_STATUSES.OK);
});

test("a Draft PR plans the fast path and defers every specialist suite", () => {
  const plan = buildRunPlan({ ...pr, draft: true, suitePaths: SUITE_PATHS, diffBytes: diff(change("packages/runtime-sandbox/src/index.ts")) });
  assert.equal(plan.mode, RUN_MODES.DRAFT_FAST);
  assert.equal(plan.docsOnly, false);
  assert.deepEqual(plan.requiredSuites, []);
  assert.ok(plan.reasons.includes("draft_fast_path"));
  assert.ok(plan.fastSuites.length === 0, "runtime-sandbox has no no-service fast route");
});

test("a Ready PR runs full acceptance plus the specialist suites its diff hits", () => {
  const plan = buildRunPlan({
    ...pr, draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(change("packages/runtime-sandbox/src/index.ts"), change("apps/web/src/App.tsx")),
  });
  assert.equal(plan.mode, RUN_MODES.READY_FULL);
  assert.deepEqual(plan.requiredSuites, ["reverse"]);
  assert.deepEqual(plan.fastSuites, ["ci:unit:web-facts"]);
  assert.ok(plan.reasons.includes("suite:reverse"));
});

test("mixed, moved and unknown inputs only ever widen the plan", () => {
  const moved = buildRunPlan({
    ...pr, draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(["R100", "packages/runtime-sandbox/src/old.ts", "docs/README.md"]),
  });
  assert.equal(moved.docsOnly, false);
  assert.equal(moved.mode, RUN_MODES.READY_FULL);

  const unknown = buildRunPlan({
    ...pr, draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(change("some/new/tool.txt")),
  });
  assert.deepEqual(unknown.requiredSuites, []);
  assert.deepEqual(unknown.fastSuites, []);
  assert.ok(unknown.reasons.includes("no_specialist_suite_matched"));
  assert.equal(unknown.mode, RUN_MODES.READY_FULL, "an unmatched code path still runs the full gate");

  const deleted = buildRunPlan({ ...pr, draft: true, suitePaths: SUITE_PATHS, diffBytes: diff(["D", "deploy/Dockerfile.chrome-test"]) });
  assert.equal(deleted.mode, RUN_MODES.DRAFT_FAST, "draft never runs specialists");
});

test("missing revisions, unreadable diffs and empty diffs fail closed onto every suite", () => {
  for (const input of [
    { ...pr, draft: false, base: "", suitePaths: SUITE_PATHS },
    { ...pr, draft: false, suitePaths: SUITE_PATHS, diffBytes: undefined },
  ]) {
    const plan = buildRunPlan({ head: "head-sha", ...input });
    assert.equal(plan.status, PLAN_STATUSES.FAILED);
    assert.deepEqual(plan.requiredSuites, SUITES);
    assert.equal(plan.mode, RUN_MODES.READY_FULL);
    assert.ok(plan.fastSuites.length > 0);
  }

  const empty = buildRunPlan({ ...pr, draft: false, suitePaths: SUITE_PATHS, diffBytes: Buffer.alloc(0) });
  assert.equal(empty.mode, RUN_MODES.READY_FULL);
  assert.equal(empty.status, PLAN_STATUSES.OK);
  assert.deepEqual(empty.requiredSuites, []);
});

test("a failed classifier widens the plan instead of granting a fast path", () => {
  const plan = buildRunPlan({
    ...pr, draft: true, suitePaths: SUITE_PATHS, diffBytes: diff(change("apps/web/src/App.tsx")),
    classifier: { mode: "full", status: "failed", reason: "diff_read_failed", changedCount: 1 },
  });
  assert.equal(plan.status, PLAN_STATUSES.FAILED);
  assert.equal(plan.mode, RUN_MODES.READY_FULL);
  assert.deepEqual(plan.requiredSuites, SUITES);
  assert.equal(plan.docsOnly, false);
});

test("non-PR events never claim a tier and never call specialists", () => {
  for (const eventName of ["push", "workflow_dispatch", undefined]) {
    const plan = buildRunPlan({ eventName, ciPrMode: "tiered", suitePaths: SUITE_PATHS });
    assert.equal(plan.mode, RUN_MODES.READY_FULL);
    assert.deepEqual(plan.requiredSuites, []);
    assert.ok(plan.reasons.includes("non_pull_request_event"));
  }
});

test("CI_PR_MODE restores full PR acceptance before the tier ships", () => {
  for (const ciPrMode of [undefined, "", "full", "off", "TIERED-ish", " tiered-but-not"]) {
    assert.equal(isTiered(ciPrMode), false, String(ciPrMode));
    const plan = buildRunPlan({ ...pr, ciPrMode, draft: true, suitePaths: SUITE_PATHS, diffBytes: diff(change("packages/runtime-sandbox/src/index.ts")) });
    assert.equal(plan.mode, RUN_MODES.READY_FULL, `${String(ciPrMode)} must not shortcut a code PR`);
    assert.deepEqual(plan.requiredSuites, [], "specialists keep their own pull_request triggers in full mode");
    assert.ok(plan.reasons.includes("ci_pr_mode_full"));
    assert.equal(plan.docsOnly, false);
  }
  assert.equal(isTiered("tiered"), true);
  // The pure-docs exception survives the rollback switch.
  const docs = buildRunPlan({ ...pr, ciPrMode: "full", diffBytes: diff(change("docs/README.md")) });
  assert.equal(docs.mode, RUN_MODES.DOCS);
});

test("every draft fast route is a real no-service script", () => {
  const scripts = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).scripts;
  for (const route of FAST_SUITE_ROUTES) {
    assert.ok(["ci:unit:web-facts", "ci:unit:bounded-contexts", "ci:unit:finding-protocol", "ci:unit:deploy-ps1"].includes(route.script), route.script);
    assert.ok(scripts[route.script], `missing pnpm script for ${route.script}`);
    assert.ok(route.paths.every((pattern) => pattern.endsWith("/**")), `${route.script} must scope to a directory`);
  }
  assert.deepEqual(Object.keys(SPECIALIST_WORKFLOWS).sort(), SUITES);
});
test("every specialist workflow gates its heavy matrix on the same run plan", () => {
  const { parse } = createRequire(new URL("../apps/scheduler/package.json", import.meta.url))("yaml");
  for (const [suite, file] of Object.entries(SPECIALIST_WORKFLOWS)) {
    const workflow = parse(readFileSync(`${ROOT}/${file}`, "utf8"));
    assert.ok(workflow.jobs.plan, `${suite} must run the shared plan`);
    const planStep = workflow.jobs.plan.steps.find((step) => step.id === "plan");
    assert.ok(planStep.run.includes("ci-run-plan.mjs"), `${suite} must reuse the shared plan script`);
    assert.equal(workflow.jobs.plan.outputs.mode, "${{ steps.plan.outputs.mode }}");
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id === "plan") continue;
      assert.deepEqual(job.needs, "plan", `${suite}/${id} must depend on the plan`);
      assert.match(job.if, /needs\.plan\.outputs\.mode == 'ready-full'/, `${suite}/${id} must skip on Draft`);
    }
    // push@main and manual runs still verify the full matrix.
    assert.ok(workflow.on.push, `${suite} must keep push@main`);
    assert.ok("workflow_dispatch" in workflow.on, `${suite} must keep a manual entry`);
  }
});
