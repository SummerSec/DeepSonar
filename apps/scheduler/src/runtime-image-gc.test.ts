import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRuntimeImageGcError,
  executeRuntimeImageGcPlan,
  formatRuntimeImageGcSummary,
  planRuntimeImageGc,
  runtimeImageGcSummaryLevel,
  type RuntimeImageGcVersion,
} from "./runtime-image-gc.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const version = (
  id: string,
  product: string,
  createdAt: string,
  options: Partial<RuntimeImageGcVersion> = {},
): RuntimeImageGcVersion => {
  const imageDigest = digest(id[0] ?? "a");
  return {
    id,
    runtimeImageId: product,
    version: id,
    digest: imageDigest,
    promotedAt: null,
    createdAt,
    refs: [`ghcr.io/summersec/${product}@${imageDigest}`],
    ...options,
  };
};

test("runtime image GC protects promoted, rollback, project pins and queued/active snapshots", () => {
  const versions = [
    version("a-current", "base", "2026-08-04T00:00:00Z", { promotedAt: "2026-08-04T00:00:00Z" }),
    version("b-rollback", "base", "2026-08-03T00:00:00Z"),
    version("c-pinned", "base", "2026-08-02T00:00:00Z"),
    version("d-active", "base", "2026-08-01T00:00:00Z"),
    version("e-gc", "base", "2026-07-31T00:00:00Z"),
  ];
  const plan = planRuntimeImageGc(versions, new Set(["c-pinned"]), new Set(["d-active"]));
  assert.deepEqual(plan.candidates.map((item) => item.id), ["e-gc"]);
  assert.deepEqual(
    [...plan.protectedVersionIds].sort(),
    ["a-current", "b-rollback", "c-pinned", "d-active"],
  );
});

test("runtime image GC removes only DB-known immutable refs without force", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
  const calls: string[][] = [];
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      calls.push(args);
      return "";
    },
  );
  assert.equal(result.deleted, 1);
  assert.equal(result.alreadyAbsent, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls[0], ["ps", "-aq", "--filter", `ancestor=${candidate.refs[0]}`]);
  assert.deepEqual(calls[1], ["image", "rm", candidate.refs[0]!]);
  assert.equal(calls.flat().includes("-f"), false);
});

test("runtime image GC retains a version referenced by any container", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
  const calls: string[][] = [];
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      calls.push(args);
      return args[0] === "ps" ? "container-id" : "";
    },
  );
  assert.equal(result.retainedInUse, 1);
  assert.equal(result.deleted, 0);
  assert.equal(calls.some((args) => args[0] === "image"), false);
});

test("runtime image GC fails closed when a DB row lacks a matching named immutable ref", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z", {
    refs: ["ghcr.io/summersec/base:latest", `ghcr.io/summersec/base@${digest("d")}`],
  });
  let calls = 0;
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async () => {
      calls += 1;
      return "";
    },
  );
  assert.equal(result.unsafeRef, 1);
  assert.equal(result.deleted, 0);
  assert.equal(calls, 0);
});

/** 模拟 Node execFile 失败：非零退出码 + 运行时 stderr。 */
function commandError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed: docker image rm ref\n${stderr}`), {
    code: 1,
    killed: false,
    signal: null,
    stdout: "",
    stderr,
    ...extra,
  });
}

const DOCKER_ABSENT = (ref: string) => `Error response from daemon: No such image: ${ref}\n`;
const PODMAN_ABSENT = (ref: string) => `Error: ${ref}: image not known\n`;

test("#725 classifier: Docker / Podman 不存在语义归为 absent", () => {
  const ref = `ghcr.io/summersec/base@${digest("a")}`;
  assert.equal(classifyRuntimeImageGcError(commandError(DOCKER_ABSENT(ref))), "absent");
  assert.equal(classifyRuntimeImageGcError(commandError(PODMAN_ABSENT(ref))), "absent");
  assert.equal(classifyRuntimeImageGcError(commandError("Error response from daemon: reference does not exist\n")), "absent");
  assert.equal(
    classifyRuntimeImageGcError(commandError(`Error: 2 errors occurred:\n\t* ${ref}: image not known\n\t* ${ref}: image not known\n`)),
    "absent",
  );
  // stderr 缺失时退回 message（去掉 Node 的 `Command failed:` 首行）。
  assert.equal(
    classifyRuntimeImageGcError(Object.assign(new Error(`Command failed: podman rmi ${ref}\nError: ${ref}: image not known`), { code: 125 })),
    "absent",
  );
});

test("#725 classifier: 权限 / 不可达 / 占用 / 超时 / 未知错误绝不归为 absent", () => {
  const ref = `ghcr.io/summersec/base@${digest("a")}`;
  assert.equal(
    classifyRuntimeImageGcError(commandError("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n")),
    "permission",
  );
  assert.equal(
    classifyRuntimeImageGcError(commandError("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n")),
    "unreachable",
  );
  assert.equal(
    classifyRuntimeImageGcError(commandError("Error: unable to connect to Podman socket: dial unix /run/podman/podman.sock: connect: connection refused\n")),
    "unreachable",
  );
  assert.equal(
    classifyRuntimeImageGcError(commandError("Error response from daemon: conflict: unable to delete abc (cannot be forced) - image is being used by running container def\n")),
    "in_use",
  );
  assert.equal(
    classifyRuntimeImageGcError(commandError(`Error: image used by ${"f".repeat(64)}: image is in use by a container: consider listing external containers and force-removing image\n`)),
    "in_use",
  );
  // 多错误汇总中混入真实错误：fail closed。
  assert.equal(
    classifyRuntimeImageGcError(commandError(`Error: 2 errors occurred:\n\t* ${ref}: image not known\n\t* writing layer metadata: input/output error\n`)),
    "unknown",
  );
  assert.equal(
    classifyRuntimeImageGcError(commandError(`Error: 2 errors occurred:\n\t* ${ref}: image not known\n\t* open /var/lib/containers/storage: permission denied\n`)),
    "permission",
  );
  // 进程级错误：CLI 不存在 / 超时被杀，即使输出碰巧含有不存在字样也不算。
  assert.equal(
    classifyRuntimeImageGcError(Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT", errno: -2, syscall: "spawn docker" })),
    "unreachable",
  );
  assert.equal(classifyRuntimeImageGcError(commandError(DOCKER_ABSENT(ref), { killed: true, signal: "SIGTERM", code: null })), "timeout");
  // 宽泛的 not found 不再被当作不存在。
  assert.equal(classifyRuntimeImageGcError(commandError("Error: image store not found\n")), "unknown");
  assert.equal(classifyRuntimeImageGcError(commandError("")), "unknown");
  assert.equal(classifyRuntimeImageGcError(new Error("boom")), "unknown");
});

test("#725 GC: 已不存在镜像计入 alreadyAbsent 而非 failed（Docker 与 Podman）", async () => {
  for (const absent of [DOCKER_ABSENT, PODMAN_ABSENT]) {
    const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
    const result = await executeRuntimeImageGcPlan(
      { protectedVersionIds: new Set(), candidates: [candidate] },
      async (...args) => {
        if (args[0] === "image") throw commandError(absent(args[2]!));
        return "";
      },
    );
    assert.deepEqual(result, {
      candidates: 1,
      deleted: 0,
      alreadyAbsent: 1,
      retainedInUse: 0,
      failed: 0,
      unsafeRef: 0,
    });
  }
});

test("#725 GC: 检查后被并发删除的镜像归为 alreadyAbsent", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
  const calls: string[][] = [];
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      calls.push(args);
      // ps 时镜像仍在且无容器引用；rm 前被其他进程删掉。
      if (args[0] === "ps") return "";
      throw commandError(PODMAN_ABSENT(args[2]!));
    },
  );
  assert.equal(result.alreadyAbsent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls.map((args) => args[0]), ["ps", "image"]);
});

test("#725 GC: ancestor 过滤因镜像不存在报错时仍走非 force 删除并归为 alreadyAbsent", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
  const calls: string[][] = [];
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      calls.push(args);
      throw commandError(PODMAN_ABSENT(candidate.refs[0]!));
    },
  );
  assert.equal(result.alreadyAbsent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls[1], ["image", "rm", candidate.refs[0]!]);
  assert.equal(calls.flat().includes("-f"), false);
});

test("#725 GC: 多引用中部分删除、其余已不存在计为一次 deleted", async () => {
  const imageDigest = digest("c");
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z", {
    refs: [`ghcr.io/summersec/base@${imageDigest}`, `registry.local/summersec/base@${imageDigest}`],
  });
  const gone = new Set<string>();
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      if (args[0] === "ps") return "";
      // 运行时删除第一个引用时一并移除了整个镜像。
      if (gone.size > 0) throw commandError(DOCKER_ABSENT(args[2]!));
      gone.add(args[2]!);
      return "";
    },
  );
  assert.equal(result.deleted, 1);
  assert.equal(result.alreadyAbsent, 0);
  assert.equal(result.failed, 0);
});

test("#725 GC: 重复执行幂等——首轮 deleted，次轮 alreadyAbsent，均无 failed", async () => {
  const candidates = [
    version("c-old", "base", "2026-08-01T00:00:00Z"),
    version("d-old", "base", "2026-07-31T00:00:00Z"),
  ];
  const present = new Set(candidates.flatMap((item) => item.refs));
  const runtime = async (...args: string[]) => {
    if (args[0] === "ps") return "";
    const ref = args[2]!;
    if (!present.delete(ref)) throw commandError(PODMAN_ABSENT(ref));
    return "";
  };
  const plan = { protectedVersionIds: new Set<string>(), candidates };
  const first = await executeRuntimeImageGcPlan(plan, runtime);
  const second = await executeRuntimeImageGcPlan(plan, runtime);
  assert.equal(first.deleted, 2);
  assert.equal(first.failed, 0);
  assert.equal(second.deleted, 0);
  assert.equal(second.alreadyAbsent, 2);
  assert.equal(second.failed, 0);
  assert.equal(runtimeImageGcSummaryLevel(second), "debug");
});

test("#725 GC: 权限不足 / 运行时不可达仍计入 failed，占用仍保留", async () => {
  const cases: Array<{ stderr: string; failed: number; retainedInUse: number }> = [
    {
      stderr: "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n",
      failed: 1,
      retainedInUse: 0,
    },
    {
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
      failed: 1,
      retainedInUse: 0,
    },
    {
      stderr: `Error: image used by ${"e".repeat(64)}: image is in use by a container\n`,
      failed: 0,
      retainedInUse: 1,
    },
  ];
  for (const item of cases) {
    const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
    const result = await executeRuntimeImageGcPlan(
      { protectedVersionIds: new Set(), candidates: [candidate] },
      async (...args) => {
        if (args[0] === "image") throw commandError(item.stderr);
        return "";
      },
    );
    assert.equal(result.failed, item.failed, item.stderr);
    assert.equal(result.retainedInUse, item.retainedInUse, item.stderr);
    assert.equal(result.alreadyAbsent, 0, item.stderr);
    assert.equal(result.deleted, 0, item.stderr);
  }
});

test("#725 GC: ps 阶段的真实错误不会被吞掉", async () => {
  const candidate = version("c-old", "base", "2026-08-01T00:00:00Z");
  const calls: string[][] = [];
  const result = await executeRuntimeImageGcPlan(
    { protectedVersionIds: new Set(), candidates: [candidate] },
    async (...args) => {
      calls.push(args);
      throw commandError("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
    },
  );
  assert.equal(result.failed, 1);
  assert.equal(result.alreadyAbsent, 0);
  assert.equal(calls.some((args) => args[0] === "image"), false);
});

test("#725 summary: 仅 alreadyAbsent 降为 debug，真实失败为 warn", () => {
  const base = { candidates: 3, deleted: 0, alreadyAbsent: 0, retainedInUse: 0, failed: 0, unsafeRef: 0 };
  assert.equal(runtimeImageGcSummaryLevel({ ...base, candidates: 0 }), null);
  assert.equal(runtimeImageGcSummaryLevel({ ...base, alreadyAbsent: 42 }), "debug");
  assert.equal(runtimeImageGcSummaryLevel({ ...base, alreadyAbsent: 41, deleted: 1 }), "info");
  assert.equal(runtimeImageGcSummaryLevel({ ...base, alreadyAbsent: 41, failed: 1 }), "warn");
  assert.equal(runtimeImageGcSummaryLevel({ ...base, unsafeRef: 1 }), "warn");
  assert.equal(
    formatRuntimeImageGcSummary({ ...base, deleted: 1, alreadyAbsent: 2 }),
    "candidates=3 deleted=1 alreadyAbsent=2 retainedInUse=0 failed=0 unsafeRef=0",
  );
});
