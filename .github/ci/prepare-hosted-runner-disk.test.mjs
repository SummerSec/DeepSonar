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

function reverseJob(name) {
  const job = reverseWorkflow.split(`  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:/)[0];
  assert.ok(job, `${name} job must exist`);
  return job;
}

const acceptanceJobs = {
  "reverse-runtime-images": [
    "sudo apt-get update",
    "Build native Reverse runtime",
    "node agent-harness/reverse-native-smoke.mjs",
    "pnpm ci:integration:rea-job",
  ],
  "claude-budget-acceptance": ["pnpm ci:integration:claude-request-budget"],
  "pi-om-acceptance": [
    "Prepare immutable loopback image for OM Job creation",
    "pnpm ci:integration:om-provider-headers",
  ],
};

for (const [name, acceptanceMarkers] of Object.entries(acceptanceJobs)) {
  test(`${name} prepares disk exactly once before its installs, builds and acceptance`, () => {
    const job = reverseJob(name);
    assert.match(job, /needs: plan\n/);
    assert.match(job, /fail-fast: false/);
    assert.match(job, /arch: amd64\n\s+platform: linux\/amd64\n\s+runner: ubuntu-24\.04\n/);
    assert.match(job, /arch: arm64\n\s+platform: linux\/arm64\n\s+runner: ubuntu-24\.04-arm\n/);
    assert.doesNotMatch(job, /continue-on-error:|setup-qemu-action|packages: write/);
    const steps = job.split(/\n      - /).slice(1);
    const prep = steps.filter((step) => step.includes("run: node .github/ci/prepare-hosted-runner-disk.mjs"));
    assert.equal(prep.length, 1, "each independent native matrix must prepare its own disk exactly once");
    assert.doesNotMatch(prep[0], /if:|continue-on-error:|--dry-run|DISK_PREP_DRY_RUN|\|\|/);
    assert.match(prep[0], /run: node \.github\/ci\/prepare-hosted-runner-disk\.mjs\s*$/);
    const prepIndex = steps.indexOf(prep[0]);
    for (const marker of ["actions/checkout@", "actions/setup-node@"]) {
      const index = steps.findIndex((step) => step.includes(marker));
      assert.ok(index >= 0 && index < prepIndex, `${marker} must precede disk preparation`);
    }
    for (const [index, step] of steps.entries()) {
      if (/pnpm install|pnpm .* build|docker buildx build|sudo apt-get/.test(step)) {
        assert.ok(index > prepIndex, "every install/build step must follow disk preparation");
      }
    }
    for (const marker of ["pnpm install --frozen-lockfile", "Build current native base", ...acceptanceMarkers]) {
      const index = steps.findIndex((step) => step.includes(marker));
      assert.ok(index > prepIndex, `${marker} must follow disk preparation`);
    }
  });
}

test("native acceptance summary requires every independent matrix to succeed", () => {
  const job = reverseJob("reverse-runtime-acceptance");
  assert.match(job, /needs: \[plan, reverse-runtime-images, claude-budget-acceptance, pi-om-acceptance\]/);
  assert.match(job, /if: always\(\) && \(needs\.plan\.result != 'success' \|\| needs\.plan\.outputs\.mode == 'ready-full'\)/);
  assert.doesNotMatch(job, /continue-on-error:/);
  for (const [variable, dependency] of [
    ["PLAN", "plan"], ["REVERSE", "reverse-runtime-images"],
    ["CLAUDE", "claude-budget-acceptance"], ["PI_OM", "pi-om-acceptance"],
  ]) {
    assert.ok(job.includes(`${variable}_RESULT: ` + "${{ needs." + dependency + ".result }}"));
    assert.ok(job.includes(`test "$${variable}_RESULT" = success`));
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
