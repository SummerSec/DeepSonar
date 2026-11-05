import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  REMOVABLE_PATHS,
  assertHostedRunner,
  prepareHostedRunnerDisk,
  validateAllowlist,
} from "./prepare-hosted-runner-disk.mjs";

function hostedEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_WORKSPACE: "/home/runner/work/DeepSonar/DeepSonar",
    RUNNER_WORKSPACE: "/home/runner/work/DeepSonar",
    RUNNER_TEMP: "/home/runner/work/_temp",
    ...overrides,
  };
}

function fakeRunner(calls, { failOn } = {}) {
  return (command, args) => {
    calls.push({ command, args });
    if (args.at(-1) === failOn) throw new Error("mock removal failure");
    if (command === "df") return "Filesystem  Size  Used  Avail  Use%  Mounted on\nmock  1T  1G  999G  1%  /\n";
    return "";
  };
}

test("hosted-runner guard rejects local and self-hosted execution", () => {
  assert.throws(
    () => assertHostedRunner({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }),
    /requires GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted/,
  );
  assert.throws(
    () => assertHostedRunner({ GITHUB_ACTIONS: undefined, RUNNER_ENVIRONMENT: undefined }),
    /requires GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted/,
  );
});

test("allowlist is absolute and cannot overlap protected runner or Docker data", () => {
  validateAllowlist(hostedEnv());
  assert.ok(REMOVABLE_PATHS.every((item) => item.startsWith("/")));
  assert.ok(REMOVABLE_PATHS.every((item) => !item.includes("docker")));
  assert.throws(
    () => validateAllowlist(hostedEnv({ GITHUB_WORKSPACE: "/usr/local" })),
    /overlaps protected runner data/,
  );
  assert.throws(
    () => validateAllowlist(hostedEnv({ GITHUB_WORKSPACE: "/usr/share/dotnet/workspace" })),
    /overlaps protected runner data/,
  );
});

test("real cleanup uses only mocked sudo commands for the explicit allowlist", () => {
  const calls = [];
  const logs = [];
  const result = prepareHostedRunnerDisk({
    env: hostedEnv(),
    run: fakeRunner(calls),
    logger: (line) => logs.push(line),
  });

  assert.equal(result.dryRun, false);
  assert.deepEqual(
    calls.filter((call) => call.command === "sudo").map((call) => call.args),
    REMOVABLE_PATHS.map((item) => ["rm", "-rf", "--", item]),
  );
  assert.equal(calls.filter((call) => call.command === "df").length, 2);
  assert.ok(!calls.some((call) => call.args.includes("docker")));
  assert.ok(logs.some((line) => line.includes("before")));
  assert.ok(logs.some((line) => line.includes("after")));
});

test("explicit local dry-run never invokes sudo and ordinary local execution fails before commands", () => {
  const calls = [];
  const result = prepareHostedRunnerDisk({
    env: {},
    dryRun: true,
    run: fakeRunner(calls),
    logger: () => {},
  });

  assert.equal(result.dryRun, true);
  assert.equal(calls.filter((call) => call.command === "sudo").length, 0);
  assert.equal(calls.filter((call) => call.command === "df").length, 2);
  const rejectedCalls = [];
  assert.throws(
    () => prepareHostedRunnerDisk({ env: {}, run: fakeRunner(rejectedCalls) }),
    /requires GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted/,
  );
  assert.deepEqual(rejectedCalls, []);
});

test("cleanup failures still run after diagnostics and report the allowlisted path", () => {
  const calls = [];
  assert.throws(
    () => prepareHostedRunnerDisk({
      env: hostedEnv(),
      run: fakeRunner(calls, { failOn: REMOVABLE_PATHS[0] }),
      logger: () => {},
    }),
    new RegExp(`failed: remove ${REMOVABLE_PATHS[0].replaceAll("/", "\\/")}`),
  );
  assert.equal(calls.filter((call) => call.command === "df").length, 2);
});

const reverseWorkflow = readFileSync(new URL("../workflows/reverse-runtime.yml", import.meta.url), "utf8");

test("Reverse matrix prepares disk before installs, builds and measured native smoke", () => {
  const job = reverseWorkflow.split("  reverse-runtime-images:\n")[1];
  assert.ok(job, "native acceptance job must exist");
  assert.match(job, /runner: ubuntu-24\.04\n/);
  assert.match(job, /runner: ubuntu-24\.04-arm\n/);
  const steps = job.split(/\n      - /).slice(1);
  const prep = steps.filter((step) => step.includes("run: node .github/ci/prepare-hosted-runner-disk.mjs"));
  assert.equal(prep.length, 1, "both architectures share exactly one disk preparation step");
  assert.doesNotMatch(prep[0], /if:|continue-on-error:|--dry-run|DISK_PREP_DRY_RUN|\|\|/);
  assert.match(prep[0], /run: node \.github\/ci\/prepare-hosted-runner-disk\.mjs\s*$/);
  const prepIndex = steps.indexOf(prep[0]);
  for (const marker of ["actions/checkout@", "actions/setup-node@"]) {
    const index = steps.findIndex((step) => step.includes(marker));
    assert.ok(index >= 0 && index < prepIndex, `${marker} must precede disk preparation`);
  }
  for (const marker of [
    "pnpm install --frozen-lockfile",
    "sudo apt-get update",
    "Build current native base",
    "Build native Reverse runtime",
    "node agent-harness/reverse-native-smoke.mjs",
  ]) {
    const index = steps.findIndex((step) => step.includes(marker));
    assert.ok(index > prepIndex, `${marker} must follow disk preparation`);
  }
});

test("Reverse PR and main path filters include disk preparation and its safety regressions", () => {
  for (const event of ["pull_request", "push"]) {
    const block = reverseWorkflow.split(`  ${event}:\n`)[1]?.split(/\n  [a-z_]+:/)[0];
    assert.ok(block, `${event} trigger must exist`);
    for (const file of ["prepare-hosted-runner-disk.mjs", "prepare-hosted-runner-disk.test.mjs"]) {
      assert.ok(block.includes(`      - ".github/ci/${file}"`), `${event} must cover ${file}`);
    }
  }
  const ci = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
  const docsJob = ci.split("  docs-freshness:\n")[1]?.split(/\n  [a-z][\w-]*:/)[0];
  assert.ok(docsJob?.includes("run: node --test .github/ci/prepare-hosted-runner-disk.test.mjs"),
    "disk safety and wiring regressions must run even on Draft PRs");
});
