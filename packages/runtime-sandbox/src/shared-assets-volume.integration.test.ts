import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_SHARED_ASSETS_HELPER_IMAGE, DockerSharedAssetsVolumeManager } from "./shared-assets-volume.js";
import { readDockerWorkspaceFile } from "./runtime-docker.js";

const execFileP = promisify(execFile);
const enabled = process.env.RUN_DOCKER_SHARED_ASSETS_TEST === "1";

test("Docker shared-assets volume is labeled, mounted read-only, and removed", { skip: enabled ? false : "set RUN_DOCKER_SHARED_ASSETS_TEST=1" }, async () => {
  await execFileP("docker", ["pull", DEFAULT_SHARED_ASSETS_HELPER_IMAGE]);
  const manager = new DockerSharedAssetsVolumeManager(DEFAULT_SHARED_ASSETS_HELPER_IMAGE);
  const jobId = randomUUID();
  const temp = await mkdtemp(path.join(os.tmpdir(), "deepsonar-assets-test-"));
  const source = path.join(temp, "fixture.txt");
  await writeFile(source, "immutable fixture\n", "utf8");
  let volume: string | null = null;
  try {
    volume = await manager.prepare({
      jobId,
      files: [{ sourcePath: source, relativePath: "project/fixture.txt" }],
      catalog: { version: 1, readonly: true, assets: [{ key: "fixture.txt" }] },
    });
    assert.equal(volume, `deepsonar-assets-${jobId}`);
    const { stdout } = await execFileP("docker", ["run", "--pull=never", "--rm", "-v", `${volume}:/workspace/.deepsonar/shared:ro`, "--entrypoint", "/bin/sh", DEFAULT_SHARED_ASSETS_HELPER_IMAGE, "-c", "cat /workspace/.deepsonar/shared/project/fixture.txt; cat /workspace/.deepsonar/shared/catalog.json; if echo changed > /workspace/.deepsonar/shared/project/fixture.txt 2>/dev/null; then exit 91; fi"]);
    assert.match(stdout, /immutable fixture/);
    assert.match(stdout, /\"readonly\": true/);
    assert.equal((await manager.listManaged()).some((item) => item.jobId === jobId), true);
    await manager.removeForJob(jobId);
    volume = null;
    await assert.rejects(execFileP("docker", ["volume", "inspect", `deepsonar-assets-${jobId}`]));
  } finally {
    if (volume) await manager.removeForJob(jobId).catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});

test("Docker Agent publish reads one bounded regular-file descriptor", { skip: enabled ? false : "set RUN_DOCKER_SHARED_ASSETS_TEST=1" }, async () => {
  await execFileP("docker", ["pull", DEFAULT_SHARED_ASSETS_HELPER_IMAGE]);
  const name = `deepsonar-assets-read-${randomUUID()}`;
  let containerId = "";
  try {
    const { stdout } = await execFileP("docker", [
      "run", "--pull=never", "-d", "--name", name, "--network", "none", "--entrypoint", "/bin/sh", DEFAULT_SHARED_ASSETS_HELPER_IMAGE, "-c",
      "mkdir -p /workspace/.deepsonar/shared; printf safe-file > /workspace/result.txt; printf secret > /workspace/.deepsonar/shared/secret.txt; ln -s /workspace/.deepsonar/shared/secret.txt /workspace/link.txt; dd if=/dev/zero of=/workspace/large.bin bs=32 count=1 2>/dev/null; sleep 120",
    ]);
    containerId = stdout.trim();
    await execFileP("docker", ["exec", containerId, "/bin/sh", "-c", "for i in $(seq 1 50); do test -f /workspace/result.txt && exit 0; sleep 0.1; done; exit 1"]);
    assert.equal((await readDockerWorkspaceFile(containerId, "/workspace/result.txt", 32)).toString("utf8"), "safe-file");
    await assert.rejects(readDockerWorkspaceFile(containerId, "/workspace/large.bin", 16), /asset_file_too_large/);
    await assert.rejects(readDockerWorkspaceFile(containerId, "/workspace/link.txt", 32), /shared_asset_source_not_regular_file|shared_asset_source_path_forbidden/);
  } finally {
    if (containerId) await execFileP("docker", ["rm", "-f", containerId]).catch(() => undefined);
  }
});
