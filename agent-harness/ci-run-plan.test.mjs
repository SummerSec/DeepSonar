// #836 step 1: the run plan decides which suites a PR run must execute, and
// must never turn a missing/partial diff into a smaller required set.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FAST_SUITE_ROUTES,
  PLAN_STATUSES,
  RUN_MODES,
  SPECIALIST_WORKFLOWS,
  buildRunPlan,
  explainRunPlan,
  CHROME_FUZZ_ARM_PINNED_INPUTS,
  chromeFuzzArmRequirement,
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
  assert.deepEqual(SUITES, ["chrome", "mobile", "openharmony", "reverse"]);
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
      if (suite === "reverse" && id === "reverse-runtime-acceptance") {
        assert.deepEqual(job.needs, ["plan", "reverse-runtime-images", "claude-budget-acceptance", "pi-om-acceptance"]);
        assert.equal(job.if, "always() && (needs.plan.result != 'success' || needs.plan.outputs.mode == 'ready-full')");
        assert.equal(job.strategy, undefined, "the summary must not start another heavy matrix");
        assert.equal(job.services, undefined, "the summary must not start services");
        assert.equal(job["continue-on-error"], undefined);
        // #976: the summary verifies each planned suite instead of blindly
        // requiring every matrix, so the step and its assertions moved.
        const step = job.steps.find((candidate) => candidate.name === "Require every planned native acceptance matrix");
        assert.ok(step, "the summary must verify all dependency results");
        assert.equal(step["continue-on-error"], undefined);
        for (const [variable, dependency] of [
          ["PLAN", "plan"], ["REVERSE", "reverse-runtime-images"],
          ["CLAUDE", "claude-budget-acceptance"], ["PI_OM", "pi-om-acceptance"],
        ]) {
          assert.equal(step.env[`${variable}_RESULT`], "${{ needs." + dependency + ".result }}");
        }
        assert.equal(step.env.PLANNED_SUITES, "${{ needs.plan.outputs.reverse_suites }}");
        for (const suite of ["reverse", "claude", "pi-om"]) {
          assert.ok(step.run.includes(`$(planned ${suite})`), `the summary must gate ${suite} on the plan`);
        }
        assert.ok(step.run.includes('[ "$PLAN_RESULT" = success ]'), "a failed plan cannot satisfy the summary");
        continue;
      }
      // #976: Reverse jobs also wait for the optional shared base artifact.
      const needs = [job.needs].flat();
      assert.ok(needs.includes("plan"), `${suite}/${id} must depend on the plan`);
      assert.match(job.if, /needs\.plan\.outputs\.mode == 'ready-full'/, `${suite}/${id} must skip on Draft`);
    }
    // #836 review (P1): a same-SHA Draft -> Ready transition must re-plan and run
    // the matrix, so the workflow has to subscribe to ready_for_review. GitHub's
    // default activity types are only opened/synchronize/reopened.
    const types = workflow.on.pull_request.types;
    for (const required of ["opened", "reopened", "synchronize", "ready_for_review"]) {
      assert.ok(Array.isArray(types) && types.includes(required), `${suite} must trigger on ${required}`);
    }
    assert.ok(workflow.on.pull_request.paths, `${suite} must keep its path filter`);
    // push@main and manual runs still verify the full matrix.
    assert.ok(workflow.on.push, `${suite} must keep push@main`);
    assert.ok("workflow_dispatch" in workflow.on, `${suite} must keep a manual entry`);
  }
});

// #961: the Chrome Fuzz V8 ARM build+smoke gate is expensive, so unrelated Ready
// PRs must not start it — but every "skip" answer must be explainable, and any
// input that can invalidate the build must keep it required.
test("#961 Chrome Fuzz ARM gate is required by its own inputs", () => {
  for (const path of [
    "deploy/Dockerfile.agent-chrome-fuzz",
    "deploy/chrome-fuzz-env.sh",
    "agent-harness/chrome-fuzz-runtime.json",
  ]) {
    assert.equal(
      chromeFuzzArmRequirement({ status: PLAN_STATUSES.OK, mode: RUN_MODES.READY_FULL, paths: [path], suitePaths: SUITE_PATHS }).required,
      true,
      `${path} must keep the ARM gate required`,
    );
  }
});

test("#961 base image, fingerprint and routing inputs keep the ARM gate required", () => {
  for (const path of CHROME_FUZZ_ARM_PINNED_INPUTS) {
    const probe = path.endsWith("/**") ? path.replace("**", "some.md") : path;
    const verdict = chromeFuzzArmRequirement({
      status: PLAN_STATUSES.OK, mode: RUN_MODES.READY_FULL, paths: [probe], suitePaths: SUITE_PATHS,
    });
    assert.equal(verdict.required, true, `${probe} must keep the ARM gate required`);
    assert.ok(verdict.reason.length > 0);
  }
});

test("#961 unrelated business changes skip the ARM gate with an explicit reason", () => {
  const plan = buildRunPlan({
    ...pr, draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(change("apps/scheduler/src/dispatcher.ts"), change("apps/web/src/App.tsx")),
  });
  assert.equal(plan.mode, RUN_MODES.READY_FULL);
  assert.equal(plan.chromeFuzzArm, false);
  assert.ok(plan.reasons.includes("chrome_fuzz_inputs_unchanged"));
});

test("#961 unknown, transitive base and missing inputs never authorize an ARM skip", () => {
  for (const paths of [
    ["some/new/tool.txt"],
    ["agent-harness/dsh-runtime/package-lock.json"],
    ["agent-harness/pi-observational-memory-governed.ts"],
    ["packages/runtime-sandbox/src/dsh-request-budget.ts"],
    [".github/ci/prepare-hosted-runner-disk.mjs"],
    ["apps/web/src/App.tsx", "some/new/tool.txt"],
  ]) {
    const plan = buildRunPlan({
      ...pr, draft: false, suitePaths: SUITE_PATHS,
      diffBytes: diff(...paths.map(change)),
    });
    assert.equal(plan.chromeFuzzArm, true, paths.join(", "));
    assert.ok(plan.reasons.includes("chrome_fuzz_unknown_input_fail_closed"));
  }
  for (const record of [
    ["D", "unknown/build-input.txt"],
    ["R100", "unknown/build-input.txt", "apps/web/src/input.txt"],
    ["R100", "apps/web/src/input.txt", "unknown/build-input.txt"],
  ]) {
    assert.equal(buildRunPlan({ ...pr, suitePaths: SUITE_PATHS, diffBytes: diff(record) }).chromeFuzzArm, true);
  }
  assert.equal(buildRunPlan({ ...pr, suitePaths: SUITE_PATHS, diffBytes: Buffer.alloc(0) }).chromeFuzzArm, true);
  assert.equal(buildRunPlan({ ...pr, diffBytes: diff(change("apps/web/src/App.tsx")) }).chromeFuzzArm, true);

  const businessAndDocs = buildRunPlan({
    ...pr, suitePaths: SUITE_PATHS,
    diffBytes: diff(change("apps/web/src/App.tsx"), change("docs/README.md")),
  });
  assert.equal(businessAndDocs.chromeFuzzArm, false);
});

test("#961 actual CLI writes fail-closed ARM outputs, not just helper verdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepsonar-arm-plan-"));
  try {
    const cases = [
      { args: ["--event-name", "push"], required: true, status: 0 },
      { args: ["--event-name", "workflow_dispatch"], required: true, status: 0 },
      { args: ["--event-name", "pull_request"], required: true, status: 1 },
      { bytes: Buffer.from("M\0unknown/input"), required: true, status: 1 },
      { bytes: diff(change("unknown/input")), required: true, status: 0 },
      { bytes: diff(change("apps/web/src/App.tsx")), required: false, status: 0 },
    ];
    for (const [index, entry] of cases.entries()) {
      const output = join(dir, `output-${index}`);
      const input = join(dir, `diff-${index}`);
      const args = entry.args ?? ["--event-name", "pull_request", "--base", "base", "--head", "head", "--diff-file", input];
      if (entry.bytes) writeFileSync(input, entry.bytes);
      const run = spawnSync(process.execPath, [join(ROOT, "agent-harness/ci-run-plan.mjs"), ...args, "--root", ROOT, "--ci-pr-mode", "tiered"], {
        cwd: ROOT, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8",
      });
      assert.equal(run.status, entry.status, run.stderr);
      const plan = JSON.parse(run.stdout);
      assert.equal(plan.chromeFuzzArm, entry.required);
      assert.match(readFileSync(output, "utf8"), new RegExp(`^chrome_fuzz_arm=${entry.required ? "required" : "skipped"}$`, "m"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#961 the ARM gate cannot be skipped by a failed or unreadable diff", () => {
  const missingRevision = buildRunPlan({ eventName: "pull_request", base: "", head: "", suitePaths: SUITE_PATHS });
  assert.equal(missingRevision.status, PLAN_STATUSES.FAILED);
  assert.equal(missingRevision.chromeFuzzArm, true);
  assert.ok(missingRevision.reasons.includes("chrome_fuzz_plan_failed_fail_closed"));

  const failedClassifier = buildRunPlan({
    ...pr, draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(change("apps/web/src/App.tsx")),
    classifier: { status: "failed", reason: "synthetic" },
  });
  assert.equal(failedClassifier.status, PLAN_STATUSES.FAILED);
  assert.equal(failedClassifier.chromeFuzzArm, true);
});

test("#961 docs-only, Draft and full-mode rollback each answer deterministically", () => {
  const docs = buildRunPlan({ ...pr, draft: false, suitePaths: SUITE_PATHS, diffBytes: diff(change("docs/README.md")) });
  assert.equal(docs.mode, RUN_MODES.DOCS);
  assert.equal(docs.chromeFuzzArm, false);

  const draft = buildRunPlan({ ...pr, draft: true, suitePaths: SUITE_PATHS, diffBytes: diff(change("apps/web/src/App.tsx")) });
  assert.equal(draft.mode, RUN_MODES.DRAFT_FAST);
  assert.equal(draft.chromeFuzzArm, false);

  const full = buildRunPlan({
    ...pr, ciPrMode: "full", draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(change("apps/web/src/App.tsx")),
  });
  assert.equal(full.chromeFuzzArm, true, "the pre-#836 rollback path never narrows the ARM gate");
  assert.ok(full.reasons.includes("chrome_fuzz_required_full_mode"));

  const nonPr = buildRunPlan({ eventName: "push", suitePaths: SUITE_PATHS });
  assert.equal(nonPr.chromeFuzzArm, true);
});

test("#961 a deleted or renamed Chrome fuzz input still keeps the ARM gate required", () => {
  const deleted = buildRunPlan({
    ...pr, draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(["D", "deploy/Dockerfile.agent-chrome-fuzz"]),
  });
  assert.equal(deleted.chromeFuzzArm, true);

  const renamed = buildRunPlan({
    ...pr, draft: false, suitePaths: SUITE_PATHS,
    diffBytes: diff(["R100", "deploy/chrome-fuzz-smoke.sh", "deploy/chrome-fuzz-smoke-v2.sh"]),
  });
  assert.equal(renamed.chromeFuzzArm, true);
});

// #961: the plan alone changes nothing — the workflow must consume it, and the
// summary must judge the ARM pair by the plan instead of requiring them always.
test("#961 ci.yml wires the Chrome Fuzz ARM gate to the run plan", () => {
  const workflow = readFileSync(`${ROOT}/.github/workflows/ci.yml`, "utf8");
  assert.match(workflow, /chrome_fuzz_arm: \$\{\{ steps\.plan\.outputs\.chrome_fuzz_arm \}\}/u);
  assert.match(workflow, /needs\.changes\.outputs\.chrome_fuzz_arm == 'required'/u);
  const armGateCount = (workflow.match(/needs\.changes\.outputs\.chrome_fuzz_arm == 'required'/gu) ?? []).length;
  assert.ok(armGateCount >= 2, "both the ARM build and its native smoke must be gated by the plan");
  assert.match(workflow, /FUZZ_ARM_REQUIRED: \$\{\{ needs\.changes\.outputs\.chrome_fuzz_arm \}\}/u);
  assert.match(workflow, /missing or invalid chrome_fuzz_arm output/u);
  assert.match(workflow, /check_planned chrome-fuzz-arm64-build/u);
  assert.match(workflow, /check_planned chrome-fuzz-arm64/u);
  // 失败/取消必须在 check_planned 里先被拒绝，不能被「计划说可跳过」吞掉。
  assert.match(workflow, /failure\|cancelled\) fail "\$name did not complete cleanly/u);
});

// #976: the run plan now carries the Reverse-family sub-suite decision, and the
// package.json field-level check is what allows an independent test script to
// avoid the three heavy native matrices.
test("#976 the run plan carries a fail-closed Reverse sub-suite decision", () => {
  const diff = (...records) => Buffer.from(records.flat().join("\0") + "\0", "utf8");
  const record = (status, path) => [status, path];
  const base = { ...pr, suitePaths: SUITE_PATHS };

  const shared = buildRunPlan({ ...base, diffBytes: diff(record("M", "packages/runtime-sandbox/src/a.ts")) });
  assert.deepEqual(shared.reverseSuites, ["reverse", "claude", "pi-om"], "a shared base input keeps every suite");

  const claudeOnly = buildRunPlan({ ...base, diffBytes: diff(record("M", "agent-harness/run-claude-budget-isolated.mjs")) });
  assert.deepEqual(claudeOnly.reverseSuites, ["claude"]);

  const docs = buildRunPlan({ ...base, diffBytes: diff(record("M", "docs/README.md")) });
  assert.deepEqual(docs.reverseSuites, []);

  // package.json alone: readable and purely additive => nothing heavy.
  const packageJsonBase = JSON.stringify({ scripts: { "ci:unit:x": "node --test a.test.mjs" } });
  const packageJsonHead = JSON.stringify({
    scripts: {
      "ci:unit:x": "node --test a.test.mjs",
      "ci:unit:runtime-timing": "node --test agent-harness/runtime-build-timing.test.mjs",
    },
  });
  const independent = buildRunPlan({
    ...base,
    diffBytes: diff(record("M", "package.json")),
    packageJsonBase,
    packageJsonHead,
  });
  assert.deepEqual(independent.reverseSuites, [], "an independent added test script must not start the heavy matrices");

  // Same diff without readable contents must keep every suite (fail closed).
  const unknown = buildRunPlan({ ...base, diffBytes: diff(record("M", "package.json")) });
  assert.deepEqual(unknown.reverseSuites, ["reverse", "claude", "pi-om"]);
});

// #992: the plan must explain itself in the summary instead of leaving reviewers
// to decode a comma-separated token list.
test("#992 the plan explanation renders the decision and its reasons", () => {
  const plan = buildRunPlan({ ...pr, diffBytes: diff(change("agent-harness/run-claude-budget-isolated.mjs")), suitePaths: SUITE_PATHS });
  const text = explainRunPlan(plan);
  assert.match(text, /### CI 运行计划/);
  assert.match(text, new RegExp(`\\| 模式 \\| \`${plan.mode}\` \\|`, "u"));
  assert.match(text, new RegExp(`\\| 计划状态 \\| \`${plan.status}\` \\|`, "u"));
  assert.match(text, /\| tiered 分层 \| 启用 \|/u);
  // Every emitted token appears verbatim, so the summary never hides a reason.
  for (const reason of plan.reasons) assert.ok(text.includes(`\`${reason}\``), `${reason} must be quoted verbatim`);
  // Known tokens are decoded; the raw token stays next to its explanation.
  assert.match(text, /`ready_for_review_full_path`：Ready PR：走完整验收/u);
  assert.match(text, /`suite:reverse`：命中专项 workflow：reverse/u);
  assert.match(text, /`reverse:reverse_suite:claude`：计划执行 Reverse 子套件：claude/u);
  // Planned vs skipped suites are stated explicitly.
  assert.match(text, /\*\*Reverse 子套件\*\*：`claude`/u);
  assert.match(text, /\*\*Reverse 跳过\*\*：`reverse`、`pi-om`/u);
});

test("#992 unknown reasons stay visible instead of being dropped", () => {
  const text = explainRunPlan({ mode: "ready-full", status: "ok", reasons: ["some_new_reason:detail"] });
  assert.match(text, /`some_new_reason:detail`：未登记原因：some_new_reason:detail/u);
});

test("#992 a plan without reasons says so instead of implying a clean skip", () => {
  const text = explainRunPlan({ mode: "ready-full", status: "ok", reasons: [] });
  assert.match(text, /无（计划未记录原因，按 fail closed 处理）/u);
  assert.match(text, /\*\*Reverse 子套件\*\*：全部跳过/u);
});

// #992 review P2: the first version of this test hand-built the token
// `reverse:package_json_field_changed:dependencies`, which the real chain never
// emits. Build the plan instead so the double prefix
// (`reverse:` + `reverse_package_json_` + `package_json_*`) is exercised.
function packageJsonPlan(base, head, path = "package.json") {
  return buildRunPlan({
    ...pr,
    diffBytes: diff(change(path)),
    suitePaths: SUITE_PATHS,
    packageJsonBase: typeof base === "string" ? base : JSON.stringify(base),
    packageJsonHead: typeof head === "string" ? head : JSON.stringify(head),
  });
}

test("#992 a package.json field change decodes through the real reason chain", () => {
  const plan = packageJsonPlan({ name: "x", dependencies: { a: "1" } }, { name: "x", dependencies: { a: "2" } });
  const token = plan.reasons.find((reason) => reason.includes("package_json_field_changed"));
  assert.equal(token, "reverse:reverse_package_json_package_json_field_changed:dependencies",
    "the token carries the wrapper prefixes the decoder must strip");
  const text = explainRunPlan(plan);
  assert.ok(text.includes(`\`${token}\``), "the raw token stays visible");
  assert.match(text, /package\.json 字段变化（dependencies）：Reverse 全跑/u);
  assert.doesNotMatch(text, /未登记原因/u);
});

test("#992 a removed script and an unparseable package.json decode too", () => {
  const removed = packageJsonPlan({ scripts: { "ci:unit:a": "node --test a.test.mjs" } }, { scripts: {} });
  assert.match(explainRunPlan(removed), /package\.json 删除了脚本（ci:unit:a）：Reverse 全跑/u);

  const broken = packageJsonPlan("{not json", "{}");
  assert.match(explainRunPlan(broken), /package\.json 无法解析：Reverse 全跑/u);
});

test("#992 a shared Reverse input decodes to the fail-closed reason", () => {
  const plan = buildRunPlan({ ...pr, diffBytes: diff(change("packages/runtime-sandbox/src/a.ts")), suitePaths: SUITE_PATHS });
  const token = plan.reasons.find((reason) => reason.endsWith("reverse_shared_inputs_changed"));
  assert.ok(token, `expected a shared-input reason, got ${plan.reasons.join(",")}`);
  assert.match(explainRunPlan(plan), /命中 Reverse 共享输入（base\/锁文件\/runtime-sandbox 等）：全跑/u);
});

// #992 review P2: an empty Reverse suite list has three different causes, so the
// skip sentence must follow the mode instead of always claiming "proven unrelated".
test("#992 the skip sentence names the real reason for each mode", () => {
  const draft = buildRunPlan({
    ...pr, draft: true,
    diffBytes: diff(change("packages/runtime-sandbox/src/a.ts")), suitePaths: SUITE_PATHS,
  });
  assert.equal(draft.mode, "draft-fast");
  assert.deepEqual(draft.reverseSuites, []);
  assert.match(explainRunPlan(draft), /\*\*Reverse 跳过\*\*：[^\n]*（原因：Draft PR 只跑 draft-fast 快速套件）/u);

  const docs = buildRunPlan({ ...pr, diffBytes: diff(change("docs/README.md")), suitePaths: SUITE_PATHS });
  assert.equal(docs.mode, "docs");
  assert.match(explainRunPlan(docs), /（原因：纯文档变更）/u);

  const unrelated = buildRunPlan({ ...pr, diffBytes: diff(change("apps/web/src/main.tsx")), suitePaths: SUITE_PATHS });
  assert.equal(unrelated.mode, "ready-full");
  assert.deepEqual(unrelated.reverseSuites, []);
  assert.match(explainRunPlan(unrelated), /（原因：改动都落在 Reverse 输入之外，已证明无关）/u);
});

test("#992 the CLI writes the explanation to GITHUB_STEP_SUMMARY", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-summary-"));
  const summary = join(dir, "summary.md");
  const output = join(dir, "output.txt");
  writeFileSync(summary, "");
  try {
    const diffFile = join(dir, "diff.bin");
    writeFileSync(diffFile, diff(change("agent-harness/run-claude-budget-isolated.mjs")));
    const result = spawnSync(process.execPath, [join(ROOT, "agent-harness/ci-run-plan.mjs"), "--event-name", "pull_request",
      "--base", "b", "--head", "h", "--ci-pr-mode", "tiered", "--root", ROOT, "--diff-file", diffFile], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const written = readFileSync(summary, "utf8");
    assert.match(written, /### CI 运行计划/u);
    assert.match(written, /判定依据/u);
    assert.match(readFileSync(output, "utf8"), /reverse_suites=claude/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
