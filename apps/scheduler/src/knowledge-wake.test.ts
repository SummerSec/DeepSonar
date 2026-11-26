import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeProbeIntervalMs, shouldProbeKnowledgeWake } from "./knowledge-wake.js";

const state = (patch: Partial<Parameters<typeof shouldProbeKnowledgeWake>[0]> = {}) =>
  ({ wakeAt: null, probedAt: 0, firedFor: null, refreshRequested: false, ...patch });

test("#1287 到期前不回库，到期后才回库", () => {
  const future = 10_000;
  assert.equal(shouldProbeKnowledgeWake(state({ wakeAt: future, probedAt: 1_000 }), 5_000, 30_000), false,
    "唤醒时间还在未来时不必重跑策略查询");
  assert.equal(shouldProbeKnowledgeWake(state({ wakeAt: future, probedAt: 1_000 }), 12_000, 30_000), true,
    "到期后必须回库拿新的唤醒时间");
});

test("#1287 同一条到期只触发一次，之后按最小间隔回库", () => {
  const due = 5_000;
  assert.equal(shouldProbeKnowledgeWake(state({ wakeAt: due, probedAt: 4_000, firedFor: null }), 6_000, 30_000), true,
    "首次到期需要回库");
  assert.equal(shouldProbeKnowledgeWake(state({ wakeAt: due, probedAt: 6_000, firedFor: due }), 7_000, 30_000), false,
    "已为这条到期回库过，不能在下一次刷新里再跑一遍重查询");
  assert.equal(shouldProbeKnowledgeWake(state({ wakeAt: due, probedAt: 6_000, firedFor: due }), 36_000, 30_000), true,
    "超过最小间隔后允许复查，避免漏掉新工作");
});

test("#1287 显式失效与无唤醒状态的处理", () => {
  assert.equal(shouldProbeKnowledgeWake(state({ refreshRequested: true, probedAt: 1_000, wakeAt: 99_999 }), 1_001, 30_000), true);
  assert.equal(shouldProbeKnowledgeWake(state({ wakeAt: null, probedAt: 1_000 }), 2_000, 30_000), false);
  assert.equal(shouldProbeKnowledgeWake(state({ wakeAt: null, probedAt: 1_000 }), 31_000, 30_000), true);
  assert.equal(knowledgeProbeIntervalMs({} as NodeJS.ProcessEnv), 30_000);
  assert.equal(knowledgeProbeIntervalMs({ DEEPSONAR_KNOWLEDGE_PROBE_INTERVAL_MS: "5000" } as NodeJS.ProcessEnv), 5_000);
  assert.equal(knowledgeProbeIntervalMs({ DEEPSONAR_KNOWLEDGE_PROBE_INTERVAL_MS: "-1" } as NodeJS.ProcessEnv), 30_000);
});
