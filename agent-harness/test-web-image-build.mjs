import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const tag = `deepsonar-web-build-test:${randomUUID()}`;
function docker(args, timeout = 20 * 60_000) {
  const result = spawnSync("docker", args, { cwd, stdio: "inherit", timeout });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `docker ${args[0]} failed (${result.signal ?? result.status})`);
}

// Exercise the actual isolated release Dockerfile: no Scheduler source is copied.
// The full-repository typecheck and plan-protocol test still check/execute tests.
try {
  docker(["build", "--file", "deploy/Dockerfile.web", "--tag", tag, "."]);
  docker(["run", "--rm", "--network=none", "--entrypoint", "node", tag, "-e",
    "const fs=require('node:fs'); if(!fs.statSync('/app/public/index.html').size || fs.existsSync('/app/apps/scheduler')) process.exit(1);"], 60_000);
  console.log("Isolated Web release image built with static assets and no Scheduler source");
} finally {
  // Remove only this invocation's image tag, never shared images or build caches.
  spawnSync("docker", ["image", "rm", tag], { cwd, stdio: "inherit", timeout: 30_000 });
}
