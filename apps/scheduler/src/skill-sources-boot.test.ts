import assert from "node:assert/strict";
import test from "node:test";
import {
  runWithTimeout,
  startSkillSourceBootSync,
  syncTrustedSkillSourcesOnce,
} from "./skill-sources.js";

test("skill-source boot sync times out instead of hanging on GitHub", async () => {
  await assert.rejects(
    runWithTimeout(new Promise(() => {}), 20, "skill-source boot sync"),
    /timed out after 20ms/,
  );
});

test("skill-source boot sync starts in background and does not block callers", async () => {
  let started = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const stop = startSkillSourceBootSync({
    enabled: true,
    timeoutMs: 5_000,
    retryDelaysMs: [1],
    sleep: async () => {},
    listSources: async () => [{ id: "src-1", name: "DeepSonar-Skills" }],
    sync: async () => {
      started += 1;
      await blocked;
      return { modules: 1 };
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  stop();
  release();
});

test("skill-source boot sync wraps a hanging source with the explicit timeout", async () => {
  await assert.rejects(
    syncTrustedSkillSourcesOnce({
      timeoutMs: 20,
      listSources: async () => [{ id: "src-1", name: "DeepSonar-Skills" }],
      sync: async () => new Promise(() => {}),
    }),
    /timed out after 20ms/,
  );
});
