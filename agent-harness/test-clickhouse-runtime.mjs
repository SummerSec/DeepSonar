#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const image = process.argv[2];
const toolset = process.argv[3];
const configPath = process.argv[4];
const targetPlatform = process.argv[5] ?? "linux/amd64";
const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const modes = new Set(["clickhouse-audit", "clickhouse-test", "clickhouse-fuzz"]);
if (!image || !modes.has(toolset) || !config) {
  throw new Error("usage: node test-clickhouse-runtime.mjs <image> <clickhouse-audit|clickhouse-test|clickhouse-fuzz> <config-json> [linux/amd64|linux/arm64]");
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
  "clickhouse-audit": ["/opt/deepsonar/bin/clickhouse-audit-env.sh", "--check"],
  "clickhouse-test": ["/opt/deepsonar/bin/clickhouse-test-env.sh", "--check"],
  "clickhouse-fuzz": ["/opt/deepsonar/bin/clickhouse-fuzz-env.sh", "--check"],
}[toolset];
runContainer("ClickHouse 运行时环境检查", [
  "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image, ...commands,
]);
if (toolset === "clickhouse-test") {
  runContainer("ClickHouse Test HTTP 冒烟", [
    "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image,
    "node", "/opt/deepsonar/clickhouse-test-smoke.mjs",
  ]);
} else if (toolset === "clickhouse-fuzz") {
  runContainer("ClickHouse Fuzz clickhouse-local 冒烟", [
    "run", "--platform", targetPlatform, "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--cpus", "2", "--memory", "2g", "--pids-limit", "512", image,
    "/opt/deepsonar/bin/clickhouse-fuzz-smoke.sh",
  ]);
}
const budget = config.toolsets?.[toolset]?.maxSizeMiB;
if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error(`${toolset} missing positive maxSizeMiB`);
console.log(`${toolset} runtime smoke passed; compressed OCI size is measured by release inspect (budget ${budget} MiB)`);
