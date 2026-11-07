#!/usr/bin/env node
// #974: the runtime-images matrix builds base / audit / kali-minimal with one shared
// policy. On hot cache hits the GHA `mode=max` export moves Kali's large layers a
// second time (measured 96-460s) on top of the ~2.4s registry export. Keep the
// registry export and the GHA read fallback for every toolset, but drop the duplicate
// Kali GHA mode=max export by default. `vars.RUNTIME_CACHE_KALI_GHA` can restore
// `min` / `max` without a code change. Zero dependencies; runnable via node --test.

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KALI_GHA_MODES = Object.freeze(["off", "min", "max"]);
export const RUNTIME_CACHE_KALI_GHA_VARIABLE = "RUNTIME_CACHE_KALI_GHA";

const DEFAULT_KALI_GHA_MODE = "off";
const KNOWN_TOOLSETS = Object.freeze(["base", "audit", "kali-minimal"]);
const GITHUB_OUTPUT_DELIMITER = "DEEPSONAR_CACHE_POLICY_EOF";

function registryRef(owner, toolset, tag) {
  return `ghcr.io/${owner}/deepsonar-${toolset}:${tag}`;
}

/** GH `vars.X` renders as an empty string when unconfigured: unset / empty => "off". */
function normalizeKaliGhaMode(kaliGhaMode) {
  if (kaliGhaMode === undefined || kaliGhaMode === null || kaliGhaMode === "") {
    return DEFAULT_KALI_GHA_MODE;
  }
  if (!KALI_GHA_MODES.includes(kaliGhaMode)) {
    throw new Error(
      `invalid kaliGhaMode ${JSON.stringify(kaliGhaMode)}; expected one of ${KALI_GHA_MODES.join(", ")} `
      + `(or unset / empty for "${DEFAULT_KALI_GHA_MODE}")`,
    );
  }
  return kaliGhaMode;
}

/**
 * Build the buildx cache-from / cache-to strings for one runtime-images matrix leg.
 * Returns multi-line strings (trailing "\n"). Throws on any unknown or missing input
 * (fail closed); eventName is informational only and never weakens the policy.
 */
export function runtimeImageCachePolicy({ toolset, owner, srcTag, kaliGhaMode, eventName } = {}) {
  if (typeof toolset !== "string" || !KNOWN_TOOLSETS.includes(toolset)) {
    throw new Error(`unknown toolset ${JSON.stringify(toolset)}; expected one of ${KNOWN_TOOLSETS.join(", ")}`);
  }
  if (typeof owner !== "string" || owner.trim() === "") {
    throw new Error("missing owner: expected a non-empty GHCR namespace");
  }
  if (typeof srcTag !== "string" || srcTag.trim() === "") {
    throw new Error("missing srcTag: expected a non-empty fingerprint src tag");
  }
  const mode = normalizeKaliGhaMode(kaliGhaMode);
  const event = typeof eventName === "string" && eventName !== "" ? eventName : "unspecified";

  const buildcacheRef = registryRef(owner, toolset, "buildcache-ci");
  const srcRef = registryRef(owner, toolset, srcTag);
  const ghaScope = `runtime-${toolset}`;

  // Identical for every toolset: two registry reads + a GHA read fallback so fork PRs
  // (no packages:write) and cache misses still resolve a layer source.
  const cacheFrom = [
    `type=registry,ref=${buildcacheRef}`,
    `type=registry,ref=${srcRef}`,
    `type=gha,scope=${ghaScope}`,
    "",
  ].join("\n");

  const registryExport = `type=registry,ref=${buildcacheRef},mode=max,ignore-error=true`;
  const ghaMaxExport = `type=gha,mode=max,scope=${ghaScope}`;
  const reasons = [
    `event=${event}: cache-from keeps two registry reads and the GHA read fallback (scope=${ghaScope}) so fork PRs without packages:write still resolve`,
    "registry export keeps ignore-error=true for fork PRs without packages:write",
  ];

  let cacheTo;
  if (toolset === "kali-minimal") {
    const lines = [registryExport];
    if (mode === "min") {
      lines.push(`type=gha,mode=min,scope=${ghaScope}`);
      reasons.push(`kaliGhaMode=min: opt-in small GHA mode=min export via vars.${RUNTIME_CACHE_KALI_GHA_VARIABLE}`);
    } else if (mode === "max") {
      lines.push(ghaMaxExport);
      reasons.push(`kaliGhaMode=max: legacy full GHA mode=max export restored via vars.${RUNTIME_CACHE_KALI_GHA_VARIABLE}`);
    } else {
      reasons.push(`kaliGhaMode=off (default): drop duplicate GHA mode=max export of Kali large layers (measured 96-460s vs ~2.4s registry export)`);
    }
    cacheTo = [...lines, ""].join("\n");
  } else {
    // base / audit keep the historical two exports byte-for-byte (their export cost
    // has not been measured separately, so do not change behaviour here).
    reasons.push(`toolset=${toolset}: preserve historical registry + GHA mode=max exports byte-for-byte`);
    cacheTo = [registryExport, ghaMaxExport, ""].join("\n");
  }

  return { cacheFrom, cacheTo, reasons };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--toolset") options.toolset = argv[++index];
    else if (argument === "--owner") options.owner = argv[++index];
    else if (argument === "--src-tag") options.srcTag = argv[++index];
    else if (argument === "--kali-gha-mode") options.kaliGhaMode = argv[++index];
    else if (argument === "--event-name") options.eventName = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node agent-harness/runtime-image-cache-policy.mjs --toolset <s> --owner <s> --src-tag <s> [--kali-gha-mode off|min|max] [--event-name <s>]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

/** value ends with "\n"; that newline separates its last content line from the delimiter. */
function heredoc(name, value) {
  return `${name}<<${GITHUB_OUTPUT_DELIMITER}\n${value}${GITHUB_OUTPUT_DELIMITER}\n`;
}

function writeGitHubOutput(policy) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, [
    heredoc("cache_from", policy.cacheFrom),
    heredoc("cache_to", policy.cacheTo),
  ].join(""));
}

function main() {
  let options;
  let policy;
  try {
    options = parseArgs(process.argv.slice(2));
    policy = runtimeImageCachePolicy(options);
  } catch (error) {
    console.error(`runtime-image-cache-policy: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  writeGitHubOutput(policy);
  console.log(
    `runtime-image-cache-policy: toolset=${options.toolset} `
    + `kaliGhaMode=${normalizeKaliGhaMode(options.kaliGhaMode)} `
    + `event=${options.eventName || "unspecified"} `
    + `cacheFromLines=${policy.cacheFrom.trimEnd().split("\n").length} `
    + `cacheToLines=${policy.cacheTo.trimEnd().split("\n").length}`,
  );
  for (const reason of policy.reasons) console.log(`  reason: ${reason}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
