import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRealPiRpc } from "./fixtures/pi-om-real-rpc.mjs";

if (process.argv.includes("--inside") || process.env.DEEPSONAR_PI_BINARY) {
  const reports = await runRealPiRpc();
  assert.equal(reports.length, 8);
  console.log(`Pi 1.4.0 + canonical OM 3.1.4: ${reports.length} offline real-RPC scenarios passed`);
} else {
  const repo = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const image = process.argv[2] ?? process.env.DEEPSONAR_PI_IMAGE ?? "deepsonar-base:ci";
  const child = spawn("docker", ["run", "--rm", "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
    "-v", `${path.join(repo, "agent-harness")}:/tmp/deepsonar-tests:ro`,
    "-v", `${path.join(repo, "packages/runtime-sandbox/src")}:/tmp/deepsonar-runtime:ro`,
    "-v", `${path.join(repo, "agent-harness/pi-observational-memory-governed.ts")}:/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts:ro`,
    "-e", "DEEPSONAR_RPC_BOUNDARY_DIR=/tmp/deepsonar-runtime", image,
    "node", "/tmp/deepsonar-tests/test-pi-rpc.mjs", "--inside"], { stdio: "inherit" });
  child.on("error", (error) => { console.error(`Pi RPC smoke could not start Docker: ${error.message}`); process.exitCode = 1; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  process.exitCode = code ?? 1;
}
