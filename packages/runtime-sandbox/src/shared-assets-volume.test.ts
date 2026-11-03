import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL } from "./runtime-shared.js";
import {
  DEFAULT_SHARED_ASSETS_HELPER_IMAGE,
  DockerCommandTimeoutError,
  DockerSharedAssetsVolumeManager,
  SHARED_ASSETS_DOCKER_COMMAND_TIMEOUT_MS,
  SHARED_ASSETS_GENERATION_LABEL,
  isDockerCommandTimeout,
} from "./shared-assets-volume.js";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const helperImage = DEFAULT_SHARED_ASSETS_HELPER_IMAGE;
const generation = "123e4567-e89b-12d3-a456-426614174001";
const nextGeneration = "123e4567-e89b-12d3-a456-426614174002";
const nameFor = (value: string) => `deepsonar-assets-g${value.replaceAll("-", "")}`;
const volumeName = nameFor(generation);
const helperName = `deepsonar-assets-writer-g${generation.replaceAll("-", "")}`;
const helperId = "a".repeat(64);

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

function ownedLabels(value = generation, owner = jobId): Record<string, string> {
  return {
    [SHARED_ASSETS_VOLUME_LABEL]: "true",
    [SHARED_ASSETS_JOB_LABEL]: owner,
    [SHARED_ASSETS_GENERATION_LABEL]: value,
  };
}

function volumeInspection(labels: unknown = ownedLabels(), name = volumeName): Record<string, unknown> {
  return { Name: name, Driver: "local", Scope: "local", Labels: labels };
}

function helperInspection(labels: unknown = ownedLabels(), id = helperId): Record<string, unknown> {
  return { Id: id, Name: `/${helperName}`, Config: { Labels: labels } };
}

interface Daemon {
  calls: string[][];
  volume: Record<string, unknown> | null;
  helper: Record<string, unknown> | null;
  before?: (args: string[]) => Promise<string | void> | string | void;
  execute: (...args: string[]) => Promise<string>;
}

/** Multiple generations coexist; accessors let barriers replace the most recently touched resource. */
function daemon(volume: Record<string, unknown> | null = null): Daemon {
  const volumes = new Map<string, Record<string, unknown>>();
  const helpers = new Map<string, Record<string, unknown>>();
  let currentVolume = String(volume?.Name ?? volumeName);
  let currentHelper = helperName;
  if (volume) volumes.set(currentVolume, volume);
  const state: Daemon = {
    calls: [],
    get volume() { return volumes.get(currentVolume) ?? null; },
    set volume(value) { if (value) volumes.set(currentVolume, value); else volumes.delete(currentVolume); },
    get helper() { return helpers.get(currentHelper) ?? null; },
    set helper(value) { if (value) helpers.set(currentHelper, value); else helpers.delete(currentHelper); },
    execute: async (...args) => {
      state.calls.push(args);
      if (args[0] === "volume" && ["inspect", "rm"].includes(args[1]!)) currentVolume = args[2]!;
      if (args[0] === "container" && args[1] === "inspect") currentHelper = args[2]!;
      const overridden = await state.before?.(args);
      if (typeof overridden === "string") return overridden;
      if (args[0] === "image" && args[1] === "inspect") return "{}";
      if (args[0] === "volume" && args[1] === "inspect") {
        if (!state.volume) throw new Error(`Error response from daemon: get ${args[2]}: no such volume`);
        return JSON.stringify(state.volume);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        if (!state.helper) throw new Error(`Error response from daemon: No such container: ${args[2]}`);
        return JSON.stringify(state.helper);
      }
      if (args[0] === "volume" && args[1] === "ls") return [...volumes.keys()].join("\n");
      if (args[0] === "volume" && args[1] === "create") {
        const labels: Record<string, string> = {};
        args.forEach((arg, index) => {
          if (arg === "--label") {
            const [key, value] = args[index + 1]!.split("=");
            labels[key!] = value!;
          }
        });
        currentVolume = args.at(-1)!;
        state.volume ??= volumeInspection(labels, currentVolume);
        return currentVolume;
      }
      if (args[0] === "create") {
        currentHelper = args[args.indexOf("--name") + 1]!;
        assert.equal(state.helper, null, "helper name collision");
        // Docker/Podman may implicitly create a missing named mount without labels.
        state.volume ??= volumeInspection(null);
        const labels: Record<string, string> = {};
        args.forEach((arg, index) => {
          if (arg === "--label") {
            const [key, value] = args[index + 1]!.split("=");
            labels[key!] = value!;
          }
        });
        state.helper = { ...helperInspection(labels), Name: `/${currentHelper}` };
        return helperId;
      }
      if (args[0] === "cp") {
        assert.equal(args[2], `${state.helper?.Id}:/assets`, "copy must target the inspected daemon identity");
        return "";
      }
      if (args[0] === "rm") {
        assert.equal(args[2], helperId, "never remove a helper by its reusable name");
        if (state.helper?.Id !== args[2]) throw new Error(`Error response from daemon: No such container: ${args[2]}`);
        state.helper = null;
        return "";
      }
      if (args[0] === "volume" && args[1] === "rm") {
        assert.deepEqual(args, ["volume", "rm", currentVolume], "never force-detach a busy volume");
        if (helpers.size) throw new Error("volume is in use by a helper");
        state.volume = null;
        return "";
      }
      throw new Error(`unexpected docker command: ${args.join(" ")}`);
    },
  };
  return state;
}

async function withSource(run: (sourcePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-assets-unit-"));
  const sourcePath = path.join(directory, "fixture.txt");
  try {
    await writeFile(sourcePath, "fixture\n", "utf8");
    await run(sourcePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function prepareInput(sourcePath: string, value = generation) {
  return { jobId, generation: value, files: [{ sourcePath, relativePath: "fixture.txt" }], catalog: { version: 1 } };
}

function manager(state: Daemon, wait: (delay: number) => Promise<void> = async () => {}) {
  return new DockerSharedAssetsVolumeManager(helperImage, state.execute, wait);
}

test("构造器只接受带小写 sha256 digest 的不可变 OCI helper 镜像", () => {
  for (const image of [
    "docker.io/library/busybox:latest",
    `docker.io/library/busybox@sha256:${"A".repeat(64)}`,
    `docker.io/library/busybox@sha256:${"a".repeat(63)}`,
    "docker.io/library/busybox",
  ]) {
    assert.throws(() => new DockerSharedAssetsVolumeManager(image), /带小写 sha256 digest 的不可变 OCI 引用/);
  }
  assert.doesNotThrow(() => new DockerSharedAssetsVolumeManager(helperImage));
  assert.doesNotThrow(() => new DockerSharedAssetsVolumeManager(`ghcr.io/summersec/deepsonar-assets-helper@sha256:${"a".repeat(64)}`));
});

test("helper image inspect 失败时不产生 helper 或卷副作用", async () => {
  const state = daemon();
  const error = new Error("helper 镜像不在本地");
  state.before = () => { throw error; };
  await assert.rejects(manager(state).prepare(prepareInput("/missing/fixture.txt")), (value: unknown) => value === error);
  assert.deepEqual(state.calls, [["image", "inspect", helperImage]]);
});

test("先 stage 全部字节，再创建带 generation 卷；helper 前后重新 inspect，按 ID 清理", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    state.before = async (args) => {
      if (args[0] === "create") {
        assert.deepEqual(state.volume?.Labels, ownedLabels());
        const create = state.calls.findIndex((call) => call[0] === "volume" && call[1] === "create");
        assert.ok(state.calls.slice(create + 1).some((call) => call[0] === "volume" && call[1] === "inspect"));
      }
      if (args[0] === "cp") {
        const staged = args[1]!.slice(0, -2);
        assert.equal(await readFile(path.join(staged, "fixture.txt"), "utf8"), "fixture\n");
        assert.deepEqual(JSON.parse(await readFile(path.join(staged, "catalog.json"), "utf8")), { version: 1 });
      }
    };
    assert.equal(await manager(state).prepare(prepareInput(sourcePath)), volumeName);
    const create = state.calls.find((args) => args[0] === "create")!;
    assert.ok(create.includes("--pull=never"));
    assert.ok(create.includes("--read-only"));
    assert.ok(create.includes("--cap-drop"));
    assert.equal(create.includes("--entrypoint"), false);
    const copy = state.calls.findIndex((args) => args[0] === "cp");
    assert.deepEqual(state.calls[copy - 1]?.slice(0, 2), ["volume", "inspect"]);
    assert.deepEqual(state.calls[copy + 1]?.slice(0, 2), ["volume", "inspect"]);
    assert.deepEqual(state.calls.at(-1)?.slice(0, 2), ["volume", "inspect"]);
    assert.equal(state.helper, null);
    assert.deepEqual(state.volume?.Labels, ownedLabels());
  });
});

test("input stage 失败不能先清理旧卷或创建新卷", async () => {
  const state = daemon(volumeInspection());
  await assert.rejects(manager(state).prepare(prepareInput("/missing/fixture.txt")), /ENOENT/);
  assert.deepEqual(state.calls, [["image", "inspect", helperImage]]);
  assert.deepEqual(state.volume?.Labels, ownedLabels());
});

test("相对路径和 catalog 冲突在任何卷副作用之前拒绝", async () => {
  await withSource(async (sourcePath) => {
    for (const relativePath of ["../outside", "nested//file", "catalog.json"]) {
      const state = daemon(volumeInspection());
      await assert.rejects(manager(state).prepare({ ...prepareInput(sourcePath), files: [{ sourcePath, relativePath }] }));
      assert.deepEqual(state.calls, [["image", "inspect", helperImage]]);
    }
  });
});

test("docker create 超时后按已 inspect 的身份补偿可能已创建的 helper 和卷", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const error = new DockerCommandTimeoutError(["create"], 60_000);
    state.before = (args) => {
      if (args[0] === "create") {
        state.helper = helperInspection();
        throw error;
      }
    };
    await assert.rejects(manager(state).prepare(prepareInput(sourcePath)), (value: unknown) => value === error);
    assert.equal(state.helper, null);
    assert.equal(state.volume, null);
    const helperRemove = state.calls.findIndex((args) => args[0] === "rm");
    const volumeRemove = state.calls.findIndex((args) => args[0] === "volume" && args[1] === "rm");
    assert.ok(volumeRemove > helperRemove);
  });
});

test("复制失败与 helper cleanup 失败均保留，不伪装 prepare 成功", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const copyError = new Error("复制失败");
    const cleanupError = new Error("helper 清理失败");
    state.before = (args) => {
      if (args[0] === "cp") throw copyError;
      if (args[0] === "rm") throw cleanupError;
    };
    await assert.rejects(manager(state).prepare(prepareInput(sourcePath)), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [copyError, cleanupError]);
      assert.equal(error.cause, copyError);
      return true;
    });
    assert.ok(state.calls.some((args) => args[0] === "volume" && args[1] === "rm"));
    assert.ok(state.volume, "busy volume stays attached; no force cleanup");
  });
});

test("复制成功但 helper cleanup 失败必须抛错，busy 卷不 force 删除", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const cleanupError = new Error("helper 清理失败");
    state.before = (args) => { if (args[0] === "rm") throw cleanupError; };
    await assert.rejects(manager(state).prepare(prepareInput(sourcePath)), (error: unknown) => error === cleanupError);
    assert.ok(state.volume);
    assert.equal(state.calls.filter((args) => args[0] === "volume" && args[1] === "rm").length, 3);
  });
});

test("未指定 generation 的合法调用每次创建新的 UUID generation", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const volumeManager = manager(state);
    const { files, catalog } = prepareInput(sourcePath);
    await volumeManager.prepare({ jobId, files, catalog });
    const first = (state.volume?.Labels as Record<string, string>)[SHARED_ASSETS_GENERATION_LABEL]!;
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await volumeManager.prepare({ jobId, files, catalog });
    const second = (state.volume?.Labels as Record<string, string>)[SHARED_ASSETS_GENERATION_LABEL]!;
    assert.notEqual(second, first);
  });
});

test("下一次 prepare 使用新 generation；旧 finally 不能清理新一代卷", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const volumeManager = manager(state);
    await volumeManager.prepare(prepareInput(sourcePath));
    await volumeManager.prepare(prepareInput(sourcePath, nextGeneration));
    assert.deepEqual((await volumeManager.listManaged()).map((item) => item.volumeName), [volumeName, nameFor(nextGeneration)]);
    await volumeManager.removeForJob(jobId, generation);
    assert.deepEqual(await volumeManager.listManaged(), [{ volumeName: nameFor(nextGeneration), jobId, generation: nextGeneration }]);
    assert.deepEqual(state.volume?.Labels, ownedLabels(nextGeneration));
    await volumeManager.removeForJob(jobId, nextGeneration);
    assert.equal(state.volume, null);
  });
});

for (const timing of ["before-helper", "after-helper", "after-copy", "after-helper-cleanup"] as const) {
  test(`helper 身份窗口 ${timing} 卷被替换时拒绝复制/交接，不重贴或删除未知卷`, async () => {
    await withSource(async (sourcePath) => {
      const state = daemon();
      let replaced = false;
      state.before = (args) => {
        const replace = !replaced && (
          (timing === "before-helper" && args[0] === "create")
          || (timing === "after-helper" && args[0] === "container" && state.helper !== null)
          || (timing === "after-copy" && args[0] === "cp")
          || (timing === "after-helper-cleanup" && args[0] === "rm")
        );
        if (replace) {
          replaced = true;
          state.volume = volumeInspection(null);
        }
      };
      await assert.rejects(manager(state).prepare(prepareInput(sourcePath)), /shared assets preparation and cleanup failed/);
      assert.equal(replaced, true);
      assert.equal(state.volume?.Labels, null);
      assert.equal(state.calls.some((args) => args[0] === "volume" && args[1] === "rm"), false);
      const copies = state.calls.filter((args) => args[0] === "cp").length;
      assert.equal(copies, timing === "before-helper" || timing === "after-helper" ? 0 : 1);
    });
  });
}

test("helper create 时缺卷可被引擎隐式创建，但 helper 后校验禁止使用无标签替身", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    state.before = (args) => { if (args[0] === "create") state.volume = null; };
    await assert.rejects(manager(state).prepare(prepareInput(sourcePath)), /shared assets preparation and cleanup failed/);
    assert.equal(state.volume?.Labels, null);
    assert.equal(state.calls.some((args) => args[0] === "cp"), false);
    assert.equal(state.calls.some((args) => args[0] === "volume" && args[1] === "rm"), false);
  });
});

test("helper cleanup 根据旧 ID 删除，不能删除复用同名的新 helper", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const replacementId = "b".repeat(64);
    state.before = (args) => {
      if (args[0] === "rm") {
        state.helper = helperInspection(ownedLabels(nextGeneration), replacementId);
        state.volume = volumeInspection(ownedLabels(nextGeneration));
      }
    };
    await assert.rejects(manager(state).prepare(prepareInput(sourcePath)), /shared assets preparation and cleanup failed/);
    assert.equal(state.helper?.Id, replacementId);
    assert.deepEqual(state.volume?.Labels, ownedLabels(nextGeneration));
    assert.equal(state.calls.some((args) => args[0] === "rm" && args[2] === helperName), false);
  });
});

for (const labels of [
  null,
  { [SHARED_ASSETS_JOB_LABEL]: jobId, [SHARED_ASSETS_GENERATION_LABEL]: generation },
  { [SHARED_ASSETS_VOLUME_LABEL]: "true", [SHARED_ASSETS_JOB_LABEL]: jobId },
  ownedLabels("not-a-generation"),
]) {
  test(`缺失/错误 ownership labels 必须 fail closed: ${JSON.stringify(labels)}`, async () => {
    await withSource(async (sourcePath) => {
      const state = daemon(volumeInspection(labels));
      await assert.rejects(manager(state).prepare(prepareInput(sourcePath)), /preparation and cleanup failed/);
      await assert.rejects(manager(state).removeForJob(jobId, generation), /本地调度器管理卷/);
      await manager(state).removeForJob(jobId); // Discovery never adopts an unowned resource.
      assert.deepEqual(await manager(state).listManaged(), []);
      assert.equal(state.calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
      assert.ok(state.volume);
    });
  });
}

test("其他 Job 的合法卷可被全局发现，当前 Job 不得采纳或删除", async () => {
  await withSource(async (sourcePath) => {
    const otherJobId = "223e4567-e89b-12d3-a456-426614174000";
    const state = daemon(volumeInspection(ownedLabels(generation, otherJobId)));
    const volumes = manager(state);
    await assert.rejects(volumes.prepare(prepareInput(sourcePath)), /preparation and cleanup failed/);
    await assert.rejects(volumes.removeForJob(jobId, generation), /本地调度器管理卷/);
    await volumes.removeForJob(jobId);
    assert.deepEqual(await volumes.listManaged(), [{ volumeName, jobId: otherJobId, generation }]);
    assert.equal(state.calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
    assert.ok(state.volume);
  });
});

test("未知 helper 保持原样，不按固定名字强删", async () => {
  const state = daemon(volumeInspection());
  state.helper = helperInspection(null);
  await assert.rejects(manager(state).removeForJob(jobId), /helper is not owned/);
  assert.equal(state.calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
});

test("removeForJob busy 卷有限重试，每次重新 inspect，耗尽保留原错误", async () => {
  const state = daemon(volumeInspection());
  const error = new Error("volume is in use");
  const delays: number[] = [];
  state.before = (args) => { if (args[0] === "volume" && args[1] === "rm") throw error; };
  await assert.rejects(manager(state, async (delay) => { delays.push(delay); }).removeForJob(jobId), (value: unknown) => value === error);
  const removes = state.calls.filter((args) => args[0] === "volume" && args[1] === "rm");
  assert.equal(removes.length, 3);
  assert.ok(removes.every((args) => !args.includes("-f")));
  for (const [index, args] of state.calls.entries()) {
    if (args[0] === "volume" && args[1] === "rm") assert.deepEqual(state.calls[index - 1]?.slice(0, 2), ["volume", "inspect"]);
  }
  assert.deepEqual(delays, [100, 200]);
  assert.ok(state.volume);
});

test("removeForJob 重试后恢复成功，并保留有界退避", async () => {
  const state = daemon(volumeInspection());
  let removes = 0;
  const delays: number[] = [];
  state.before = (args) => { if (args[0] === "volume" && args[1] === "rm" && ++removes < 3) throw new Error("busy"); };
  await manager(state, async (delay) => { delays.push(delay); }).removeForJob(jobId);
  assert.equal(removes, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(state.volume, null);
});

test("删除重试前 generation 变化时停止，不能删同名替身", async () => {
  const state = daemon(volumeInspection());
  state.before = (args) => { if (args[0] === "volume" && args[1] === "rm") throw new Error("busy"); };
  await assert.rejects(manager(state, async () => {
    state.volume = volumeInspection(ownedLabels(nextGeneration));
  }).removeForJob(jobId, generation), /本地调度器管理卷|generation changed/);
  assert.equal(state.calls.filter((args) => args[0] === "volume" && args[1] === "rm").length, 1);
  assert.deepEqual(state.volume?.Labels, ownedLabels(nextGeneration));
});

test("removeForJob 只认精确、权威的不存在诊断，volume/container 缺失均幂等", async () => {
  const state = daemon();
  await manager(state).removeForJob(jobId, generation);
  assert.equal(state.calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
  const present = daemon(volumeInspection());
  present.before = (args) => {
    if (args[0] === "volume" && args[1] === "rm") {
      present.volume = null;
      throw Object.assign(new Error("Command failed"), { stderr: `Error: no volume with name "${volumeName}" found: no such volume\n` });
    }
  };
  await manager(present).removeForJob(jobId);
  assert.equal(present.volume, null);
});

for (const error of [
  new Error("no such volume"),
  new Error("volume backend not found"),
  new Error("Error: No such volume: deepsonar-assets-223e4567-e89b-12d3-a456-426614174000"),
  Object.assign(new Error(`Error: No such volume: ${volumeName}`), { stderr: "transport unavailable" }),
  Object.assign(new Error("mixed diagnostic"), { stderr: `transport unavailable\nError: No such volume: ${volumeName}` }),
  new DockerCommandTimeoutError(["volume", "inspect", volumeName], 60_000),
]) {
  test(`模糊缺失/基础设施错误不得冒充不存在: ${error.message}`, async () => {
    const state = daemon();
    state.before = (args) => { if (args[0] === "volume" && args[1] === "inspect") throw error; };
    await assert.rejects(manager(state).removeForJob(jobId, generation), (value: unknown) => value === error);
    assert.equal(state.calls.filter((args) => args[0] === "volume" && args[1] === "inspect").length, 3);
    assert.equal(state.calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
  });
}

for (const body of ["null", "[]", "broken-json"]) {
  test(`inspect 成功但响应无权威对象时 fail closed: ${body}`, async () => {
    const state = daemon();
    state.before = (args) => args[0] === "volume" && args[1] === "inspect" ? body : undefined;
    await assert.rejects(manager(state).removeForJob(jobId, generation));
    assert.equal(state.calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
  });
}

test("inspect 基础设施错误恢复后继续删除，所有删除前仍重新 inspect", async () => {
  const state = daemon(volumeInspection());
  let inspects = 0;
  const delays: number[] = [];
  state.before = (args) => {
    if (args[0] === "volume" && args[1] === "inspect" && ++inspects < 3) throw new Error("Docker daemon unavailable");
  };
  await manager(state, async (delay) => { delays.push(delay); }).removeForJob(jobId, generation);
  assert.equal(inspects, 4);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(state.volume, null);
});

test("listManaged 合并 label/名称扫描并去重，仅返回严格 owner/generation 与创建时间", async () => {
  const secondJobId = "223e4567-e89b-12d3-a456-426614174000";
  const secondVolume = nameFor(nextGeneration);
  const unknownVolume = nameFor("323e4567-e89b-12d3-a456-426614174000");
  const createdAt = "2026-08-12T03:00:00Z";
  const state = daemon(volumeInspection());
  state.before = (args) => {
    if (args[0] === "volume" && args[1] === "ls") return args[3]?.startsWith("label=")
      ? `${volumeName}\n${secondVolume}\n` : `${volumeName}\n${unknownVolume}\n${volumeName}-extra\n`;
    if (args[0] === "volume" && args[1] === "inspect") {
      if (args[2] === secondVolume) return JSON.stringify({ ...volumeInspection(ownedLabels(nextGeneration, secondJobId), secondVolume), CreatedAt: createdAt });
      if (args[2] === unknownVolume) return JSON.stringify(volumeInspection(null, unknownVolume));
    }
  };
  assert.deepEqual(await manager(state).listManaged(), [
    { volumeName, jobId, generation },
    { volumeName: secondVolume, jobId: secondJobId, generation: nextGeneration, createdAt },
  ]);
  assert.equal(state.calls.filter((args) => args[0] === "volume" && args[1] === "inspect").length, 3);
});

test("staging 后失锁且新 Attempt 已准备 G2，旧 prepare 不创建也不删除任何 G2 资源", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const volumes = manager(state);
    const lost = new Error("lifecycle backend lost");
    await assert.rejects(volumes.prepare({
      ...prepareInput(sourcePath),
      assertCurrent: async () => {
        await volumes.prepare(prepareInput(sourcePath, nextGeneration));
        throw lost;
      },
    }), (error: unknown) => error === lost);
    assert.deepEqual(await volumes.listManaged(), [{ volumeName: nameFor(nextGeneration), jobId, generation: nextGeneration }]);
    assert.equal(state.calls.some((args) => args[1] === "create" && args.at(-1) === volumeName), false);
    assert.equal(state.calls.some((args) => args[1] === "rm"), false);
  });
});

test("Job cleanup freezes generation names before permit and cannot adopt G2 published during permit", async () => {
  await withSource(async (sourcePath) => {
    const state = daemon();
    const volumes = manager(state);
    await volumes.prepare(prepareInput(sourcePath));
    let checked = false;
    await volumes.removeForJob(jobId, undefined, async () => {
      if (checked) return;
      checked = true;
      await volumes.prepare(prepareInput(sourcePath, nextGeneration));
    });
    assert.deepEqual(await volumes.listManaged(), [{ volumeName: nameFor(nextGeneration), jobId, generation: nextGeneration }]);
    assert.equal(state.calls.some((args) => args[1] === "rm" && args[2] === nameFor(nextGeneration)), false);
  });
});

test("cleanup loses permit after snapshot or during busy retry: no subsequent destructive call", async () => {
  for (const loseOnRetry of [false, true]) {
    const state = daemon(volumeInspection());
    const lost = new Error("lifecycle backend lost");
    let valid = true;
    state.before = (args) => {
      if (!loseOnRetry && args[0] === "container") valid = false;
      if (loseOnRetry && args[1] === "rm") throw new Error("busy");
    };
    const volumes = manager(state, async () => { valid = false; });
    await assert.rejects(volumes.removeForJob(jobId, generation, async () => {
      if (!valid) throw lost;
    }), (error: unknown) => error === lost);
    assert.equal(state.calls.filter((args) => args[1] === "rm").length, loseOnRetry ? 1 : 0);
    assert.ok(state.volume);
  }
});

for (const command of ["ls", "inspect"] as const) {
  test(`listManaged ${command} 错误 fail closed，不能返回伪空列表`, async () => {
    const state = daemon(volumeInspection());
    const error = new Error("Docker daemon unavailable");
    state.before = (args) => { if (args[0] === "volume" && args[1] === command) throw error; };
    await assert.rejects(manager(state).listManaged(), (value: unknown) => value === error);
  });
}
