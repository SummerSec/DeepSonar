import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  REMOVABLE_PATHS,
  MIN_FREE_BYTES,
  DISK_PREP_MIN_FREE_BYTES,
  assertHostedRunner,
  parseDfAvailableBytes,
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

const KB_PER_GIB = 1024 ** 2;
const MIN_FREE_KB = MIN_FREE_BYTES / 1024; // threshold expressed in df -Pk (1024-byte) blocks
const LOW_KB = 50 * KB_PER_GIB; // below threshold
const HIGH_KB = 90 * KB_PER_GIB; // above threshold

function dfPkOutput(availableKb) {
  return `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/mock 200000000 100000000 ${Math.floor(availableKb)} 50% /\n`;
}

// - `dfBytes`: number (fixed low/high), array (per -Pk measurement), or
//   ({ rmCount, measureIndex }) => KB. Defaults to a below-threshold value that
//   rises 4 GiB per successful removal, so the 9th removal just meets the
//   budget and the original "all 9 paths removed" assertion still holds.
// - `malformedDf`: makes every parsed -Pk read unparseable.
// - `failOn`: path whose sudo removal throws.
function fakeRunner(calls, { failOn, dfBytes, malformedDf } = {}) {
  let rmCount = 0;
  let measureIndex = 0;
  return (command, args) => {
    calls.push({ command, args });
    if (args.at(-1) === failOn) throw new Error("mock removal failure");
    if (command === "df") {
      // -hP diagnostics are only logged, never parsed, so return human units.
      if (args[0] !== "-Pk") {
        return "Filesystem Size Used Avail Use% Mounted on\nmock 200G 100G 100G 50% /\n";
      }
      if (malformedDf) {
        measureIndex += 1;
        return "not a df -Pk output\n";
      }
      let availableKb;
      if (typeof dfBytes === "function") {
        availableKb = dfBytes({ rmCount, measureIndex });
      } else if (Array.isArray(dfBytes)) {
        availableKb = dfBytes[Math.min(measureIndex, dfBytes.length - 1)];
      } else if (dfBytes !== undefined) {
        availableKb = dfBytes;
      } else {
        availableKb = LOW_KB + rmCount * (4 * KB_PER_GIB);
      }
      measureIndex += 1;
      return dfPkOutput(availableKb);
    }
    if (command === "sudo") rmCount += 1;
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
  // New semantics (was === 2): df is read once before cleanup and re-read after
  // every removal, plus before/after diagnostics, so it is called >= 2 times.
  assert.ok(calls.filter((call) => call.command === "df").length >= 2);
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
  // New semantics (was === 2): budget read + before/after diagnostics call df
  // more than twice even in dry-run, which never invokes sudo.
  assert.ok(calls.filter((call) => call.command === "df").length >= 2);
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
  // New semantics (was === 2): after diagnostics still run on removal failure.
  assert.ok(calls.filter((call) => call.command === "df").length >= 2);
});

// --- issue #973: budget-based cleanup --------------------------------------

test("① sufficient free space skips all deletions and logs the threshold and skip reason", () => {
  const calls = [];
  const logs = [];
  const result = prepareHostedRunnerDisk({
    env: hostedEnv(),
    run: fakeRunner(calls, { dfBytes: HIGH_KB }),
    logger: (line) => logs.push(line),
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.steps, []);
  assert.equal(result.beforeBytes, HIGH_KB * 1024);
  assert.equal(result.afterBytes, result.beforeBytes);
  assert.equal(result.minFreeBytes, MIN_FREE_BYTES);
  assert.equal(calls.filter((call) => call.command === "sudo").length, 0);
  assert.match(logs.join("\n"), /skip/i);
  assert.ok(logs.join("\n").includes(String(MIN_FREE_BYTES)), "threshold must be logged");
  assert.ok(result.reason.includes(String(MIN_FREE_BYTES)), "skip reason must include the threshold");
});

test("② insufficient space stops exactly at the 3rd removal once the budget is met", () => {
  const calls = [];
  const result = prepareHostedRunnerDisk({
    env: hostedEnv(),
    run: fakeRunner(calls, {
      dfBytes: ({ rmCount }) => (rmCount >= 3 ? HIGH_KB : LOW_KB),
    }),
    logger: () => {},
  });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.removed, REMOVABLE_PATHS.slice(0, 3));
  assert.equal(result.steps.length, 3);
  assert.deepEqual(result.steps.map((step) => step.path), REMOVABLE_PATHS.slice(0, 3));
  assert.equal(calls.filter((call) => call.command === "sudo").length, 3);
  assert.ok(result.afterBytes >= result.minFreeBytes);
  assert.equal(result.afterBytes, HIGH_KB * 1024);
  for (const step of result.steps) {
    assert.equal(typeof step.durationMs, "number");
    assert.equal(typeof step.availableBytes, "number");
  }
});

test("③ exhausting the whole allowlist without meeting the budget fails with the threshold", () => {
  const calls = [];
  assert.throws(
    () => prepareHostedRunnerDisk({
      env: hostedEnv(),
      run: fakeRunner(calls, { dfBytes: LOW_KB }),
      logger: () => {},
    }),
    (error) => {
      assert.match(error.message, /insufficient free space/i);
      assert.ok(error.message.includes(String(MIN_FREE_BYTES)), "error must include the threshold");
      return true;
    },
  );
  assert.equal(calls.filter((call) => call.command === "sudo").length, REMOVABLE_PATHS.length);
});

test("④ unparseable df output aborts before any sudo removal", () => {
  const calls = [];
  assert.throws(
    () => prepareHostedRunnerDisk({
      env: hostedEnv(),
      run: fakeRunner(calls, { malformedDf: true }),
      logger: () => {},
    }),
    /cannot parse df available bytes/,
  );
  assert.equal(calls.filter((call) => call.command === "sudo").length, 0);
});

test("⑤ invalid DISK_PREP_MIN_FREE_BYTES values fail closed", () => {
  for (const bad of ["-1", "abc", "", "1.5", "12abc", "999999999999999999999999"]) {
    const calls = [];
    assert.throws(
      () => prepareHostedRunnerDisk({
        env: hostedEnv({ [DISK_PREP_MIN_FREE_BYTES]: bad }),
        run: fakeRunner(calls),
        logger: () => {},
      }),
      new RegExp(`invalid ${DISK_PREP_MIN_FREE_BYTES}`),
      `expected rejection for ${JSON.stringify(bad)}`,
    );
    assert.equal(calls.filter((call) => call.command === "sudo").length, 0);
  }
});

test("⑥ dry-run with insufficient space never calls sudo and does not claim the budget was met", () => {
  const calls = [];
  const logs = [];
  const result = prepareHostedRunnerDisk({
    env: {},
    dryRun: true,
    run: fakeRunner(calls, { dfBytes: LOW_KB }),
    logger: (line) => logs.push(line),
  });
  assert.equal(result.dryRun, true);
  assert.equal(calls.filter((call) => call.command === "sudo").length, 0);
  assert.notEqual(result.skipped, true);
  assert.ok(result.afterBytes < result.minFreeBytes, "must not claim the budget was met");
  assert.equal(result.afterBytes, result.beforeBytes);
  assert.match(logs.join("\n"), /would run sudo rm -rf/);
});

test("⑦ a mid-cleanup removal failure throws, still runs after diagnostics, and stops deleting", () => {
  const calls = [];
  const logs = [];
  const failOn = REMOVABLE_PATHS[2];
  assert.throws(
    () => prepareHostedRunnerDisk({
      env: hostedEnv(),
      run: fakeRunner(calls, { failOn }),
      logger: (line) => logs.push(line),
    }),
    new RegExp(`failed: remove ${failOn.replaceAll("/", "\\/")}`),
  );
  assert.ok(logs.some((line) => line.includes("after")), "after diagnostics must run");
  const sudoCalls = calls.filter((call) => call.command === "sudo");
  assert.equal(sudoCalls.length, 3, "must stop at the failing path");
  assert.deepEqual(sudoCalls.at(-1).args, ["rm", "-rf", "--", failOn]);
});

test("⑧ allowlist protection regressions still hold", () => {
  validateAllowlist(hostedEnv());
  assert.throws(
    () => validateAllowlist(hostedEnv({ GITHUB_WORKSPACE: "/usr/local" })),
    /overlaps protected runner data/,
  );
  assert.throws(
    () => validateAllowlist(hostedEnv({ GITHUB_WORKSPACE: "/usr/share/dotnet/workspace" })),
    /overlaps protected runner data/,
  );
});

test("⑨ parseDfAvailableBytes parses valid KB rows and rejects malformed input", () => {
  assert.equal(parseDfAvailableBytes(dfPkOutput(MIN_FREE_KB)), MIN_FREE_BYTES);
  assert.equal(
    parseDfAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 10 2 8 20% /\n"),
    8 * 1024,
  );
  assert.throws(() => parseDfAvailableBytes(""), /cannot parse df available bytes/);
  assert.throws(() => parseDfAvailableBytes("garbage\n"), /cannot parse df available bytes/);
  assert.throws(() => parseDfAvailableBytes("header only\n"), /cannot parse df available bytes/);
  // -h human-readable units must never be silently accepted.
  assert.throws(
    () => parseDfAvailableBytes("Filesystem Size Used Avail Use%\n/dev/x 1T 1G 999G 1% /\n"),
    /cannot parse df available bytes/,
  );
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
