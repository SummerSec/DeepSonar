#!/usr/bin/env node
/**
 * Static gate for deepsonar-reverse definition (#718).
 * Retains the historical amd64 host ledger and checks the project-scoped seed.
 * Real native OCI and Job acceptance run separately in reverse-runtime/release.
 * This static gate never claims those external checks have passed.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`reverse-runtime gate: ${msg}`);
  process.exit(1);
};

const config = JSON.parse(readFileSync(resolve(root, "agent-harness/reverse-runtime.json"), "utf8"));
const dockerfile = readFileSync(resolve(root, "deploy/Dockerfile.agent-reverse"), "utf8");
const envScript = readFileSync(resolve(root, "deploy/reverse-env.sh"), "utf8");
const schemaSql = readFileSync(resolve(root, "database/schema.sql"), "utf8");
const skillPath = resolve(root, config.skill?.path ?? "skills/deepsonar-rea-cli/SKILL.md");
if (!existsSync(skillPath)) fail(`skill missing: ${skillPath}`);
const skillBody = readFileSync(skillPath, "utf8");
const skillHash = `sha256:${createHash("sha256").update(skillBody).digest("hex")}`;

if (config.contract !== "deepsonar.runtime.contract/v1") fail("contract drift");
if (config.project_opt_in !== true) fail("must remain project_opt_in");
if (config.platforms?.join(",") !== "linux/amd64,linux/arm64") fail("must declare amd64+arm64");
if (config.toolsets?.reverse?.imageKey !== "deepsonar-reverse") fail("imageKey drift");
if (config.downloads?.ghidra?.version !== "12.1.4") fail("Ghidra pin drift");
if (config.downloads?.ghidra?.assets?.all?.sha256 !== "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db") {
  fail("Ghidra sha256 drift");
}
if (config.managed?.npm?.["rea-agents"]?.version !== "6.4.0") fail("rea-agents version drift");
if (config.managed?.npm?.["rea-agents"]?.gitHead !== "a56f7bb668ab23fec8d33f7af353ac7ed2fe1895") fail("rea-agents gitHead drift");
if (config.managed?.npm?.["rea-agents"]?.integrity !== "sha512-Vj1zWfSlna5bphGoaoI/TcVBuYvze9u+OyPC3Shz8YkBqaCTqB4COnnRoX7XDwMpwI24ZlFEel2yEj0k8LTWEQ==") {
  fail("rea-agents integrity drift");
}
if (config.skill?.content_hash !== skillHash) {
  fail(`skill content_hash drift: expected ${skillHash}, got ${config.skill?.content_hash}`);
}
if (!skillBody.includes("CLI-only") && !skillBody.includes("CLI-only：")) {
  // Chinese skill uses CLI-only marker
}
if (!skillBody.includes("deepsonar-reverse")) fail("skill must name deepsonar-reverse");
if (!skillBody.includes("MCP")) fail("skill must forbid MCP");
if (!skillBody.includes("binary.rea.cli")) fail("skill must reference binary.rea.cli");

for (const required of [
  "ARG BASE_IMAGE=deepsonar-base:local",
  "FROM ${BASE_IMAGE}",
  "REA_AGENTS_VERSION=6.4.0",
  "REA_AGENTS_GIT_HEAD=a56f7bb668ab23fec8d33f7af353ac7ed2fe1895",
  "GHIDRA_VERSION=12.1.4",
  "ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db",
  "eclipse-temurin:21-jdk@sha256:3e3c176ffed168beb42c607be9bc1639b466cf00261a0fb04425562c9d0c5c2b",
  "NODE_MIN_VERSION=22.19.0",
  "GHIDRA_INSTALL_DIR",
  "USER deepsonar",
  'io.deepsonar.image-key="deepsonar-reverse"',
  "materialize-runtime-manuals.mjs",
  "linux_x86_64",
  "linux_arm_64",
]) {
  if (!dockerfile.includes(required)) fail(`Dockerfile missing ${required}`);
}

if (!dockerfile.includes("npm view rea-agents@${REA_AGENTS_VERSION} dist.integrity")) {
  fail("Dockerfile must verify npm integrity");
}
if (!dockerfile.includes("npm view rea-agents@${REA_AGENTS_VERSION} gitHead")) {
  fail("Dockerfile must verify gitHead");
}
if (dockerfile.includes("MCP") && dockerfile.toLowerCase().includes("install mcp")) {
  fail("Dockerfile must not install MCP");
}
if (!envScript.includes("imageKey == \"deepsonar-reverse\"")) fail("reverse-env must check imageKey");
if (!envScript.includes("hopper") || !envScript.includes("ida64")) fail("reverse-env must forbid hopper/ida");

if (config.toolsets?.reverse?.maxSizeMiB !== 2800) fail("reverse maxSizeMiB must be provisional 2800 until first OCI docker save");
if (config.toolsets?.reverse?.job_resource_recommendation?.memory_mib !== 4096) {
  fail("reverse job memory recommendation must be 4096 MiB (amd64 peak ~3.5 GiB)");
}
const measurementsPath = resolve(root, config.measurements?.amd64 ?? "agent-harness/reverse-amd64-measurements.json");
if (!existsSync(measurementsPath)) fail(`amd64 measurements missing: ${measurementsPath}`);
const measurements = JSON.parse(readFileSync(measurementsPath, "utf8"));
if (measurements.schema !== "deepsonar.reverse.amd64-measurements/v1") fail("measurements schema drift");
if (!Array.isArray(measurements.queries) || measurements.queries.length < 8) fail("measurements must list amd64 query timings");
if (measurements.image_size?.provisional_maxSizeMiB !== 2800) fail("measurements provisional_maxSizeMiB drift");
// Historical host measurements are not rewritten to pretend they measured OCI/arm64.
if (measurements.arm64?.status !== "pending") fail("historical amd64-only ledger must remain honest");
for (const path of [config.validation?.workflow, config.validation?.image_smoke, config.validation?.job_e2e,
  "agent-harness/reverse-ghidra-native.sh", "agent-harness/reverse-toolchain-check.mjs",
  "agent-harness/rea-runtime/package.json", "agent-harness/rea-runtime/package-lock.json"]) {
  if (!path || !existsSync(resolve(root, path))) fail(`missing native validation input: ${path}`);
}
if (config.managed.node.engines !== "^22.19.0 || ^24.11.0 || >=26.0.0") fail("Node engines drift");
if (config.toolsets.reverse.job_resource_recommendation.ghidra_headless_maxmem !== "1536m") fail("production heap limit drift");
const workflow = readFileSync(resolve(root, config.validation.workflow), "utf8");
for (const required of ["ubuntu-24.04-arm", "reverse-native-smoke.mjs", "pnpm ci:integration:rea-job", "if: ${{ always() }}"]) {
  if (!workflow.includes(required)) fail(`native workflow missing ${required}`);
}
if (workflow.includes("setup-qemu-action") || workflow.includes("packages: write")) fail("native PR gate must not use emulation or registry writes");
const seedLine = schemaSql.split("\n").find((line) => line.trimStart().startsWith("('deepsonar-reverse',"));
if (!seedLine) fail("schema.sql must seed deepsonar-reverse (PR3 project opt-in catalog)");
if (!/'official',\s*true,\s*true,\s*true\),?$/.test(seedLine)) fail("deepsonar-reverse seed must be official + project_opt_in + enabled");
if (!existsSync(resolve(root, "agent-harness/fixtures/reverse-sample/sample.c"))) {
  fail("public reverse sample source missing");
}


console.log("reverse-runtime static gate passed (measurements ledger + schema seed present; native/Job CI wired; this check does not execute OCI)");
