import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL } from "./agentbox.js";
import {
  DEFAULT_SHARED_ASSETS_HELPER_IMAGE,
  DockerCommandTimeoutError,
  DockerSharedAssetsVolumeManager,
  SHARED_ASSETS_DOCKER_COMMAND_TIMEOUT_MS,
  isDockerCommandTimeout,
} from "./shared-assets-volume.js";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const volumeName = `deepsonar-assets-${jobId}`;
const helperName = `deepsonar-assets-writer-${jobId}`;
const helperImage = DEFAULT_SHARED_ASSETS_HELPER_IMAGE;

test("Docker 命令超时具有稳定错误类别，不与普通 provision 超时混淆", () => {
  const command = ["create", "--pull=never", helperImage];
  const error = new DockerCommandTimeoutError(command, SHARED_ASSETS_DOCKER_COMMAND_TIMEOUT_MS);
  assert.equal(error.code, "DOCKER_COMMAND_TIMEOUT");
  assert.equal(error.name, "DockerCommandTimeoutError");
  assert.equal(error.timeoutMs, 60_000);
  assert.deepEqual(error.command, command);
  assert.match(error.message, /Docker 命令超时/);
  assert.equal(isDockerCommandTimeout(error), true);
  assert.equal(isDockerCommandTimeout(Object.assign(new Error("child timeout"), { code: "ETIMEDOUT" })), true);
  assert.equal(isDockerCommandTimeout(new Error("provision 超时")), false);
});

function inspectedVolume(
  name = volumeName,
  labels: Record<string, string> | null = {
    [SHARED_ASSETS_VOLUME_LABEL]: "true",
    [SHARED_ASSETS_JOB_LABEL]: jobId,
  },
): string {
  return JSON.stringify({
    Name: name,
    Driver: "local",
    Scope: "local",
    Labels: labels,
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
    files: [{ sourcePath, relativePath: "fixture.txt" }],
    catalog: { version: 1 },
  };
}

test("构造器只接受带小写 sha256 digest 的不可变 OCI helper 镜像", () => {
  for (const image of [
    "docker.io/library/busybox:latest",
    `docker.io/library/busybox@sha256:${"A".repeat(64)}`,
    `docker.io/library/busybox@sha256:${"a".repeat(63)}`,
    "docker.io/library/busybox",
  ]) {
    assert.throws(
      () => new DockerSharedAssetsVolumeManager(image),
      /带小写 sha256 digest 的不可变 OCI 引用/,
    );
  }
  assert.doesNotThrow(() => new DockerSharedAssetsVolumeManager(helperImage));
  assert.doesNotThrow(() => new DockerSharedAssetsVolumeManager(
    `ghcr.io/summersec/deepsonar-assets-helper@sha256:${"a".repeat(64)}`,
  ));
});

test("helper image inspect 失败时不产生 helper 或卷副作用", async () => {
  const inspectError = new Error("helper 镜像不在本地");
  const calls: string[][] = [];
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") throw inspectError;
    return "";
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
  await assert.rejects(manager.prepare(prepareInput("/missing/fixture.txt")), (error: unknown) => error === inspectError);
  assert.deepEqual(calls, [["image", "inspect", helperImage]]);
});

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
    const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
    assert.equal(await manager.prepare(prepareInput(sourcePath)), volumeName);
    assert.deepEqual(calls.slice(0, 5), [
      ["image", "inspect", helperImage],
      ["rm", "-f", helperName],
      ["volume", "inspect", volumeName, "--format", "{{json .}}"],
      ["volume", "rm", "-f", volumeName],
      ["volume", "create", "--driver", "local", "--label", `${SHARED_ASSETS_VOLUME_LABEL}=true`, "--label", `${SHARED_ASSETS_JOB_LABEL}=${jobId}`, volumeName],
    ]);
    const createIndex = calls.findIndex((args) => args[0] === "create");
    assert.ok(createIndex > 0);
    assert.deepEqual(calls.slice(createIndex, createIndex + 2).map((args) => args[0]), ["create", "cp"]);
    assert.deepEqual(calls[createIndex], [
      "create", "--pull=never", "--name", helperName, "--network", "none", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--read-only", "-v", `${volumeName}:/assets`, helperImage,
    ]);
    assert.equal(calls[createIndex]?.includes("--entrypoint"), false);
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
    const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
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
    const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
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
    const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
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
    const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
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

test("listManaged 合并 label 与名称扫描并对重复卷去重", async () => {
  const secondJobId = "223e4567-e89b-12d3-a456-426614174000";
  const secondVolumeName = `deepsonar-assets-${secondJobId}`;
  const unlabeledJobId = "323e4567-e89b-12d3-a456-426614174000";
  const unlabeledVolumeName = `deepsonar-assets-${unlabeledJobId}`;
  const calls: string[][] = [];
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "ls") {
      return args[3] === `label=${SHARED_ASSETS_VOLUME_LABEL}=true`
        ? `${volumeName}\n${secondVolumeName}\n`
        : `${volumeName}\n${unlabeledVolumeName}\n`;
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      if (args[2] === volumeName) return inspectedVolume();
      if (args[2] === unlabeledVolumeName) return inspectedVolume(unlabeledVolumeName, null);
      return inspectedVolume(secondVolumeName, {
        [SHARED_ASSETS_VOLUME_LABEL]: "true",
        [SHARED_ASSETS_JOB_LABEL]: secondJobId,
      });
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
  const managed = await manager.listManaged();
  assert.deepEqual(managed.map(({ volumeName: name, jobId: id }) => ({ volumeName: name, jobId: id })), [
    { volumeName, jobId },
    { volumeName: secondVolumeName, jobId: secondJobId },
    { volumeName: unlabeledVolumeName, jobId: unlabeledJobId },
  ]);
  assert.equal(calls.filter((args) => args[0] === "volume" && args[1] === "inspect").length, 3);
});

test("listManaged 通过严格名称识别无标签合法卷", async () => {
  const calls: string[][] = [];
  const executeDocker = async (...args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "ls") {
      return args[3] === `label=${SHARED_ASSETS_VOLUME_LABEL}=true` ? "" : `${volumeName}\n`;
    }
    if (args[0] === "volume" && args[1] === "inspect") return inspectedVolume(volumeName, null);
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
  assert.deepEqual(await manager.listManaged(), [{ volumeName, jobId }]);
  assert.equal(calls.filter((args) => args[0] === "volume" && args[1] === "inspect").length, 1);
});

test("listManaged 返回 Docker 创建时间供孤儿卷年龄指标使用", async () => {
  const createdAt = "2026-08-12T03:00:00Z";
  const executeDocker = async (...args: string[]): Promise<string> => {
    if (args[0] === "volume" && args[1] === "ls") return args[3]?.startsWith("label=") ? "" : volumeName;
    if (args[0] === "volume" && args[1] === "inspect") {
      return JSON.stringify({
        Name: volumeName,
        Driver: "local",
        Scope: "local",
        Labels: null,
        CreatedAt: createdAt,
      });
    }
    throw new Error(`非预期 Docker 命令：${args.join(" ")}`);
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
  assert.deepEqual(await manager.listManaged(), [{ volumeName, jobId, createdAt }]);
});

test("listManaged 排除相似、畸形和标签归属不一致的名称", async () => {
  const mismatchedVolumeName = "deepsonar-assets-223e4567-e89b-12d3-a456-426614174000";
  const names = [
    volumeName,
    "deepsonar-assets-123e4567-e89b-12d3-a456-42661417400",
    "deepsonar-assets-123e4567e89b12d3a456426614174000",
    `${volumeName}-extra`,
    "deepsonar-assets-not-a-job",
    `prefix-${volumeName}`,
    mismatchedVolumeName,
  ];
  const inspectedNames: string[] = [];
  const executeDocker = async (...args: string[]): Promise<string> => {
    if (args[0] === "volume" && args[1] === "ls") return names.join("\n");
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args[2];
      inspectedNames.push(name);
      return name === mismatchedVolumeName
        ? inspectedVolume(name, { [SHARED_ASSETS_JOB_LABEL]: jobId })
        : inspectedVolume(name, null);
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker);
  assert.deepEqual(await manager.listManaged(), [{ volumeName, jobId }]);
  assert.deepEqual(inspectedNames, [volumeName, mismatchedVolumeName]);
});

test("removeForJob 删除失败时有限重试并在成功后返回", async () => {
  let removeAttempts = 0;
  const removeError = new Error("卷暂时被占用");
  const executeDocker = async (...args: string[]): Promise<string> => {
    if (args[0] === "volume" && args[1] === "inspect") return inspectedVolume(volumeName, null);
    if (args[0] === "volume" && args[1] === "rm") {
      removeAttempts += 1;
      if (removeAttempts < 3) throw removeError;
      return "";
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker, async () => {});
  await manager.removeForJob(jobId);
  assert.equal(removeAttempts, 3);
});

test("removeForJob 仅把明确不存在当作幂等成功", async () => {
  let removeAttempts = 0;
  const executeDocker = async (...args: string[]): Promise<string> => {
    if (args[0] === "volume" && args[1] === "inspect") {
      const error = new Error(`Error: No such volume: ${volumeName}`);
      throw error;
    }
    if (args[0] === "volume" && args[1] === "rm") removeAttempts += 1;
    return "";
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker, async () => {});
  await manager.removeForJob(jobId);
  assert.equal(removeAttempts, 0);
});

test("removeForJob 对 inspect 基础设施错误重试且不伪装成卷不存在", async () => {
  let inspectAttempts = 0;
  let removeAttempts = 0;
  const delays: number[] = [];
  const daemonError = new Error("Docker daemon unavailable");
  const executeDocker = async (...args: string[]): Promise<string> => {
    if (args[0] === "volume" && args[1] === "inspect") {
      inspectAttempts += 1;
      if (inspectAttempts < 3) throw daemonError;
      return inspectedVolume();
    }
    if (args[0] === "volume" && args[1] === "rm") {
      removeAttempts += 1;
      return "";
    }
    throw new Error(`非预期 Docker 命令：${args.join(" ")}`);
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker, async (delay) => {
    delays.push(delay);
  });
  await manager.removeForJob(jobId);
  assert.equal(inspectAttempts, 3);
  assert.equal(removeAttempts, 1);
  assert.deepEqual(delays, [100, 200]);
});

test("removeForJob 重试耗尽后继续抛出最终删除错误", async () => {
  let removeAttempts = 0;
  const removeError = new Error("Docker daemon unavailable");
  const executeDocker = async (...args: string[]): Promise<string> => {
    if (args[0] === "volume" && args[1] === "inspect") return inspectedVolume();
    if (args[0] === "volume" && args[1] === "rm") {
      removeAttempts += 1;
      throw removeError;
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };

  const manager = new DockerSharedAssetsVolumeManager(helperImage, executeDocker, async () => {});
  await assert.rejects(manager.removeForJob(jobId), (error: unknown) => error === removeError);
  assert.equal(removeAttempts, 3);
});
