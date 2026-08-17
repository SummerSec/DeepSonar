import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneSkillSource,
  runWithTimeout,
  startSkillSourceBootSync,
  syncTrustedSkillSourcesOnce,
} from "./skill-sources.js";

test("模块源启动同步超时而不是永久等待 GitHub", async () => {
  let settled = false;
  await assert.rejects(
    runWithTimeout((signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        settled = true;
        reject(signal.reason);
      }, { once: true });
    }), 20, "skill-source boot sync"),
    /20ms 后超时/,
  );
  assert.equal(settled, true);
});

test("git clone 被中止时不会回退默认分支", async () => {
  const controller = new AbortController();
  const calls: string[][] = [];
  await assert.rejects(
    cloneSkillSource({
      repoUrl: "https://example.invalid/skills.git",
      branch: "feature",
      destination: "/tmp/skills",
      signal: controller.signal,
      execFile: async (_file, args, options) => {
        calls.push(args);
        assert.equal(options.signal, controller.signal);
        controller.abort(new Error("已停止"));
        throw new Error("clone 已中止");
      },
    }),
    /clone 已中止/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[4], "feature");
  assert.equal(calls[0]?.[5], "https://example.invalid/skills.git");
});

test("模块源启动同步在后台运行且不阻塞调用方", async () => {
  let started = 0;
  let settled = false;
  const stop = startSkillSourceBootSync({
    enabled: true,
    timeoutMs: 5_000,
    retryDelaysMs: [1],
    sleep: async () => {},
    listSources: async () => [{ id: "src-1", name: "DeepSonar-Skills" }],
    sync: async (_id, signal) => {
      started += 1;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          settled = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  stop();
  for (let attempt = 0; attempt < 20 && !settled; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(settled, true);
});

test("模块源启动同步对悬挂来源应用显式超时", async () => {
  let settled = false;
  await assert.rejects(
    syncTrustedSkillSourcesOnce({
      timeoutMs: 20,
      listSources: async () => [{ id: "src-1", name: "DeepSonar-Skills" }],
      sync: async (_id, signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          settled = true;
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    /20ms 后超时/,
  );
  assert.equal(settled, true);
});

test("来源 A 失败后仍执行来源 B，并在本轮结束后抛错", async () => {
  const calls: string[] = [];
  await assert.rejects(
    syncTrustedSkillSourcesOnce({
      timeoutMs: 20,
      listSources: async () => [
        { id: "src-a", name: "A" },
        { id: "src-b", name: "B" },
      ],
      sync: async (id) => {
        calls.push(id);
        if (id === "src-a") throw new Error("A 同步失败");
        return { modules: 2 };
      },
    }),
    (error: unknown) => error instanceof AggregateError && /A 同步失败/.test(error.message),
  );
  assert.deepEqual(calls, ["src-a", "src-b"]);
});

test("stop 会中止当前模块源同步", async () => {
  let started!: () => void;
  const syncStarted = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  let settled = false;
  const stop = startSkillSourceBootSync({
    enabled: true,
    timeoutMs: 5_000,
    retryDelaysMs: [1],
    listSources: async () => [{ id: "src-a", name: "A" }],
    sync: async (_id, signal) => {
      started();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          settled = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  await syncStarted;
  stop();
  for (let attempt = 0; attempt < 20 && !aborted; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(aborted, true);
  assert.equal(settled, true);
});
