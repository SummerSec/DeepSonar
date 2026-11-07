// #976: the Reverse-family plan must only narrow when the evidence proves it,
// and every failure mode must keep all three suites required.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REVERSE_ROUTING_INPUTS,
  REVERSE_SHARED_INPUTS,
  REVERSE_SUITES,
  REVERSE_SUITE_INPUTS,
  SPECIALIST_CONSUMED_SCRIPTS,
  classifyPackageJsonChange,
  planReverseSuites,
  verifyReverseSuiteResults,
} from "./reverse-suite-plan.mjs";
import { matchesPathPattern } from "./path-match.mjs";
import { buildRunPlan, loadSuitePaths } from "./ci-run-plan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(`${ROOT}/.github/workflows/reverse-runtime.yml`, "utf8");

const ready = {
  status: "ok",
  mode: "ready-full",
  tiered: true,
  eventName: "pull_request",
};
const plan = (overrides = {}) => planReverseSuites({ ...ready, ...overrides });
const record = (status, ...paths) => ({ status, paths });
const pkg = (scripts, extra = {}) => JSON.stringify({ name: "x", scripts, ...extra });

test("no evidence of a Reverse input keeps all three suites required", () => {
  assert.deepEqual(plan().suites, REVERSE_SUITES, "empty path set is fail closed");
  assert.deepEqual(plan({ paths: [] }).suites, REVERSE_SUITES);
  assert.deepEqual(plan({ status: "failed" }).suites, REVERSE_SUITES);
  assert.deepEqual(plan({ tiered: false }).suites, REVERSE_SUITES, "full mode keeps every specialist");
  assert.deepEqual(plan({ eventName: "push" }).suites, REVERSE_SUITES, "push@main keeps full coverage");
  assert.deepEqual(plan({ eventName: "workflow_dispatch" }).suites, REVERSE_SUITES);
});

test("docs and draft tiers skip the heavy suites", () => {
  assert.deepEqual(plan({ mode: "docs" }).suites, []);
  assert.deepEqual(plan({ mode: "draft-fast" }).suites, []);
});

test("each suite is hit by its own inputs and only its own", () => {
  assert.deepEqual(plan({ paths: ["agent-harness/run-claude-budget-isolated.mjs"] }).suites, ["claude"]);
  assert.deepEqual(plan({ paths: ["agent-harness/pi-observational-memory-governed.ts"] }).suites, ["pi-om"]);
  assert.deepEqual(plan({ paths: ["agent-harness/rea-runtime/loop.ts"] }).suites, ["reverse"]);
  assert.deepEqual(plan({ paths: ["skills/deepsonar-rea-cli/SKILL.md"] }).suites, ["reverse"]);
  assert.deepEqual(
    plan({ paths: ["agent-harness/run-claude-budget-isolated.mjs", "agent-harness/rea-runtime/loop.ts"] }).suites,
    ["reverse", "claude"],
  );
});

test("shared base, lockfile, sandbox and routing inputs force every suite", () => {
  for (const path of [
    "deploy/Dockerfile.agent",
    "packages/runtime-sandbox/src/sandbox.ts",
    "pnpm-lock.yaml",
    ".dockerignore",
    "deploy/opensandbox/config.toml",
    ".github/ci/prepare-hosted-runner-disk.mjs",
    ".github/workflows/release.yml",
    ".github/workflows/reverse-runtime.yml",
    "agent-harness/ci-run-plan.mjs",
    "agent-harness/classify-ci-changes.mjs",
    "agent-harness/path-match.mjs",
    "agent-harness/reverse-suite-plan.mjs",
    "agent-harness/reverse-base-identity.mjs",
  ]) {
    assert.deepEqual(plan({ paths: [path] }).suites, REVERSE_SUITES, `${path} must keep every suite`);
  }
  // The routing lists may not drift from what the plan actually honours.
  assert.ok(REVERSE_ROUTING_INPUTS.includes("agent-harness/reverse-suite-plan.mjs"));
  assert.ok(REVERSE_SHARED_INPUTS.includes("pnpm-lock.yaml"));
});

test("delete, rename and copy records fail closed", () => {
  for (const status of ["D", "R100", "C75"]) {
    assert.deepEqual(
      plan({ paths: ["agent-harness/run-claude-budget-isolated.mjs"], records: [record(status, "a", "b")] }).suites,
      REVERSE_SUITES,
      `${status} must keep every suite`,
    );
  }
});

test("unrelated and docs-only paths plan no heavy suite", () => {
  assert.deepEqual(plan({ paths: ["docs/README.md"], records: [record("M", "docs/README.md")] }).suites, []);
  assert.deepEqual(plan({ paths: ["apps/web/src/App.tsx"], records: [record("M", "apps/web/src/App.tsx")] }).suites, []);
});

test("an added independent test script in package.json is not a specialist input", () => {
  const base = pkg({ "ci:unit:x": "node --test a.test.mjs" });
  const head = pkg({
    "ci:unit:x": "node --test a.test.mjs",
    "ci:unit:runtime-timing": "node --test agent-harness/runtime-build-timing.test.mjs",
  });
  const impact = classifyPackageJsonChange({ baseText: base, headText: head });
  assert.equal(impact.impact, "none");
  assert.deepEqual(plan({ paths: ["package.json"], records: [record("M", "package.json")], packageJsonImpact: impact.impact }).suites, []);
});

test("package.json changes that cannot be proven independent force every suite", () => {
  const cases = [
    ["dependency added", pkg({ "ci:unit:x": "node --test a.test.mjs" }), pkg({ "ci:unit:x": "node --test a.test.mjs" }, { dependencies: { left: "1.0.0" } })],
    ["script modified", pkg({ "ci:unit:x": "node --test a.test.mjs" }), pkg({ "ci:unit:x": "node --test b.test.mjs" })],
    ["script removed", pkg({ "ci:unit:x": "node --test a.test.mjs" }), pkg({})],
    ["non-test script added", pkg({}), pkg({ build: "tsc -p ." })],
    ["consumed script added", pkg({}), pkg({ "ci:integration:rea-job": "node --test a.test.mjs" })],
    ["test script without --test", pkg({}), pkg({ "ci:unit:y": "node run.mjs" })],
    ["unparseable head", pkg({}), "{not json"],
    ["missing base", undefined, pkg({})],
    ["array payload", "[]", pkg({})],
  ];
  for (const [label, baseText, headText] of cases) {
    const impact = classifyPackageJsonChange({ baseText, headText });
    assert.equal(impact.impact, "full", `${label} must be full`);
    assert.deepEqual(
      plan({ paths: ["package.json"], records: [record("M", "package.json")], packageJsonImpact: impact.impact }).suites,
      REVERSE_SUITES,
      `${label} must keep every suite`,
    );
  }
});

test("a package.json-only diff without readable contents fails closed", () => {
  assert.deepEqual(plan({ paths: ["package.json"], records: [record("M", "package.json")], packageJsonImpact: "full" }).suites, REVERSE_SUITES);
  assert.deepEqual(plan({ paths: ["package.json"], packageJsonImpact: "unknown" }).suites, REVERSE_SUITES);
});

test("every specialist-consumed script is named in the plan", () => {
  for (const script of SPECIALIST_CONSUMED_SCRIPTS) {
    assert.ok(workflow.includes(`pnpm ${script}`), `${script} must still be invoked by the Reverse workflow`);
  }
});

test("acceptance verifies the plan item by item", () => {
  assert.deepEqual(verifyReverseSuiteResults({ planStatus: "ok", planned: ["claude"], results: { reverse: "skipped", claude: "success", "pi-om": "skipped" } }), { ok: true, planned: ["claude"] });
  assert.deepEqual(verifyReverseSuiteResults({ planStatus: "ok", planned: [], results: { reverse: "skipped", claude: "skipped", "pi-om": "skipped" } }), { ok: true, planned: [] });
  assert.throws(() => verifyReverseSuiteResults({ planStatus: "failed", planned: [], results: {} }), /plan did not succeed/);
  assert.throws(() => verifyReverseSuiteResults({ planStatus: "ok", planned: ["claude"], results: { claude: "skipped" } }), /result mismatch/);
  assert.throws(() => verifyReverseSuiteResults({ planStatus: "ok", planned: [], results: { claude: "success" } }), /result mismatch/);
  assert.throws(() => verifyReverseSuiteResults({ planStatus: "ok", planned: ["claude"], results: { claude: "cancelled" } }), /did not complete cleanly/);
  assert.throws(() => verifyReverseSuiteResults({ planStatus: "ok", planned: ["bogus"], results: {} }), /unknown reverse suite/);
  assert.throws(() => verifyReverseSuiteResults({ planStatus: "ok", planned: [], results: { bogus: "skipped" } }), /unknown reverse suite result/);
  assert.throws(() => verifyReverseSuiteResults({ planStatus: "ok", planned: ["claude"], results: {} }), /missing result/);
});

test("the Reverse workflow consumes the plan instead of running every matrix", () => {
  assert.match(workflow, /reverse_suites: \$\{\{ steps\.plan\.outputs\.reverse_suites \}\}/u);
  assert.match(workflow, /plan_status: \$\{\{ steps\.plan\.outputs\.plan_status \}\}/u);
  for (const suite of REVERSE_SUITES) {
    assert.ok(
      workflow.includes(`contains(format(',{0},', needs.plan.outputs.reverse_suites), ',${suite},')`),
      `${suite} job must gate on the plan`,
    );
  }
  // Acceptance still requires the three matrices and verifies them individually.
  assert.match(workflow, /needs: \[plan, reverse-runtime-images, claude-budget-acceptance, pi-om-acceptance\]/u);
  assert.match(workflow, /check_suite reverse\/REA "\$\(planned reverse\)"/u);
  assert.match(workflow, /check_suite claude "\$\(planned claude\)"/u);
  assert.match(workflow, /check_suite pi-om "\$\(planned pi-om\)"/u);
  assert.match(workflow, /PLANNED_SUITES: \$\{\{ needs\.plan\.outputs\.reverse_suites \}\}/u);
  // No silent weakening.
  assert.doesNotMatch(workflow, /continue-on-error:/u);
});

function declaredTriggerPaths(eventName) {
  const block = workflow.split(`  ${eventName}:`)[1]?.split(/^  [a-z_]+:/mu)[0] ?? "";
  return [...block.matchAll(/^      - "(.+)"$/gmu)].map((match) => match[1]);
}

function assertTriggerCoverage(declared, eventName) {
  assert.ok(declared.length > 30, `${eventName}: the Reverse filter must stay declared`);
  const covered = [...REVERSE_SHARED_INPUTS, ...REVERSE_ROUTING_INPUTS, ...Object.values(REVERSE_SUITE_INPUTS).flat()];
  for (const pattern of covered) {
    // Routing has no exemption: a plan inside an untriggered workflow cannot
    // enforce any suite. This contract runs in core docs-freshness as well.
    // A broader glob may cover an input, e.g. reverse-* covers reverse-base-identity.mjs.
    const sample = pattern.replaceAll("*", "x");
    assert.ok(
      declared.some((glob) => matchesPathPattern(glob, sample)),
      `${eventName}: ${pattern} must stay declared by the Reverse filter`,
    );
  }
  for (const pattern of declared) {
    if (pattern === "package.json") continue;
    assert.ok(covered.includes(pattern), `${eventName}: ${pattern} is declared but not assigned to any suite or shared list`);
  }
}

test("#992 suite, shared and routing inputs are covered by both PR and main triggers", () => {
  for (const eventName of ["pull_request", "push"]) {
    assertTriggerCoverage(declaredTriggerPaths(eventName), eventName);
  }
});

test("#992 removing any routing trigger is rejected even if the plan still requires it", () => {
  for (const eventName of ["pull_request", "push"]) {
    const declared = declaredTriggerPaths(eventName);
    for (const path of REVERSE_ROUTING_INPUTS) {
      const missing = declared.filter((glob) => !matchesPathPattern(glob, path));
      assert.throws(() => assertTriggerCoverage(missing, eventName), /must stay declared by the Reverse filter/u, `${eventName}: ${path}`);
    }
  }
});

test("#992 routing diffs trigger Reverse and retain full Ready acceptance after Draft", () => {
  const suitePaths = loadSuitePaths(ROOT);
  const pr = { eventName: "pull_request", base: "base-sha", head: "head-sha", ciPrMode: "tiered", suitePaths };
  const diff = (...records) => Buffer.from(records.flat().join("\0") + "\0", "utf8");
  for (const path of REVERSE_ROUTING_INPUTS) {
    assert.ok(suitePaths.reverse.some((glob) => matchesPathPattern(glob, path)), `${path}: workflow must start`);
    for (const records of [
      [["M", path]],
      [["M", "CHANGELOG.md"], ["M", "docs/PI_RPC_PAYLOAD_LIMITS.md"], ["M", path]],
      [["D", path]],
      [["R100", path, "docs/README.md"]],
      [["R100", "docs/README.md", path]],
    ]) {
      const input = { ...pr, diffBytes: diff(...records) };
      const draft = buildRunPlan({ ...input, draft: true });
      assert.equal(draft.mode, "draft-fast");
      assert.deepEqual(draft.reverseSuites, []);
      const ready = buildRunPlan({ ...input, draft: false });
      assert.equal(ready.status, "ok");
      assert.equal(ready.mode, "ready-full");
      assert.equal(ready.docsOnly, false);
      assert.ok(ready.requiredSuites.includes("reverse"), `${path}: core and specialist plans must agree`);
      assert.deepEqual(ready.reverseSuites, REVERSE_SUITES);
    }
  }
  for (const path of ["CHANGELOG.md", "docs/PI_RPC_PAYLOAD_LIMITS.md", "apps/web/src/App.tsx"]) {
    for (const eventName of ["pull_request", "push"]) {
      assert.ok(!declaredTriggerPaths(eventName).some((glob) => matchesPathPattern(glob, path)), `${path}: do not widen unrelated triggers`);
    }
    assert.deepEqual(buildRunPlan({ ...pr, diffBytes: diff(["M", path]) }).reverseSuites, []);
  }
});
