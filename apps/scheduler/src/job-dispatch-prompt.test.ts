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

test("verify jobs reconstruct subject and location without maker conclusions", () => {
  const prompt = extractDispatchPrompt("verify_finding", {
    verification_attempt: 3,
    finding: {
      id: "00000000-0000-4000-8000-000000000088",
      location: "auth.ts:12",
      artifact_refs: [{ uri: "file://trace.ndjson" }],
      title: "Maker title must stay hidden",
      summary: "Maker summary must stay hidden",
      severity: "critical",
    },
  });
  assert.match(prompt, /第 3 轮/);
  assert.match(prompt, /auth.ts:12/);
  assert.match(prompt, /trace.ndjson/);
  assert.doesNotMatch(prompt, /Maker title/);
  assert.doesNotMatch(prompt, /Maker summary/);
  assert.doesNotMatch(prompt, /critical/);
});

test("report dispatch prompt tells the writer to keep quantities verbatim", () => {
  const prompt = extractDispatchPrompt("report", {
    kind: "task_report",
    confirmed_count: 1,
  }, { goal: "盘点 ELF slots" });
  assert.match(prompt, /report-input\.json/);
  assert.match(prompt, /原样保留 value、unit、basis/);
});

test("operator prompt keeps instructions around injected graph YAML", () => {
  const yaml = "root_id: abc\n";
  const visible = operatorVisibleDispatchPrompt(`前置\n${yaml}\n后置`, yaml);
  assert.equal(visible.includes("前置"), true);
  assert.equal(visible.includes("后置"), true);
  assert.equal(visible.includes("root_id"), false);
});
