// #976: plan the Reverse / Pi-OM / Claude specialist suites independently.
//
// The Reverse workflow declares one broad `pull_request.paths` filter, so any
// change it covers fans out to all three heavy native matrices. This module
// splits that filter into explicit per-suite dependency lists plus a shared
// list, and adds a field-level `package.json` classifier so that a patch which
// only adds an independent test script no longer starts the heavy jobs.
//
// Everything here fails closed: an unreadable diff, a missing revision, a
// delete/rename, a routing change, a shared input or an unparseable
// package.json keeps all three suites required. The module never narrows
// coverage on its own; it only reports what the evidence supports.

import { isDocsOnlyPath } from "./classify-ci-changes.mjs";
import { matchesAnyPath } from "./path-match.mjs";

export const REVERSE_SUITES = Object.freeze(["reverse", "claude", "pi-om"]);

/**
 * Inputs every specialist consumes: the shared base image, the pinned
 * toolchain/manual inputs, the sandbox launcher, the lockfile and the
 * workflow/release routing that decides how they run. The Dockerfile wildcard
 * also fails closed on unknown new images; audited child-image exceptions are
 * handled explicitly below, after the unsafe-status and routing checks.
 */
export const REVERSE_SHARED_INPUTS = Object.freeze([
  "deploy/Dockerfile.agent*",
  "deploy/docker-compose.opensandbox.yml",
  "deploy/opensandbox/**",
  "agent-harness/runtime-images.json",
  "agent-harness/dsh-runtime/**",
  "agent-harness/base-cli-runtime/**",
  "agent-harness/pi-extensions-base-runtime/**",
  "agent-harness/base-apt-runtime.json",
  "agent-harness/base-apt-inputs.mjs",
  "agent-harness/base-apt-inputs.test.mjs",
  "agent-harness/base-cli-lifecycle.json",
  "agent-harness/base-cli-install.mjs",
  "agent-harness/base-cli-install.test.mjs",
  "agent-harness/dsh-request-budget-install.mjs",
  "agent-harness/pi-observational-memory-governed.ts",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "agent-harness/write-tool-manifest.mjs",
  "agent-harness/runtime-manuals/**",
  "agent-harness/materialize-runtime-manuals.mjs",
  "agent-harness/test-runtime-manuals-runtime.mjs",
  "agent-harness/image-build-fingerprint.mjs",
  "agent-harness/reverse-base-identity.mjs",
  "agent-harness/reverse-base-identity.test.mjs",
  "packages/runtime-sandbox/**",
  "pnpm-lock.yaml",
  ".dockerignore",
  ".github/ci/prepare-hosted-runner-disk.mjs",
  ".github/ci/prepare-hosted-runner-disk.test.mjs",
]);

/**
 * Routing and planning inputs. A change here may change *which* suites run, so
 * it may not grant itself a cheaper path: the plan model is part of its own
 * input set (same discipline as #961's pinned ARM inputs).
 */
export const REVERSE_ROUTING_INPUTS = Object.freeze([
  ".github/workflows/reverse-runtime.yml",
  ".github/workflows/release.yml",
  "agent-harness/ci-run-plan.mjs",
  "agent-harness/ci-run-cost.mjs",
  "agent-harness/classify-ci-changes.mjs",
  "agent-harness/path-match.mjs",
  "agent-harness/reverse-suite-plan.mjs",
]);

// #992: audited child Dockerfiles are not inputs to the base/Reverse builds.
// Keep the broad workflow filter and unknown Dockerfiles fail-closed; never turn
// all deploy/Dockerfile.agent* paths into an exemption. Delete/rename still run all.
export const REVERSE_UNRELATED_IMAGE_INPUTS = Object.freeze([
  "deploy/Dockerfile.agent-chrome-audit",
  "deploy/Dockerfile.agent-chrome-fuzz",
  "deploy/Dockerfile.agent-chrome-test",
  "deploy/Dockerfile.agent-kali-minimal",
  "deploy/Dockerfile.agent-mobile",
  "deploy/Dockerfile.agent-openharmony",
  "deploy/Dockerfile.agent-openharmony-audit",
  "deploy/Dockerfile.agent-openharmony-fuzz",
]);
const REVERSE_ONLY_DOCKERFILE = "deploy/Dockerfile.agent-reverse";

/** Per-suite inputs, taken from the Reverse workflow's declared filter. */
export const REVERSE_SUITE_INPUTS = Object.freeze({
  reverse: Object.freeze([
    REVERSE_ONLY_DOCKERFILE,
    "deploy/reverse-*.sh",
    "agent-harness/reverse-*",
    "agent-harness/rea-runtime/**",
    "agent-harness/opensandbox/*rea*",
    "agent-harness/test-reverse-*",
    "agent-harness/fixtures/reverse-sample/**",
    "apps/scheduler/src/domains/cli-capability/**",
    "apps/scheduler/src/dispatcher*.ts",
    "apps/scheduler/src/executor-real*.ts",
    "apps/scheduler/src/domains/platform-api/**",
    "apps/scheduler/src/domains/event-ingestion/**",
    "apps/scheduler/src/domains/shared-assets/**",
    "apps/scheduler/src/domains/role-runtime-snapshot/**",
    "skills/deepsonar-rea-cli/**",
  ]),
  claude: Object.freeze([
    "agent-harness/claude-request-budget-cli.test.ts",
    "agent-harness/tsconfig.claude-budget.json",
    "agent-harness/run-claude-budget-isolated.mjs",
  ]),
  "pi-om": Object.freeze([
    "agent-harness/opensandbox/*om-provider-headers*",
    "apps/scheduler/src/gateway*.ts",
    "apps/scheduler/src/provider-custom-headers.ts",
    "apps/scheduler/src/provider-settings.ts",
    "apps/scheduler/src/pi-extensions.ts",
  ]),
});

/** Scripts the three specialists actually execute; a change to them is never "independent". */
export const SPECIALIST_CONSUMED_SCRIPTS = Object.freeze([
  "ci:integration:rea-job",
  "ci:integration:claude-request-budget",
  "ci:integration:om-provider-headers",
]);

const failClosed = (reason) => ({ suites: [...REVERSE_SUITES], reasons: [reason], narrowed: false });
const skipped = (reason) => ({ suites: [], reasons: [reason], narrowed: false });

/**
 * Field-level `package.json` impact.
 *
 * Only a *purely additive* set of new `ci:unit:*` test scripts, none of which
 * the specialists execute, is judged independent. Any dependency, lockfile
 * neighbour, removed/renamed/modified script, non-test script, or parse
 * failure returns "full" so the caller keeps every suite required.
 */
export function classifyPackageJsonChange({ baseText, headText } = {}) {
  if (typeof baseText !== "string" || typeof headText !== "string") {
    return { impact: "full", reasons: ["package_json_missing"] };
  }
  let base;
  let head;
  try {
    base = JSON.parse(baseText);
    head = JSON.parse(headText);
  } catch {
    return { impact: "full", reasons: ["package_json_unparseable"] };
  }
  if (!base || !head || typeof base !== "object" || typeof head !== "object" || Array.isArray(base) || Array.isArray(head)) {
    return { impact: "full", reasons: ["package_json_not_object"] };
  }

  // Any non-script field change (dependencies, devDependencies, engines,
  // packageManager, pnpm, workspaces, ...) is never independent.
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const key of keys) {
    if (key === "scripts") continue;
    if (JSON.stringify(base[key]) !== JSON.stringify(head[key])) {
      return { impact: "full", reasons: [`package_json_field_changed:${key}`] };
    }
  }

  const baseScripts = base.scripts ?? {};
  const headScripts = head.scripts ?? {};
  if (!baseScripts || !headScripts || typeof baseScripts !== "object" || typeof headScripts !== "object") {
    return { impact: "full", reasons: ["package_json_scripts_not_object"] };
  }

  for (const [name, command] of Object.entries(baseScripts)) {
    if (!(name in headScripts)) return { impact: "full", reasons: [`package_json_script_removed:${name}`] };
    if (headScripts[name] !== command) return { impact: "full", reasons: [`package_json_script_modified:${name}`] };
  }

  const added = Object.keys(headScripts).filter((name) => !(name in baseScripts));
  for (const name of added) {
    if (!name.startsWith("ci:unit:")) {
      return { impact: "full", reasons: [`package_json_script_added_not_test:${name}`] };
    }
    if (SPECIALIST_CONSUMED_SCRIPTS.includes(name)) {
      return { impact: "full", reasons: [`package_json_script_added_consumed:${name}`] };
    }
    const command = String(headScripts[name] ?? "");
    if (!command.includes("--test")) {
      return { impact: "full", reasons: [`package_json_script_added_not_test_command:${name}`] };
    }
  }

  return {
    impact: "none",
    reasons: added.length === 0
      ? ["package_json_scripts_unchanged"]
      : added.map((name) => `package_json_added_test_script:${name}`),
  };
}

/**
 * Decide which Reverse-family suites this run must execute.
 *
 * `records` is the parsed `git diff --name-status -z` record list; `paths` is
 * the flattened path set; `packageJsonImpact` is the result of
 * `classifyPackageJsonChange` when `package.json` changed, otherwise "none".
 */
export function planReverseSuites({
  status,
  mode,
  tiered = true,
  eventName,
  records = [],
  paths = [],
  packageJsonImpact = "none",
  packageJsonReasons = [],
} = {}) {
  if (status !== "ok") return failClosed("reverse_plan_failed_fail_closed");
  if (eventName !== "pull_request") return failClosed("reverse_non_pull_request_full");
  if (mode === "docs") return skipped("reverse_docs_only");
  if (mode === "draft-fast") return skipped("reverse_draft_fast_path");
  if (!tiered) return failClosed("reverse_full_mode");
  if (paths.length === 0) return failClosed("reverse_inputs_missing_fail_closed");
  if (packageJsonImpact !== "none" && packageJsonImpact !== "full") {
    return failClosed("reverse_package_json_unknown_fail_closed");
  }
  if (packageJsonImpact === "full") {
    return failClosed(`reverse_package_json_${packageJsonReasons[0] ?? "full"}`);
  }
  // Delete / rename / copy cannot prove the target is not a specialist input.
  if (records.some((record) => /^[DRC]/u.test(String(record.status ?? "")))) {
    return failClosed("reverse_unsafe_change_status");
  }
  if (paths.some((path) => matchesAnyPath(REVERSE_ROUTING_INPUTS, path))) {
    return failClosed("reverse_routing_inputs_changed");
  }
  const sharedPaths = paths.filter((path) => path !== REVERSE_ONLY_DOCKERFILE && !REVERSE_UNRELATED_IMAGE_INPUTS.includes(path));
  if (sharedPaths.some((path) => matchesAnyPath(REVERSE_SHARED_INPUTS, path))) {
    return failClosed("reverse_shared_inputs_changed");
  }
  if (paths.some((path) => REVERSE_UNRELATED_IMAGE_INPUTS.includes(path))
      && paths.every((path) => isDocsOnlyPath(path) || REVERSE_UNRELATED_IMAGE_INPUTS.includes(path))) {
    return { suites: [], reasons: ["reverse_reviewed_other_image_only"], narrowed: true };
  }

  const suites = REVERSE_SUITES.filter((suite) =>
    paths.some((path) => matchesAnyPath(REVERSE_SUITE_INPUTS[suite], path)));
  if (suites.length === 0) {
    const docsOnly = paths.every((path) => isDocsOnlyPath(path));
    return {
      suites: [],
      reasons: [docsOnly ? "reverse_docs_paths_only" : "reverse_inputs_unchanged"],
      narrowed: true,
    };
  }
  return {
    suites,
    reasons: suites.map((suite) => `reverse_suite:${suite}`),
    narrowed: true,
  };
}

/** `ci-summary`-style verdict for the Reverse acceptance job. */
export function verifyReverseSuiteResults({ planned = [], results = {}, planStatus } = {}) {
  if (planStatus !== "ok") throw new Error(`reverse plan did not succeed: ${planStatus ?? "<empty>"}`);
  for (const suite of planned) {
    if (!REVERSE_SUITES.includes(suite)) throw new Error(`unknown reverse suite in plan: ${suite}`);
  }
  for (const [suite, result] of Object.entries(results)) {
    if (!REVERSE_SUITES.includes(suite)) throw new Error(`unknown reverse suite result: ${suite}`);
    if (["failure", "cancelled", "timed_out", "action_required"].includes(result)) {
      throw new Error(`reverse suite ${suite} did not complete cleanly: ${result}`);
    }
    const expected = planned.includes(suite) ? "success" : "skipped";
    if (result !== expected) {
      throw new Error(
        `reverse suite ${suite} result mismatch: expected ${expected} (${planned.includes(suite) ? "planned" : "not planned"}), got ${result}`,
      );
    }
  }
  for (const suite of planned) {
    if (!(suite in results)) throw new Error(`missing result for planned reverse suite: ${suite}`);
  }
  return { ok: true, planned: [...planned] };
}
