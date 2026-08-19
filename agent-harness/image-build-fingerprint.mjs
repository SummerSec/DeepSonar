#!/usr/bin/env node
/**
 * Content-addressed build fingerprint for release/CI image skip-if-unchanged.
 *
 * Usage:
 *   node agent-harness/image-build-fingerprint.mjs --preset deepsonar-base
 *   node agent-harness/image-build-fingerprint.mjs --preset deepsonar-openharmony-test \
 *     --build-arg BASE_IMAGE=ghcr.io/x/deepsonar-base@sha256:...
 *
 * Prints fingerprint=/src_tag=/platforms= and appends the same lines to $GITHUB_OUTPUT when set.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Bump this when the fingerprint algorithm or its input semantics change.
// Keep the version explicit so adding an unrelated preset does not invalidate
// every existing image's src-* cache tag.
export const FINGERPRINT_SCHEMA_VERSION = "v2";
export const COMMON_FINGERPRINT_PATHS = [".dockerignore"];

/** @type {Record<string, { dockerfile: string, paths: string[], buildArgs?: string[], platforms: string }>} */
export const PRESETS = {
  "deepsonar-base": {
    dockerfile: "deploy/Dockerfile.agent",
    paths: [
      "agent-harness/runtime-images.json",
      "agent-harness/write-tool-manifest.mjs",
    ],
    buildArgs: ["TOOLSET=base"],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-audit": {
    dockerfile: "deploy/Dockerfile.agent",
    paths: [
      "agent-harness/runtime-images.json",
      "agent-harness/write-tool-manifest.mjs",
    ],
    buildArgs: ["TOOLSET=audit"],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-kali-minimal": {
    dockerfile: "deploy/Dockerfile.agent-kali-minimal",
    paths: [
      "agent-harness/kali-minimal-runtime.json",
      "agent-harness/write-tool-manifest.mjs",
    ],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-scheduler": {
    dockerfile: "deploy/Dockerfile.scheduler",
    paths: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "apps/scheduler",
      "apps/image-admission/package.json",
      "apps/web/package.json",
      "packages",
      "database",
      "agent-harness/demo-repo",
      "deploy/runtime-image-registry.json",
    ],
    platforms: "linux/amd64",
  },
  "deepsonar-web": {
    dockerfile: "deploy/Dockerfile.web",
    paths: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "apps/web",
      "packages/shared-types",
      "deploy/web-server.mjs",
    ],
    platforms: "linux/amd64",
  },
  "deepsonar-image-admission": {
    dockerfile: "deploy/Dockerfile.image-admission",
    paths: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "apps/image-admission",
    ],
    platforms: "linux/amd64",
  },
  "deepsonar-assets-helper": {
    dockerfile: "deploy/Dockerfile.assets-helper",
    paths: [],
    platforms: "linux/amd64",
  },
  "deepsonar-openharmony-test": {
    dockerfile: "deploy/Dockerfile.agent-openharmony",
    paths: [
      "deploy/vendor/gitcode-repo-py3",
      "deploy/openharmony-env.sh",
      "deploy/openharmony-init.sh",
      "deploy/openharmony-build.sh",
    ],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-openharmony-audit": {
    dockerfile: "deploy/Dockerfile.agent-openharmony-audit",
    paths: [
      "deploy/vendor/gitcode-repo-py3",
      "deploy/openharmony-env.sh",
      "deploy/openharmony-init.sh",
      "deploy/openharmony-build.sh",
      "deploy/openharmony-audit-env.sh",
      "deploy/openharmony-audit-scan.sh",
    ],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-openharmony-fuzz": {
    dockerfile: "deploy/Dockerfile.agent-openharmony-fuzz",
    paths: [
      "deploy/vendor/gitcode-repo-py3",
      "deploy/openharmony-env.sh",
      "deploy/openharmony-init.sh",
      "deploy/openharmony-build.sh",
      "deploy/openharmony-fuzz-env.sh",
      "deploy/openharmony-fuzz-build.sh",
    ],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-chrome-audit": {
    dockerfile: "deploy/Dockerfile.agent-chrome-audit",
    paths: [
      "agent-harness/chrome-audit-runtime.json",
      "deploy/chrome-runtime-sources.json",
      "deploy/chrome-audit-rules.yml",
      "deploy/chrome-audit-env.sh",
      "deploy/chrome-audit-scan.sh",
    ],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-chrome-test": {
    dockerfile: "deploy/Dockerfile.agent-chrome-test",
    paths: [
      "agent-harness/chrome-test-runtime.json",
      "deploy/chrome-runtime-sources.json",
      "deploy/chrome-headless.sh",
      "deploy/chrome-test-env.sh",
      "agent-harness/chrome-test-smoke.mjs",
    ],
    platforms: "linux/amd64,linux/arm64",
  },
  "deepsonar-chrome-fuzz": {
    dockerfile: "deploy/Dockerfile.agent-chrome-fuzz",
    paths: [
      "agent-harness/chrome-fuzz-runtime.json",
      "deploy/chrome-runtime-sources.json",
      "deploy/chrome-fuzz-env.sh",
      "deploy/chrome-fuzz-smoke.sh",
      "deploy/chrome-fuzz-toolchain-preflight.sh",
    ],
    platforms: "linux/amd64,linux/arm64",
  },
};

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function walkFiles(absPath, out = []) {
  if (!existsSync(absPath)) fail(`fingerprint path missing: ${relative(root, absPath) || absPath}`);
  const st = statSync(absPath);
  if (st.isDirectory()) {
    for (const name of readdirSync(absPath).sort()) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      walkFiles(resolve(absPath, name), out);
    }
    return out;
  }
  if (st.isFile()) out.push(absPath);
  return out;
}

function parseArgs(argv) {
  /** @type {{ preset?: string, dockerfile?: string, paths: string[], buildArgs: string[], platforms?: string }} */
  const opts = { paths: [], buildArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--preset") opts.preset = argv[++i];
    else if (a === "--dockerfile") opts.dockerfile = argv[++i];
    else if (a === "--path") opts.paths.push(argv[++i]);
    else if (a === "--build-arg") opts.buildArgs.push(argv[++i]);
    else if (a === "--platforms") opts.platforms = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: image-build-fingerprint.mjs --preset <key> [--build-arg K=V]...");
      process.exit(0);
    } else fail(`unknown arg: ${a}`);
  }
  return opts;
}

export function computeFingerprint(opts) {
  let dockerfile = opts.dockerfile;
  let paths = [...(opts.paths || [])];
  let buildArgs = [...(opts.buildArgs || [])];
  let platforms = opts.platforms;

  if (opts.preset) {
    const preset = PRESETS[opts.preset];
    if (!preset) fail(`unknown preset: ${opts.preset}; known: ${Object.keys(PRESETS).join(", ")}`);
    dockerfile = dockerfile || preset.dockerfile;
    paths = [...preset.paths, ...paths];
    buildArgs = [...(preset.buildArgs || []), ...buildArgs];
    platforms = platforms || preset.platforms;
  }
  if (!dockerfile) fail("missing --dockerfile or --preset");
  if (!platforms) fail("missing --platforms or preset platforms");

  const h = createHash("sha256");
  h.update(`schema:${FINGERPRINT_SCHEMA_VERSION}\n`);
  h.update(`dockerfile:${dockerfile.replaceAll("\\", "/")}\n`);
  h.update(`platforms:${platforms}\n`);
  for (const arg of [...buildArgs].sort()) h.update(`build-arg:${arg}\n`);

  const files = new Set();
  files.add(resolve(root, dockerfile));
  for (const p of [...COMMON_FINGERPRINT_PATHS, ...paths]) {
    for (const f of walkFiles(resolve(root, p))) files.add(f);
  }

  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  for (const abs of sorted) {
    const rel = relative(root, abs).split(sep).join("/");
    const body = readFileSync(abs);
    h.update(`file:${rel}\n`);
    h.update(body);
    h.update("\n");
  }

  const fingerprint = h.digest("hex").slice(0, 32);
  return {
    fingerprint,
    src_tag: `src-${fingerprint}`,
    platforms,
    preset: opts.preset || "",
  };
}

function main() {
  const result = computeFingerprint(parseArgs(process.argv.slice(2)));
  const lines = [
    `fingerprint=${result.fingerprint}`,
    `src_tag=${result.src_tag}`,
    `platforms=${result.platforms}`,
  ];
  if (result.preset) lines.push(`preset=${result.preset}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${lines.join("\n")}\n`);
  for (const line of lines) console.log(line);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
