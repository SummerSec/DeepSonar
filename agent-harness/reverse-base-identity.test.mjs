import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASE_IDENTITY_LABELS,
  BASE_REUSE_VARIABLE,
  baseArtifactName,
  baseReuseEnabled,
  baseSaveFileName,
  buildLabelArgs,
  expectedBaseIdentity,
  identitySummary,
  parseImageLabels,
  verifyBaseIdentity,
} from "./reverse-base-identity.mjs";

const WORKFLOW = fileURLToPath(new URL("../.github/workflows/reverse-runtime.yml", import.meta.url));
const CLI = fileURLToPath(new URL("./reverse-base-identity.mjs", import.meta.url));
const CONSUMERS = ["reverse-runtime-images", "claude-budget-acceptance", "pi-om-acceptance"];

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PLATFORM = "linux/amd64";

// #975: only the literal "on" may enable the shared base. Everything else must
// keep the original three independent native builds.

test("baseReuseEnabled accepts only the literal on", () => {
  assert.equal(BASE_REUSE_VARIABLE, "REVERSE_BASE_REUSE");
  assert.equal(baseReuseEnabled("on"), true);
  assert.equal(baseReuseEnabled("  on\n"), true);
  for (const value of ["true", "1", "ON", "On", "", "  ", undefined, null, "off", "yes", "on,"]) {
    assert.equal(baseReuseEnabled(value), false, `${String(value)} must not enable reuse`);
  }
});

test("expectedBaseIdentity maps every label and rejects missing input", () => {
  assert.deepEqual(expectedBaseIdentity({ sha: SHA, arch: "arm64", platform: "linux/arm64" }), {
    "org.deepsonar.base.sha": SHA,
    "org.deepsonar.base.arch": "arm64",
    "org.deepsonar.base.platform": "linux/arm64",
    "org.deepsonar.base.toolset": "base",
  });
  for (const missing of [{ arch: "amd64", platform: PLATFORM }, { sha: SHA, platform: PLATFORM }, { sha: SHA, arch: "amd64" }, {}]) {
    assert.throws(() => expectedBaseIdentity(missing), /missing required/);
  }
  assert.throws(() => expectedBaseIdentity({ sha: "", arch: "amd64", platform: PLATFORM }), /missing required --sha/);
  assert.throws(() => expectedBaseIdentity({ sha: SHA, arch: "  ", platform: PLATFORM }), /missing required --arch/);
  assert.throws(() => expectedBaseIdentity(), /missing required/);
});

test("baseArtifactName and baseSaveFileName only accept amd64 and arm64", () => {
  assert.equal(baseArtifactName("amd64"), "reverse-base-amd64");
  assert.equal(baseArtifactName("arm64"), "reverse-base-arm64");
  assert.equal(baseSaveFileName("amd64"), "reverse-base-amd64.tar.gz");
  assert.equal(baseSaveFileName("arm64"), "reverse-base-arm64.tar.gz");
  for (const bad of ["x86_64", "aarch64", "AMD64", "", undefined, null, 64]) {
    assert.throws(() => baseArtifactName(bad), /unsupported arch/);
    assert.throws(() => baseSaveFileName(bad), /unsupported arch/);
  }
});

test("buildLabelArgs emits stable order and all four labels", () => {
  const identity = expectedBaseIdentity({ sha: SHA, arch: "amd64", platform: PLATFORM });
  assert.deepEqual(buildLabelArgs(identity), [
    "--label",
    `org.deepsonar.base.sha=${SHA}`,
    "--label",
    "org.deepsonar.base.arch=amd64",
    "--label",
    "org.deepsonar.base.platform=linux/amd64",
    "--label",
    "org.deepsonar.base.toolset=base",
  ]);
  assert.equal(BASE_IDENTITY_LABELS.length, 4);
  const args = buildLabelArgs(identity);
  for (const key of BASE_IDENTITY_LABELS) {
    assert.ok(args.some((arg) => arg.startsWith(`${key}=`)), `missing ${key}`);
  }
  assert.throws(() => buildLabelArgs({ ...identity, "org.deepsonar.base.arch": "" }), /missing label/);
  assert.throws(() => buildLabelArgs(null), /must be an object/);
});

test("parseImageLabels rejects null, arrays and malformed JSON", () => {
  assert.deepEqual(parseImageLabels('{"org.deepsonar.base.sha":"abc"}'), { "org.deepsonar.base.sha": "abc" });
  assert.deepEqual(parseImageLabels("{}"), {});
  for (const bad of ["null", "[]", '"text"', "42", "{bad", "", "   "]) {
    assert.throws(() => parseImageLabels(bad), /docker image label/);
  }
  assert.throws(() => parseImageLabels(undefined), /docker image label/);
});

test("verifyBaseIdentity passes only when all four labels match", () => {
  const expected = expectedBaseIdentity({ sha: SHA, arch: "arm64", platform: "linux/arm64" });
  const result = verifyBaseIdentity({ labels: { ...expected }, expected });
  assert.deepEqual(result, { ok: true, identity: expected });
});

test("verifyBaseIdentity fails closed on every mismatch", () => {
  const expected = expectedBaseIdentity({ sha: SHA, arch: "amd64", platform: PLATFORM });
  const labels = { ...expected };

  const { "org.deepsonar.base.sha": _sha, ...withoutSha } = labels;
  assert.throws(() => verifyBaseIdentity({ labels: withoutSha, expected }), /org\.deepsonar\.base\.sha: missing/);
  assert.throws(
    () => verifyBaseIdentity({ labels: { ...labels, "org.deepsonar.base.sha": "f".repeat(40) }, expected }),
    /org\.deepsonar\.base\.sha: got .*expected/,
  );
  assert.throws(
    () => verifyBaseIdentity({ labels: { ...labels, "org.deepsonar.base.arch": "arm64" }, expected }),
    /org\.deepsonar\.base\.arch: got "arm64", expected "amd64"/,
  );
  assert.throws(
    () => verifyBaseIdentity({ labels: { ...labels, "org.deepsonar.base.platform": "linux/arm64" }, expected }),
    /org\.deepsonar\.base\.platform: got "linux\/arm64", expected "linux\/amd64"/,
  );
  assert.throws(
    () => verifyBaseIdentity({ labels: { ...labels, "org.deepsonar.base.toolset": "audit" }, expected }),
    /org\.deepsonar\.base\.toolset: got "audit", expected "base"/,
  );
  assert.throws(() => verifyBaseIdentity({ labels: null, expected }), /fail closed/);
  assert.throws(() => verifyBaseIdentity({ labels: {}, expected }), /missing/);
  assert.throws(() => verifyBaseIdentity({ labels: [], expected }), /fail closed/);
  assert.throws(() => verifyBaseIdentity({ labels, expected: null }), /expected identity must be an object/);
  assert.throws(() => verifyBaseIdentity({}), /fail closed/);
});

test("identitySummary is sorted and stable", () => {
  const identity = expectedBaseIdentity({ sha: SHA, arch: "amd64", platform: PLATFORM });
  assert.equal(
    identitySummary(identity),
    [
      "org.deepsonar.base.arch=amd64",
      "org.deepsonar.base.platform=linux/amd64",
      `org.deepsonar.base.sha=${SHA}`,
      "org.deepsonar.base.toolset=base",
    ].join("\n"),
  );
  assert.equal(identitySummary(identity), identitySummary({ ...identity }));
  assert.throws(() => identitySummary(null), /must be an object/);
});

test("CLI writes GITHUB_OUTPUT and verifies a label file", () => {
  const dir = mkdtempSync(join(tmpdir(), "reverse-base-identity-"));
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const stdout = execFileSync(
    process.execPath,
    [CLI, "--sha", SHA, "--arch", "arm64", "--platform", "linux/arm64"],
    { env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8" },
  );
  assert.match(stdout, new RegExp(`org\\.deepsonar\\.base\\.sha=${SHA}`));
  const written = readFileSync(output, "utf8");
  assert.match(written, /^label_args=\["--label","org\.deepsonar\.base\.sha=/m);
  assert.match(written, /^artifact_name=reverse-base-arm64$/m);
  assert.match(written, /^save_file=reverse-base-arm64\.tar\.gz$/m);

  const labelsFile = join(dir, "labels.json");
  writeFileSync(
    labelsFile,
    JSON.stringify(expectedBaseIdentity({ sha: SHA, arch: "arm64", platform: "linux/arm64" })),
  );
  const verified = execFileSync(
    process.execPath,
    [CLI, "--verify", "--labels-json-file", labelsFile, "--sha", SHA, "--arch", "arm64", "--platform", "linux/arm64"],
    { encoding: "utf8" },
  );
  assert.match(verified, /base identity verified/);

  writeFileSync(labelsFile, JSON.stringify({ ...expectedBaseIdentity({ sha: SHA, arch: "arm64", platform: "linux/arm64" }), "org.deepsonar.base.sha": "deadbeef" }));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [CLI, "--verify", "--labels-json-file", labelsFile, "--sha", SHA, "--arch", "arm64", "--platform", "linux/arm64"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    /Command failed/,
  );
});

// ---------------------------------------------------------------------------
// Workflow text contract. Parsed by indentation instead of a YAML dependency so
// the check runs anywhere node runs.
// ---------------------------------------------------------------------------

function workflowText() {
  return readFileSync(WORKFLOW, "utf8");
}

function jobBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `job ${name} must exist`);
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}

function stepBlock(jobText, name) {
  const lines = jobText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === `      - name: ${name}`);
  assert.notEqual(start, -1, `step "${name}" must exist`);
  const block = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^ {0,6}- /.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}

test("workflow declares the gated reverse-base producer", () => {
  const text = workflowText();
  const base = jobBlock(text, "reverse-base");
  assert.match(base, /needs: plan/);
  assert.match(base, /vars\.REVERSE_BASE_REUSE == 'on'/);
  assert.match(base, /actions\/upload-artifact@v4/);
  assert.match(base, /agent-harness\/reverse-base-identity\.mjs/);
  assert.match(base, /--build-arg TOOLSET=base/);
  assert.match(base, /--tag "deepsonar-base:reverse-ci-\$\{\{ matrix\.arch \}\}"/);
  assert.match(base, /docker save/);
});

test("every consumer waits for reverse-base and restores only when enabled", () => {
  const text = workflowText();
  for (const job of CONSUMERS) {
    const block = jobBlock(text, job);
    assert.match(block, /needs: \[plan, reverse-base\]/, `${job} must need reverse-base`);

    const load = stepBlock(block, "Load and verify shared base");
    assert.ok(load.includes("if: ${{ vars.REVERSE_BASE_REUSE == 'on' }}"), `${job} load gate`);
    assert.match(load, /gzip -dc .*reverse-base-\$\{\{ matrix\.arch \}\}\.tar\.gz" \| docker load/);
    assert.match(load, /--verify/);
    assert.match(load, /docker tag "deepsonar-base:reverse-ci-\$\{\{ matrix\.arch \}\}" deepsonar-base:reverse-ci/);
    assert.match(block, /actions\/download-artifact@v4/);
    assert.match(block, /name: reverse-base-\$\{\{ matrix\.arch \}\}/);
  }
});

test("original native base build stays as the default path", () => {
  const text = workflowText();
  for (const job of CONSUMERS) {
    const block = jobBlock(text, job);
    const build = stepBlock(block, "Build current native base");
    assert.ok(build.includes("if: ${{ vars.REVERSE_BASE_REUSE != 'on' }}"), `${job} build gate`);
    // The docker command is line-continued; flatten it before matching flags.
    const script = build
      .split(/\r?\n/)
      .map((line) => line.replace(/\\\s*$/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    assert.match(script, /docker buildx build .*--build-arg TOOLSET=base/);
    assert.match(script, /--tag deepsonar-base:reverse-ci\b/);
    assert.match(script, /--file deploy\/Dockerfile\.agent \.$/);
  }
});

test("consumers keep consuming the mutable tag they always consumed", () => {
  const text = workflowText();
  assert.match(jobBlock(text, "reverse-runtime-images"), /--build-arg BASE_IMAGE=deepsonar-base:reverse-ci/);
  assert.match(jobBlock(text, "claude-budget-acceptance"), /CLAUDE_BUDGET_IMAGE: deepsonar-base:reverse-ci/);
});

test("acceptance keeps its four original assertions and needs", () => {
  const text = workflowText();
  const block = jobBlock(text, "reverse-runtime-acceptance");
  assert.match(block, /needs: \[plan, reverse-runtime-images, claude-budget-acceptance, pi-om-acceptance\]/);
  for (const result of ["PLAN_RESULT", "REVERSE_RESULT", "CLAUDE_RESULT", "PI_OM_RESULT"]) {
    assert.match(block, new RegExp(`test "\\$${result}" = success`));
  }
  assert.match(block, /base 复用开启时由各消费者在 load 后校验/);
});

test("workflow never uses latest, packages: write or continue-on-error", () => {
  const text = workflowText();
  assert.doesNotMatch(text, /deepsonar-base:latest/);
  assert.doesNotMatch(text, /packages:\s*write/);
  assert.doesNotMatch(text, /continue-on-error/);
});
