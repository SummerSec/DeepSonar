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

function runContainer(label, args) {
  try {
    const output = execFileSync("docker", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (output) process.stdout.write(output);
  } catch (error) {
    if (error.stdout?.length) process.stdout.write(error.stdout);
    if (error.stderr?.length) process.stderr.write(error.stderr);
    const status = typeof error.status === "number" ? `退出码 ${error.status}` : `信号 ${error.signal ?? "未知"}`;
    throw new Error(`${label}失败（${status}；平台=${targetPlatform}）`, { cause: error });
  }
}

const commands = {
  "chrome-audit": ["/opt/deepsonar/bin/chrome-audit-env.sh", "--check"],
  "chrome-test": ["/opt/deepsonar/bin/chrome-test-env.sh", "--check"],
  "chrome-fuzz": ["/opt/deepsonar/bin/chrome-fuzz-env.sh", "--check"],
}[toolset];
runContainer("Chrome 运行时环境检查", [
  "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image, ...commands,
]);
if (toolset === "chrome-test") {
  runContainer("Chrome Test CDP 冒烟", [
    "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image,
    "node", "/opt/deepsonar/chrome-test-smoke.mjs",
  ]);
} else if (toolset === "chrome-fuzz") {
  runContainer("Chrome Fuzz d8/libFuzzer 冒烟", [
    "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image,
    "/opt/deepsonar/bin/chrome-fuzz-smoke.sh",
  ]);
}
const budget = config.toolsets?.[toolset]?.maxSizeMiB;
if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error(`${toolset} missing positive maxSizeMiB`);
console.log(`${toolset} runtime smoke passed; compressed OCI size is measured by release inspect (budget ${budget} MiB)`);
