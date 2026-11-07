#!/usr/bin/env node
/**
 * #975: immutable identity for the per-architecture "current checkout" base image
 * used by reverse-runtime.yml.
 *
 * The workflow builds the same base once per architecture and shares the saved
 * image through a run-scoped artifact. A mutable tag alone cannot prove the
 * consumer loaded the image built from *this* commit, so the producer stamps
 * four labels and every consumer re-reads them after `docker load` and fails
 * closed on any mismatch.
 *
 * Usage:
 *   node agent-harness/reverse-base-identity.mjs \
 *     --sha "$GITHUB_SHA" --arch amd64 --platform linux/amd64
 *   node agent-harness/reverse-base-identity.mjs --verify \
 *     --labels-json-file "$RUNNER_TEMP/base-labels.json" \
 *     --sha "$GITHUB_SHA" --arch amd64 --platform linux/amd64
 *
 * The first form prints the identity summary and appends label_args /
 * artifact_name / save_file to $GITHUB_OUTPUT when that file is available.
 * The verify form exits 1 on any missing or mismatched label.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository variable that gates the shared-base path. Default off. */
export const BASE_REUSE_VARIABLE = "REVERSE_BASE_REUSE";
/** Only this exact value enables reuse; "true"/"1"/"ON" must stay off. */
export const BASE_REUSE_ENABLED_VALUE = "on";

/** Label keys in stable order; buildLabelArgs and identitySummary follow it. */
export const BASE_IDENTITY_LABELS = Object.freeze([
  "org.deepsonar.base.sha",
  "org.deepsonar.base.arch",
  "org.deepsonar.base.platform",
  "org.deepsonar.base.toolset",
]);

const BASE_ARCHES = Object.freeze(["amd64", "arm64"]);
const BASE_TOOLSET = "base";

function describe(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return `${typeof value} ${JSON.stringify(value)}`;
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing required ${field}: got ${describe(value)}`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must be a single line: got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/**
 * Strict opt-in: only the literal value "on" enables the shared base. Every
 * other spelling (unset, "", "true", "1", "ON") keeps the original behaviour
 * of three independent native builds.
 */
export function baseReuseEnabled(value) {
  return String(value).trim() === BASE_REUSE_ENABLED_VALUE;
}

/** Build the label map the produced image must carry. */
export function expectedBaseIdentity({ sha, arch, platform } = {}) {
  return {
    "org.deepsonar.base.sha": requireText(sha, "--sha"),
    "org.deepsonar.base.arch": requireText(arch, "--arch"),
    "org.deepsonar.base.platform": requireText(platform, "--platform"),
    "org.deepsonar.base.toolset": BASE_TOOLSET,
  };
}

function assertArch(arch) {
  if (!BASE_ARCHES.includes(arch)) {
    throw new Error(`unsupported arch ${describe(arch)}; expected one of ${BASE_ARCHES.join(", ")}`);
  }
  return arch;
}

/** Run-scoped artifact name: reverse-base-amd64 / reverse-base-arm64. */
export function baseArtifactName(arch) {
  return `reverse-base-${assertArch(arch)}`;
}

/** File name inside the artifact: reverse-base-amd64.tar.gz. */
export function baseSaveFileName(arch) {
  return `reverse-base-${assertArch(arch)}.tar.gz`;
}

/** docker buildx --label flags in BASE_IDENTITY_LABELS order. */
export function buildLabelArgs(identity) {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error(`identity must be an object, got ${describe(identity)}`);
  }
  const args = [];
  for (const key of BASE_IDENTITY_LABELS) {
    const value = identity[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`identity is missing label ${key}: got ${describe(value)}`);
    }
    args.push("--label", `${key}=${value}`);
  }
  return args;
}

/**
 * Parse `docker image inspect --format '{{json .Config.Labels}}'` output.
 * An image without labels prints `null`, which must fail closed rather than
 * silently verifying nothing.
 */
export function parseImageLabels(dockerInspectJsonText) {
  if (typeof dockerInspectJsonText !== "string" || dockerInspectJsonText.trim() === "") {
    throw new Error(`empty docker image label output: got ${describe(dockerInspectJsonText)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(dockerInspectJsonText);
  } catch (error) {
    throw new Error(`invalid docker image label JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`docker image labels must be a JSON object, got ${describe(parsed)}`);
  }
  return parsed;
}

/**
 * Fail-closed verification. Missing labels, mismatched values (including
 * arch/platform) and an unreadable label map all throw with actual vs expected.
 */
export function verifyBaseIdentity({ labels, expected } = {}) {
  if (labels === null || labels === undefined || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error(`base image has no readable labels (fail closed): got ${describe(labels)}`);
  }
  if (expected === null || expected === undefined || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error(`expected identity must be an object, got ${describe(expected)}`);
  }
  const identity = {};
  const problems = [];
  for (const key of BASE_IDENTITY_LABELS) {
    const want = expected[key];
    if (typeof want !== "string" || want === "") {
      throw new Error(`expected identity is missing ${key}: got ${describe(want)}`);
    }
    const has = Object.prototype.hasOwnProperty.call(labels, key);
    const actual = has ? labels[key] : undefined;
    if (!has || actual === null || actual === undefined || actual === "") {
      problems.push(`${key}: missing (expected ${JSON.stringify(want)})`);
      continue;
    }
    if (String(actual) !== want) {
      problems.push(`${key}: got ${JSON.stringify(String(actual))}, expected ${JSON.stringify(want)}`);
      continue;
    }
    identity[key] = String(actual);
  }
  if (problems.length > 0) {
    throw new Error(`base image identity mismatch:\n${problems.join("\n")}`);
  }
  return { ok: true, identity };
}

/** Stable, sorted `k=v` block for logs and step summaries. */
export function identitySummary(identity) {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error(`identity must be an object, got ${describe(identity)}`);
  }
  return Object.keys(identity)
    .sort()
    .map((key) => `${key}=${identity[key]}`)
    .join("\n");
}

function parseArgs(argv) {
  const opts = { verify: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sha") opts.sha = argv[++i];
    else if (arg === "--arch") opts.arch = argv[++i];
    else if (arg === "--platform") opts.platform = argv[++i];
    else if (arg === "--verify") opts.verify = true;
    else if (arg === "--labels-json-file") opts.labelsJsonFile = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: reverse-base-identity.mjs [--verify --labels-json-file <path>] --sha <sha> --arch <amd64|arm64> --platform <linux/arch>");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const expected = expectedBaseIdentity({ sha: opts.sha, arch: opts.arch, platform: opts.platform });

  if (opts.verify) {
    if (!opts.labelsJsonFile) throw new Error("--verify requires --labels-json-file <path>");
    const labels = parseImageLabels(readFileSync(opts.labelsJsonFile, "utf8"));
    const { identity } = verifyBaseIdentity({ labels, expected });
    console.log(identitySummary(identity));
    console.log("base identity verified");
    return;
  }

  const lines = [
    `label_args=${JSON.stringify(buildLabelArgs(expected))}`,
    `artifact_name=${baseArtifactName(opts.arch)}`,
    `save_file=${baseSaveFileName(opts.arch)}`,
  ];
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${lines.join("\n")}\n`);
  console.log(identitySummary(expected));
  for (const line of lines) console.log(line);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
