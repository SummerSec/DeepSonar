import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as piFixture from "./fixtures/pi-om-real-rpc.mjs";
import { assertInstalledPiImage } from "./pi-image-packaging.mjs";

const packagingOnly = process.argv.includes("--packaging-only");

if (process.argv.includes("--inside")) {
  assert.equal(process.env.DEEPSONAR_PI_IMAGE_PROOF, "1", "Pi RPC smoke must run against an actual built image");
  assert.equal(process.env.DEEPSONAR_PI_BINARY, undefined, "image proof forbids a host Pi binary override");
  const identity = assertInstalledPiImage({
    sourceRoot: process.env.DEEPSONAR_PI_IMAGE_SOURCE_ROOT ?? "/tmp/deepsonar-tests",
    expectedWrapperSha256: process.env.DEEPSONAR_PI_WRAPPER_SHA256,
  });
  if (packagingOnly) {
    console.log(JSON.stringify({ pi_image_packaging: "passed", image_identity: identity }));
  } else {
    console.log(`Installed image identity: OM ${identity.package.version}, Pi ${identity.pi.version}, wrapper ${identity.wrapper.sha256}`);
    // The fixture's explicit image-proof flag selects the canonical installed
    // package and production wrapper. Host mode remains the only branch that
    // relocates a wrapper for local smoke testing.
    const reports = await piFixture.runRealPiRpc();
    assert.equal(reports.length, 8);
    console.log(`Pi 1.4.0 + canonical OM 3.1.4: ${reports.length} offline real-RPC image scenarios passed`);
  }
} else if (process.env.DEEPSONAR_PI_BINARY) {
  assert.equal(packagingOnly, false, "--packaging-only requires the Docker image entrypoint");
  const reports = await piFixture.runRealPiRpc();
  assert.equal(reports.length, 8);
  console.log(`HOST-ONLY Pi 1.4.0 + canonical OM 3.1.4: ${reports.length} offline real-RPC scenarios passed; not image evidence`);
} else {
  const repo = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const wrapperSha256 = createHash("sha256")
    .update(readFileSync(path.join(repo, "agent-harness/pi-observational-memory-governed.ts")))
    .digest("hex");
  const docker = process.env.DEEPSONAR_DOCKER_BINARY
    ?? (process.platform === "win32" ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker");
  if (process.platform === "win32") assert.ok(existsSync(docker), `Docker Desktop CLI is missing: ${docker}`);
  const image = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
    ?? process.env.DEEPSONAR_PI_IMAGE ?? "deepsonar-base:ci";
  const insideArgs = ["--inside", ...(packagingOnly ? ["--packaging-only"] : [])];
  const containerName = `deepsonar-pi-rpc-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const requestedTimeout = Number.parseInt(process.env.DEEPSONAR_PI_RPC_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isInteger(requestedTimeout) && requestedTimeout > 0 && requestedTimeout <= 30 * 60_000
    ? requestedTimeout : 15 * 60_000;
  const child = spawn(docker, ["run", "--rm", "--network", "none", "--read-only",
    "--name", containerName,
    "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
    "-v", `${path.join(repo, "agent-harness/test-pi-rpc.mjs")}:/tmp/deepsonar-tests/test-pi-rpc.mjs:ro`,
    "-v", `${path.join(repo, "agent-harness/pi-image-packaging.mjs")}:/tmp/deepsonar-tests/pi-image-packaging.mjs:ro`,
    "-v", `${path.join(repo, "agent-harness/runtime-images.json")}:/tmp/deepsonar-tests/runtime-images.json:ro`,
    "-v", `${path.join(repo, "agent-harness/fixtures")}:/tmp/deepsonar-tests/fixtures:ro`,
    "-v", `${path.join(repo, "packages/shared-types/src/pi-observational-memory-redaction.ts")}:/tmp/deepsonar-runtime/pi-observational-memory-redaction.ts:ro`,
    "-v", `${path.join(repo, "packages/runtime-sandbox/src/pi-observational-memory.ts")}:/tmp/deepsonar-runtime/pi-observational-memory.ts:ro`,
    "-v", `${path.join(repo, "packages/runtime-sandbox/src/pi-jsonl-framer.ts")}:/tmp/deepsonar-runtime/pi-jsonl-framer.ts:ro`,
    "-v", `${path.join(repo, "packages/runtime-sandbox/src/runtime-adapters.ts")}:/tmp/deepsonar-runtime/runtime-adapters.ts:ro`,
    "-v", `${path.join(repo, "packages/runtime-sandbox/src/pi-rpc-output.ts")}:/tmp/deepsonar-runtime/pi-rpc-output.ts:ro`,
    "-e", "DEEPSONAR_PI_IMAGE_PROOF=1",
    "-e", "DEEPSONAR_PI_IMAGE_SOURCE_ROOT=/tmp/deepsonar-tests",
    "-e", `DEEPSONAR_PI_WRAPPER_SHA256=${wrapperSha256}`,
    "-e", "DEEPSONAR_RPC_BOUNDARY_DIR=/tmp/deepsonar-runtime", image,
    "node", "/tmp/deepsonar-tests/test-pi-rpc.mjs", ...insideArgs], { stdio: "inherit" });
  let timedOut = false;
  let spawnError;
  const result = await new Promise((resolve) => {
    let settled = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`Pi RPC Docker smoke exceeded ${timeoutMs}ms; terminating ${containerName}`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 5000);
    }, timeoutMs);
    timer.unref?.();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(value);
    };
    child.once("error", (error) => {
      spawnError = error;
      console.error(`Pi RPC smoke could not start Docker (${docker}): ${error.message}`);
      finish(undefined);
    });
    child.once("close", (code, signal) => finish({ code, signal }));
  });
  // --rm handles normal exits; this names and removes only this invocation's
  // container if a timeout or daemon failure left one behind.
  spawnSync(docker, ["rm", "-f", containerName], { stdio: "ignore", timeout: 10_000 });
  process.exitCode = spawnError || timedOut ? 124 : (result?.code ?? 1);
}
