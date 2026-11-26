import assert from "node:assert/strict";
import test from "node:test";
import { invalidateKnowledgeWake, knowledgeWakeTtlMs, readNextKnowledgeWake } from "./knowledge-wake.js";

function countingDb(wakeAt: string | null) {
  const calls: string[] = [];
  // 嵌套 fragment 也会调用 db 标签，只有外层执行语句才算一次真实查询。
  const db = ((strings: TemplateStringsArray) => {
    if (strings.join("?").includes("MIN(due.wake_at)")) calls.push("query");
    return Promise.resolve(wakeAt ? [{ wake_at: wakeAt }] : []);
  }) as never;
  return { db, calls };
}

test("#1287 同一 TTL 内不重复跑集合策略查询", async () => {
  invalidateKnowledgeWake();
  const { db, calls } = countingDb("2030-01-01T00:00:00.000Z");
  const first = await readNextKnowledgeWake(db);
  const second = await readNextKnowledgeWake(db);
  assert.equal(calls.length, 1, "TTL 内的第二次读取必须复用缓存，不能再次扫 audit_logs");
  assert.deepEqual(second?.toISOString(), first?.toISOString());
  await readNextKnowledgeWake(db, { fresh: true });
  assert.equal(calls.length, 2, "fresh 读取必须真的回库");
  invalidateKnowledgeWake();
  await readNextKnowledgeWake(db);
  assert.equal(calls.length, 3, "失效后必须重新计算");
});

test("#1287 TTL 可配置，0 表示每次都查", async () => {
  invalidateKnowledgeWake();
  const { db, calls } = countingDb(null);
  const previous = process.env.DEEPSONAR_KNOWLEDGE_WAKE_TTL_MS;
  process.env.DEEPSONAR_KNOWLEDGE_WAKE_TTL_MS = "0";
  try {
    assert.equal(knowledgeWakeTtlMs(), 0);
    assert.equal(await readNextKnowledgeWake(db), null);
    await readNextKnowledgeWake(db);
    assert.equal(calls.length, 2);
  } finally {
    if (previous === undefined) delete process.env.DEEPSONAR_KNOWLEDGE_WAKE_TTL_MS;
    else process.env.DEEPSONAR_KNOWLEDGE_WAKE_TTL_MS = previous;
    invalidateKnowledgeWake();
  }
  assert.equal(knowledgeWakeTtlMs({} as NodeJS.ProcessEnv), 30_000, "未设置时默认 30s");
  assert.equal(knowledgeWakeTtlMs({ DEEPSONAR_KNOWLEDGE_WAKE_TTL_MS: "abc" } as NodeJS.ProcessEnv), 30_000);
  assert.equal(knowledgeWakeTtlMs({ DEEPSONAR_KNOWLEDGE_WAKE_TTL_MS: "999999" } as NodeJS.ProcessEnv), 30_000);
});
