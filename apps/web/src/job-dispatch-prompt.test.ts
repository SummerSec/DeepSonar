import assert from "node:assert/strict";
import test from "node:test";
import { extractDispatchPrompt, operatorVisibleDispatchPrompt } from "./job-dispatch-prompt.js";

test("worker jobs keep Hub intent.prompt", () => {
  assert.equal(
    extractDispatchPrompt("explore", { intent: { prompt: "  只审计登录入口  " } }),
    "只审计登录入口",
  );
});

test("stored dispatched_prompt wins over empty hub payload", () => {
  assert.match(
    extractDispatchPrompt("hub_reason", {
      dispatched_prompt: "任务内容：\n审计仓库\n\n[任务画布 YAML 已注入，12 字符；过程画布可查看当前图]",
      trigger: { kind: "graph_progress" },
    }),
    /审计仓库/,
  );
});

test("follow-up hub jobs reconstruct task text from canvas target", () => {
  const prompt = extractDispatchPrompt(
    "hub_reason",
    { trigger: { kind: "graph_progress" }, scheduling_purpose: "hub" },
    { title: "第六轮", content: "未覆盖在册自研仓专项审计", goal: "未覆盖在册自研仓专项审计" },
  );
  assert.match(prompt, /未覆盖在册自研仓专项审计/);
  assert.match(prompt, /画布图进度/);
});

test("verify jobs format frozen subject fields without maker conclusions", () => {
  const prompt = extractDispatchPrompt("verify_finding", {
    verification_attempt: 2,
    finding: {
      id: "00000000-0000-4000-8000-000000000099",
      location: "login.php:42",
      artifact_refs: [{ uri: "shared://poc.bin" }],
      title: "SQLi",
      summary: "拼接查询",
    },
  });
  assert.match(prompt, /第 2 轮/);
  assert.match(prompt, /login.php:42/);
  assert.match(prompt, /poc.bin/);
  assert.doesNotMatch(prompt, /SQLi/);
  assert.doesNotMatch(prompt, /拼接查询/);
});

test("operator prompt replaces graph YAML instead of dropping the job input", () => {
  const yaml = "nodes:\n  - id: root\n";
  const visible = operatorVisibleDispatchPrompt(`任务内容：\n审计\n\n画布（YAML）：\n${yaml}\n约束：最多 3 个意图`, yaml);
  assert.match(visible, /任务内容：/);
  assert.match(visible, /约束：最多 3 个意图/);
  assert.match(visible, /已注入，\d+ 字符/);
  assert.doesNotMatch(visible, /id: root/);
});

test("stringified payload_json still yields intent prompt", () => {
  assert.equal(
    extractDispatchPrompt("audit", JSON.stringify({ intent: { prompt: "读 AGENTS.md" } })),
    "读 AGENTS.md",
  );
});
