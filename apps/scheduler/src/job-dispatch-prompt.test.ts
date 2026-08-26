import assert from "node:assert/strict";
import test from "node:test";
import { extractDispatchPrompt, operatorVisibleDispatchPrompt } from "./job-dispatch-prompt.js";

test("follow-up hub jobs reconstruct task text from canvas target", () => {
  const prompt = extractDispatchPrompt(
    "hub_reason",
    { trigger: { kind: "canvas_idle" }, scheduling_purpose: "hub" },
    { goal: "全量代码审计" },
  );
  assert.match(prompt, /全量代码审计/);
  assert.match(prompt, /画布空闲唤醒/);
});

test("canvas title fills follow-up hub jobs when target has no goal", () => {
  const prompt = extractDispatchPrompt(
    "hub_reason",
    { trigger: { kind: "graph_progress" } },
    { title: "未覆盖在册自研仓专项审计" },
  );
  assert.match(prompt, /未覆盖在册自研仓专项审计/);
});

test("operator prompt keeps instructions around injected graph YAML", () => {
  const yaml = "root_id: abc\n";
  const visible = operatorVisibleDispatchPrompt(`前置\n${yaml}\n后置`, yaml);
  assert.equal(visible.includes("前置"), true);
  assert.equal(visible.includes("后置"), true);
  assert.equal(visible.includes("root_id"), false);
});
