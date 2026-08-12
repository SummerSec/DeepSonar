import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL } from "./agentbox.js";
import { DockerSharedAssetsVolumeManager } from "./shared-assets-volume.js";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const volumeName = `deepsonar-assets-${jobId}`;
const helperName = `deepsonar-assets-writer-${jobId}`;

function inspectedVolume(): string {
  return JSON.stringify({
    Name: volumeName,
    Driver: "local",
    Scope: "local",
    Labels: {
      [SHARED_ASSETS_VOLUME_LABEL]: "true",
      [SHARED_ASSETS_JOB_LABEL]: jobId,
    },
  });
}

async function sourceFile(): Promise<{ directory: string; sourcePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-assets-unit-"));
  const sourcePath = path.join(directory, "fixture.txt");
  await writeFile(sourcePath, "fixture\n", "utf8");
  return { directory, sourcePath };
}

function prepareInput(sourcePath: string) {
  return {
    jobId,
    image: "test-image",
    files: [{ sourcePath, relativePath: "fixture.txt" }],
    catalog: { version: 1 },
  };
}

test("正常准备会按顺序清理、创建、复制并删除 helper 容器", async () => {
  const { directory, sourcePath } = await sourceFile();
  const calls: string[][] = [];
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "inspect") {
      return inspectedVolume();
    }
    return "";
  };

  try {
    const manager = new DockerSharedAssetsVolumeManager(executeDocker);
    assert.equal(await manager.prepare(prepareInput(sourcePath)), volumeName);
    assert.deepEqual(calls.slice(0, 4), [
      ["rm", "-f", helperName],
      ["volume", "inspect", volumeName, "--format", "{{json .}}"],
      ["volume", "rm", "-f", volumeName],
      ["volume", "create", "--driver", "local", "--label", `${SHARED_ASSETS_VOLUME_LABEL}=true`, "--label", `${SHARED_ASSETS_JOB_LABEL}=${jobId}`, volumeName],
    ]);
    const createIndex = calls.findIndex((args) => args[0] === "create");
    assert.ok(createIndex > 0);
    assert.deepEqual(calls.slice(createIndex, createIndex + 2).map((args) => args[0]), ["create", "cp"]);
    assert.equal(calls.filter((args) => args[0] === "rm" && args[2] === helperName).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("docker create 失败也会清理可能已创建的容器和卷", async () => {
  const { directory, sourcePath } = await sourceFile();
  const calls: string[][] = [];
  const createError = new Error("创建失败");
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "inspect") {
      return inspectedVolume();
    }
    if (args[0] === "create") throw createError;
    return "";
  };

  try {
    const manager = new DockerSharedAssetsVolumeManager(executeDocker);
    await assert.rejects(manager.prepare(prepareInput(sourcePath)), (error: unknown) => error === createError);
    const createIndex = calls.findIndex((args) => args[0] === "create");
    const helperRemoveIndex = calls.findIndex((args, index) => index > createIndex && args[0] === "rm" && args[2] === helperName);
    const volumeRemoveIndex = calls.findIndex((args, index) => index > createIndex && args[0] === "volume" && args[1] === "rm");
    assert.ok(helperRemoveIndex > createIndex);
    assert.ok(volumeRemoveIndex > helperRemoveIndex);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("复制失败且容器清理失败时保留复制错误", async () => {
  const { directory, sourcePath } = await sourceFile();
  const copyError = new Error("复制失败");
  const cleanupError = new Error("清理失败");
  const calls: string[][] = [];
  let helperRemoves = 0;
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "inspect") {
      return inspectedVolume();
    }
    if (args[0] === "cp") throw copyError;
    if (args[0] === "rm" && args[2] === helperName) {
      helperRemoves += 1;
      if (helperRemoves === 2) throw cleanupError;
    }
    return "";
  };

  try {
    const manager = new DockerSharedAssetsVolumeManager(executeDocker);
    await assert.rejects(manager.prepare(prepareInput(sourcePath)), (error: unknown) => error === copyError);
    assert.equal(helperRemoves, 2);
    assert.ok(calls.some((args) => args[0] === "volume" && args[1] === "rm"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("复制成功但 helper 清理失败时准备失败并尝试回收卷", async () => {
  const { directory, sourcePath } = await sourceFile();
  const cleanupError = new Error("helper 清理失败");
  const calls: string[][] = [];
  let helperRemoves = 0;
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "inspect") {
      return inspectedVolume();
    }
    if (args[0] === "rm" && args[2] === helperName) {
      helperRemoves += 1;
      if (helperRemoves === 2) throw cleanupError;
    }
    return "";
  };

  try {
    const manager = new DockerSharedAssetsVolumeManager(executeDocker);
    await assert.rejects(manager.prepare(prepareInput(sourcePath)), (error: unknown) => error === cleanupError);
    assert.equal(helperRemoves, 2);
    assert.ok(calls.some((args) => args[0] === "volume" && args[1] === "rm"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("重试准备时每次运行前都会清理固定容器名", async () => {
  const { directory, sourcePath } = await sourceFile();
  const calls: string[][] = [];
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "inspect") {
      return inspectedVolume();
    }
    return "";
  };

  try {
    const manager = new DockerSharedAssetsVolumeManager(executeDocker);
    await manager.prepare(prepareInput(sourcePath));
    await manager.prepare(prepareInput(sourcePath));
    const volumeCreateIndexes = calls.flatMap((args, index) => args[0] === "volume" && args[1] === "create" ? [index] : []);
    assert.equal(volumeCreateIndexes.length, 2);
    assert.equal(calls.filter((args) => args[0] === "rm" && args[2] === helperName).length, 4);
    for (const volumeCreateIndex of volumeCreateIndexes) {
      assert.deepEqual(calls.slice(volumeCreateIndex - 3, volumeCreateIndex + 1).map(([command, subcommand]) => [command, subcommand]), [
        ["rm", "-f"], ["volume", "inspect"], ["volume", "rm"], ["volume", "create"],
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
