#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const image = process.argv[2];
const toolset = process.argv[3];
const configPath = process.argv[4];
const targetPlatform = process.argv[5] ?? "linux/amd64";
const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const modes = new Set(["chrome-audit", "chrome-test", "chrome-fuzz"]);
if (!image || !modes.has(toolset) || !config) {
  throw new Error("usage: node test-chrome-runtime.mjs <image> <chrome-audit|chrome-test|chrome-fuzz> <config-json> [linux/amd64|linux/arm64]");
}
if (!/^linux\/(?:amd64|arm64)$/.test(targetPlatform)) {
  throw new Error(`invalid target platform: ${targetPlatform}`);
}
const commands = {
  "chrome-audit": ["/opt/deepsonar/bin/chrome-audit-env.sh", "--check"],
  "chrome-test": ["/opt/deepsonar/bin/chrome-test-env.sh", "--check"],
  "chrome-fuzz": ["/opt/deepsonar/bin/chrome-fuzz-env.sh", "--check"],
}[toolset];
execFileSync("docker", [
  "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image, ...commands,
], { stdio: "inherit" });
if (toolset === "chrome-test") {
  execFileSync("docker", [
    "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image,
    "node", "/opt/deepsonar/chrome-test-smoke.mjs",
  ], { stdio: "inherit" });
} else if (toolset === "chrome-fuzz") {
  execFileSync("docker", [
    "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image,
    "/opt/deepsonar/bin/chrome-fuzz-smoke.sh",
  ], { stdio: "inherit" });
}
const budget = config.toolsets?.[toolset]?.maxSizeMiB;
if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error(`${toolset} missing positive maxSizeMiB`);
console.log(`${toolset} runtime smoke passed; compressed OCI size is measured by release inspect (budget ${budget} MiB)`);
