import assert from "node:assert/strict";
import test from "node:test";
import { isSkillCatalogStale, skillSourceAgeSeconds, staleSkillCatalogMessage } from "./skill-freshness.js";
import {
  refreshTrustedSkillSourcesOnce,
  SKILL_SOURCE_FAILURE_ALERT_THRESHOLD,
  startSkillSourceRefreshLoop,
  warnIfSkillSourcesNeverRefresh,
  warnStaleSkillSources,
} from "./skill-source-refresh.js";

function target(id: string, name = id) {
  return {
    id,
    name,
    repo_url: `https://example.test/${id}.git`,
    branch: "main",
    last_commit_sha: null,
  };
}

const noSleep = async () => {};

test("远端 HEAD 未变时只前移 synced_at，状态记 unchanged", async () => {
  const outcomes = await refreshTrustedSkillSourcesOnce({
    listSources: async () => [target("src-1")],
    sync: async () => ({ modules: 4, changed: false, skipped: true }),
    timeoutMs: 1_000,
  });
  assert.deepEqual(outcomes.map((o) => [o.source_id, o.status, o.modules, o.attempts]), [
    ["src-1", "unchanged", 4, 1],
  ]);
});

test("candidate updated/unchanged stays explicitly pending and errors retain only safe codes", async () => {
  const warned: string[] = [];
  const outcomes = await refreshTrustedSkillSourcesOnce({
    listSources: async () => [target("new"), target("cached"), target("live"), target("failed")],
    sync: async id => {
      if (id === "failed") throw new Error("fatal https://user:secret@127.0.0.1/repo?token=secret");
      return { modules: 1, changed: id === "new", skipped: id !== "new", candidate_hash: id === "live" ? null : "a".repeat(64) };
    }, maxAttempts: 1, warn: message => warned.push(message),
  });
  assert.deepEqual(outcomes.map(o => [o.status, o.source_update_pending, o.error]), [
    ["updated", true, null], ["unchanged", true, null], ["unchanged", false, null], ["failed", undefined, "sync_failed"],
  ]);
  assert.ok(warned.every(message => !message.includes("secret") && !message.includes("https://")));
});

test("目录真的变化时记 updated，失败源不影响其它源", async () => {
  const outcomes = await refreshTrustedSkillSourcesOnce({
    listSources: async () => [target("src-a"), target("src-b")],
    sync: async (id) => {
      if (id === "src-a") throw new Error("git host 不可达");
      return { modules: 2, changed: true, skipped: false };
    },
    timeoutMs: 1_000,
    maxAttempts: 2,
    retryDelaysMs: [1],
    sleep: noSleep,
    warn: () => {},
  });
  assert.deepEqual(outcomes.map((o) => [o.source, o.status, o.attempts]), [
    ["src-a", "failed", 2],
    ["src-b", "updated", 1],
  ]);
  assert.equal(outcomes[0]!.error, "sync_failed");
});

test("单源失败按有界重试后收敛到 failed，不无限重试", async () => {
  let calls = 0;
  const outcomes = await refreshTrustedSkillSourcesOnce({
    listSources: async () => [target("src-1")],
    sync: async () => {
      calls += 1;
      throw new Error("clone 失败");
    },
    timeoutMs: 1_000,
    maxAttempts: 3,
    retryDelaysMs: [1],
    sleep: noSleep,
    warn: () => {},
  });
  assert.equal(calls, 3);
  assert.equal(outcomes[0]?.status, "failed");
  assert.ok(SKILL_SOURCE_FAILURE_ALERT_THRESHOLD <= 3);
});

test("单源超时不拖住整轮（runWithTimeout 生效）", async () => {
  const outcomes = await refreshTrustedSkillSourcesOnce({
    listSources: async () => [target("src-1"), target("src-2")],
    sync: async (id, _syncedBy, signal) => {
      if (id !== "src-1") return { modules: 1, changed: false, skipped: true };
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    timeoutMs: 20,
    maxAttempts: 1,
    sleep: noSleep,
    warn: () => {},
  });
  assert.equal(outcomes[0]?.status, "failed");
  assert.equal(outcomes[0]?.error, "sync_timeout");
  assert.equal(outcomes[1]?.status, "unchanged");
});

test("已信任源列表为空时不产生任何调用", async () => {
  let called = 0;
  const outcomes = await refreshTrustedSkillSourcesOnce({
    listSources: async () => [],
    sync: async () => {
      called += 1;
      return { modules: 0, changed: false, skipped: true };
    },
  });
  assert.deepEqual(outcomes, []);
  assert.equal(called, 0);
});

test("启动后不立刻跑第一轮：不与启动同步并发写同一源", async () => {
  let called = 0;
  const stop = startSkillSourceRefreshLoop({
    intervalSec: 3600,
    listSources: async () => [target("src-1")],
    sync: async () => {
      called += 1;
      return { modules: 1, changed: false, skipped: true };
    },
    runStaleAlert: false,
    warn: () => {},
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  stop();
  assert.equal(called, 0);
});

test("收到中止信号时本轮刷新整体退出，不吞掉取消", async () => {
  const controller = new AbortController();
  let aborted = false;
  let started!: () => void;
  const syncStarted = new Promise<void>((resolve) => { started = resolve; });
  const running = refreshTrustedSkillSourcesOnce({
    listSources: async () => [target("src-1")],
    sync: async (_id, _syncedBy, signal) => {
      started();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
    timeoutMs: 60_000,
    retryDelaysMs: [1],
    sleep: noSleep,
    warn: () => {},
    signal: controller.signal,
  });
  await syncStarted;
  controller.abort(new Error("已停止"));
  await assert.rejects(running, /已停止/);
  assert.equal(aborted, true);
});

test("intervalSec=0 表示关闭周期刷新，注册后不跑任何一轮", async () => {
  let called = 0;
  const stop = startSkillSourceRefreshLoop({
    intervalSec: 0,
    listSources: async () => [target("src-1")],
    sync: async () => {
      called += 1;
      return { modules: 0, changed: false, skipped: true };
    },
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  stop();
  assert.equal(called, 0);
});

test("陈旧告警按 2×refreshIntervalSec 判定，从未同步也算陈旧", async () => {
  const warned: string[] = [];
  const nowMs = Date.parse("2026-11-06T12:00:00.000Z");
  const rows = [
    { name: "fresh", synced_at: new Date(nowMs - 30 * 60_000) },
    { name: "stale", synced_at: new Date(nowMs - 5 * 3600_000) },
    { name: "never", synced_at: null },
  ];
  const result = await warnStaleSkillSources({
    intervalSec: 3600,
    db: (async () => rows) as never,
    warn: (message) => warned.push(message),
    now: () => nowMs,
  });
  assert.deepEqual(result.stale, ["stale", "never"]);
  assert.equal(result.checked, 3);
  assert.equal(warned.length, 2);
  assert.match(warned[0] ?? "", /stale/);
  assert.match(warned[1] ?? "", /从未成功同步/);
});

test("启动校验：启动同步与周期刷新全关时给出 warn", () => {
  const warned: string[] = [];
  assert.equal(warnIfSkillSourcesNeverRefresh({
    bootSync: false,
    refreshIntervalSec: 0,
    warn: (message) => warned.push(message),
  }), true);
  assert.match(warned[0] ?? "", /DEEPSONAR_SKILL_SOURCE_REFRESH_INTERVAL_SEC=0/);
  assert.equal(warnIfSkillSourcesNeverRefresh({ bootSync: true, refreshIntervalSec: 0, warn: () => {} }), false);
  assert.equal(warnIfSkillSourcesNeverRefresh({ bootSync: false, refreshIntervalSec: 3600, warn: () => {} }), false);
});

test("新鲜度换算：缺值与非法时间返回 null，长度按秒取整", () => {
  const nowMs = Date.parse("2026-11-06T12:00:00.000Z");
  assert.equal(skillSourceAgeSeconds(null, nowMs), null);
  assert.equal(skillSourceAgeSeconds("not-a-date", nowMs), null);
  assert.equal(skillSourceAgeSeconds(new Date(nowMs - 90_500), nowMs), 91);
  assert.equal(skillSourceAgeSeconds(new Date(nowMs + 60_000), nowMs), 0);
  assert.equal(isSkillCatalogStale(7 * 86_400, 7), false);
  assert.equal(isSkillCatalogStale(8 * 86_400, 7), true);
  assert.equal(isSkillCatalogStale(null, 7), true);
  assert.match(staleSkillCatalogMessage(null), /从未成功同步/);
  assert.match(staleSkillCatalogMessage(9 * 86_400), /9 天未刷新/);
});