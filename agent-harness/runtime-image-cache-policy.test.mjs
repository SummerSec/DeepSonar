// #974: pure node:test, zero dependencies. Verifies the runtime image cache policy
// module, its CLI (heredoc GITHUB_OUTPUT), and the ci.yml text contract.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KALI_GHA_MODES,
  RUNTIME_CACHE_KALI_GHA_VARIABLE,
  runtimeImageCachePolicy,
} from "./runtime-image-cache-policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CI = join(ROOT, ".github/workflows/ci.yml");
const CLI = join(ROOT, "agent-harness/runtime-image-cache-policy.mjs");
const OWNER = "deepsonar-owner";
const SRC_TAG = "src-deadbeef";

const registryBuildcache = (toolset) => `type=registry,ref=ghcr.io/${OWNER}/deepsonar-${toolset}:buildcache-ci`;
const registrySrc = (toolset) => `type=registry,ref=ghcr.io/${OWNER}/deepsonar-${toolset}:${SRC_TAG}`;
const ghaRead = (toolset) => `type=gha,scope=runtime-${toolset}`;
const registryExport = (toolset) => `type=registry,ref=ghcr.io/${OWNER}/deepsonar-${toolset}:buildcache-ci,mode=max,ignore-error=true`;
const ghaMax = (toolset) => `type=gha,mode=max,scope=runtime-${toolset}`;
const historicalCacheTo = (toolset) => `${registryExport(toolset)}\n${ghaMax(toolset)}\n`;
const cacheFromFor = (toolset) => `${registryBuildcache(toolset)}\n${registrySrc(toolset)}\n${ghaRead(toolset)}\n`;
const baseArgs = (toolset = "kali-minimal") => ({ toolset, owner: OWNER, srcTag: SRC_TAG });

/** Parse the `key<<DELIM\n...\nDELIM` multiline GITHUB_OUTPUT format. */
function parseGithubOutput(text) {
  const lines = text.split("\n");
  const result = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_]+)<<(.+)$/);
    if (!match) continue;
    const [, name, delimiter] = match;
    const value = [];
    index += 1;
    while (index < lines.length && lines[index] !== delimiter) {
      value.push(lines[index]);
      index += 1;
    }
    result[name] = value.join("\n");
  }
  return result;
}

function runCli(args, { withOutput = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cache-policy-"));
  try {
    const output = join(dir, "github_output");
    const env = { ...process.env };
    delete env.GITHUB_OUTPUT;
    if (withOutput) env.GITHUB_OUTPUT = output;
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: "utf8" });
    const outputText = withOutput && existsSync(output) ? readFileSync(output, "utf8") : "";
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, outputText };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- exports ---------------------------------------------------------------

test("exports frozen KALI_GHA_MODES and the GH variable name", () => {
  assert.deepEqual([...KALI_GHA_MODES], ["off", "min", "max"]);
  assert.ok(Object.isFrozen(KALI_GHA_MODES));
  assert.equal(RUNTIME_CACHE_KALI_GHA_VARIABLE, "RUNTIME_CACHE_KALI_GHA");
});

// --- base / audit: historical cacheTo byte-for-byte ------------------------

test("base cache-to matches the historical two lines", () => {
  const { cacheTo } = runtimeImageCachePolicy(baseArgs("base"));
  assert.equal(cacheTo, historicalCacheTo("base"));
});

test("audit cache-to matches the historical two lines", () => {
  const { cacheTo } = runtimeImageCachePolicy(baseArgs("audit"));
  assert.equal(cacheTo, historicalCacheTo("audit"));
});

// --- kali-minimal: off / min / max -----------------------------------------

test("kali-minimal default omits any GHA export and keeps registry ignore-error", () => {
  const { cacheTo, reasons } = runtimeImageCachePolicy(baseArgs());
  assert.equal(cacheTo, `${registryExport("kali-minimal")}\n`);
  assert.ok(!cacheTo.includes("type=gha"));
  assert.ok(cacheTo.includes("ignore-error=true"));
  assert.ok(Array.isArray(reasons) && reasons.length > 0 && reasons.every((r) => typeof r === "string" && r.length > 0));
});

test("kali-minimal explicit off equals the default", () => {
  assert.equal(
    runtimeImageCachePolicy({ ...baseArgs(), kaliGhaMode: "off" }).cacheTo,
    runtimeImageCachePolicy(baseArgs()).cacheTo,
  );
});

test("kali-minimal min appends gha mode=min", () => {
  const { cacheTo } = runtimeImageCachePolicy({ ...baseArgs(), kaliGhaMode: "min" });
  assert.equal(cacheTo, `${registryExport("kali-minimal")}\ntype=gha,mode=min,scope=runtime-kali-minimal\n`);
});

test("kali-minimal max restores the legacy gha mode=max", () => {
  const { cacheTo } = runtimeImageCachePolicy({ ...baseArgs(), kaliGhaMode: "max" });
  assert.equal(cacheTo, historicalCacheTo("kali-minimal"));
});

// --- validation / defaults -------------------------------------------------

test("unset / empty / null kaliGhaMode is treated as off", () => {
  for (const kaliGhaMode of [undefined, "", null]) {
    const { cacheTo } = runtimeImageCachePolicy({ ...baseArgs(), kaliGhaMode });
    assert.ok(!cacheTo.includes("type=gha"), `kaliGhaMode=${String(kaliGhaMode)}`);
    assert.equal(cacheTo, `${registryExport("kali-minimal")}\n`);
  }
});

test("invalid / blank kaliGhaMode throws (fail closed)", () => {
  for (const kaliGhaMode of ["turbo", "MAX", " ", "off "]) {
    assert.throws(
      () => runtimeImageCachePolicy({ ...baseArgs(), kaliGhaMode }),
      /invalid kaliGhaMode/,
      `kaliGhaMode=${JSON.stringify(kaliGhaMode)}`,
    );
  }
});

test("missing / empty owner throws", () => {
  for (const owner of [undefined, "", "   "]) {
    assert.throws(() => runtimeImageCachePolicy({ ...baseArgs(), owner }), /missing owner/, `owner=${JSON.stringify(owner)}`);
  }
});

test("missing / empty srcTag throws", () => {
  for (const srcTag of [undefined, "", "   "]) {
    assert.throws(() => runtimeImageCachePolicy({ ...baseArgs(), srcTag }), /missing srcTag/, `srcTag=${JSON.stringify(srcTag)}`);
  }
});

test("unknown / missing toolset throws", () => {
  for (const toolset of ["kali", "tools", "", undefined, null]) {
    assert.throws(() => runtimeImageCachePolicy({ ...baseArgs(), toolset }), /unknown toolset/, `toolset=${JSON.stringify(toolset)}`);
  }
});

// --- cacheFrom is invariant ------------------------------------------------

test("cache-from is always three lines: two registry reads + gha read fallback", () => {
  for (const toolset of ["base", "audit", "kali-minimal"]) {
    const { cacheFrom } = runtimeImageCachePolicy(baseArgs(toolset));
    assert.equal(cacheFrom, cacheFromFor(toolset));
    assert.ok(cacheFrom.endsWith("\n"));
    assert.equal(cacheFrom.trimEnd().split("\n").length, 3);
    assert.ok(cacheFrom.includes(`type=gha,scope=runtime-${toolset}`));
    assert.equal((cacheFrom.match(/type=registry/g) || []).length, 2);
  }
});

test("fork / any eventName keeps registry ignore-error=true and gha read fallback", () => {
  for (const eventName of ["pull_request", "pull_request_target", "push", "workflow_dispatch", undefined, ""]) {
    for (const toolset of ["base", "kali-minimal"]) {
      const { cacheFrom, cacheTo } = runtimeImageCachePolicy({ ...baseArgs(toolset), eventName });
      assert.ok(cacheTo.includes("ignore-error=true"), `toolset=${toolset} event=${eventName}`);
      assert.ok(cacheFrom.includes(`type=gha,scope=runtime-${toolset}`), `toolset=${toolset} event=${eventName}`);
    }
  }
});

// --- CLI -------------------------------------------------------------------

test("CLI writes parseable multiline heredoc GITHUB_OUTPUT for kali-minimal", () => {
  const run = runCli(["--toolset", "kali-minimal", "--owner", OWNER, "--src-tag", SRC_TAG, "--event-name", "pull_request"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /toolset=kali-minimal/);
  const parsed = parseGithubOutput(run.outputText);
  assert.equal(parsed.cache_from, cacheFromFor("kali-minimal").trimEnd());
  assert.equal(parsed.cache_to, registryExport("kali-minimal"));
});

test("CLI writes the historical two-line cache_to for base", () => {
  const run = runCli(["--toolset", "base", "--owner", OWNER, "--src-tag", SRC_TAG]);
  assert.equal(run.status, 0, run.stderr);
  const parsed = parseGithubOutput(run.outputText);
  assert.equal(parsed.cache_to, historicalCacheTo("base").trimEnd());
  assert.equal(parsed.cache_from, cacheFromFor("base").trimEnd());
});

test("CLI empty --kali-gha-mode is treated as off", () => {
  const run = runCli(["--toolset", "kali-minimal", "--owner", OWNER, "--src-tag", SRC_TAG, "--kali-gha-mode", ""]);
  assert.equal(run.status, 0, run.stderr);
  const parsed = parseGithubOutput(run.outputText);
  assert.equal(parsed.cache_to, registryExport("kali-minimal"));
  assert.ok(!parsed.cache_to.includes("type=gha"));
});

test("CLI invalid --kali-gha-mode exits non-zero", () => {
  const run = runCli(["--toolset", "kali-minimal", "--owner", OWNER, "--src-tag", SRC_TAG, "--kali-gha-mode", "turbo"], { withOutput: false });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /invalid kaliGhaMode/);
});

test("CLI runs without GITHUB_OUTPUT (prints diagnostics only)", () => {
  const run = runCli(["--toolset", "base", "--owner", OWNER, "--src-tag", SRC_TAG], { withOutput: false });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /toolset=base/);
});

// --- ci.yml text contract --------------------------------------------------

test("ci.yml wires cache_policy outputs and preserves all guards", () => {
  const ci = readFileSync(CI, "utf8");
  assert.ok(ci.includes("id: cache_policy"));
  assert.ok(ci.includes("Compute runtime cache policy"));
  assert.match(ci, /name: Compute runtime cache policy[\s\S]*?node agent-harness\/runtime-image-cache-policy\.mjs/);
  assert.ok(ci.includes("cache-from: ${{ steps.cache_policy.outputs.cache_from }}"));
  assert.ok(ci.includes("cache-to: ${{ steps.cache_policy.outputs.cache_to }}"));
  assert.ok(ci.includes("Offline hardened smoke"));
  assert.ok(ci.includes("Free disk for Kali toolchain image"));
  assert.ok(ci.includes("Record reused image"));
  assert.ok(ci.includes("Load reused runtime for offline validation"));
  const summaryPermissions = ci.match(/^  ci-summary:\n[\s\S]*?    permissions:\n((?:      [^\n]+\n)+)/m)?.[1];
  assert.equal(summaryPermissions, "      contents: read\n      actions: read\n", "#992 summary is strictly read-only");
  assert.equal((ci.match(/^\s*permissions:\s*$/gm) || []).length, 5, "only the reviewed read-only summary block was added");
  assert.ok(!ci.includes("continue-on-error"), "no continue-on-error added");
  assert.ok(!/actions:\s*write/.test(ci), "no elevated actions permission");
});
