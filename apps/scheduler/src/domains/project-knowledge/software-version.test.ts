import assert from "node:assert/strict";
import test from "node:test";
import { evaluateApplicability } from "./software-version.js";

test("#1219 没有声明适用范围的条目对所有环境适用", () => {
  assert.equal(evaluateApplicability(["巡检"], { software: "openharmony", version: "16.0" }), "applicable");
  assert.equal(evaluateApplicability(undefined, {}), "applicable");
});

test("#1219 带软件标识的声明只在软件与版本都一致时适用", () => {
  const keywords = ["巡检", "sw:openharmony:16.0"];
  assert.equal(evaluateApplicability(keywords, { software: "openharmony", version: "16.0" }), "applicable");
  assert.equal(evaluateApplicability(keywords, { software: "openharmony", version: "15.0" }), "inapplicable");
  // 同一项目里两个都叫 16.0 的软件必须能区分开。
  assert.equal(evaluateApplicability(keywords, { software: "android", version: "16.0" }), "inapplicable");
});

test("#1219 有版本约束但上下文未知时是 applicability=unknown，不冒充适用", () => {
  assert.equal(evaluateApplicability(["sw:openharmony:16.0"], {}), "unknown");
  assert.equal(evaluateApplicability(["sw:openharmony:16.0"], { software: "openharmony" }), "unknown");
});

test("#1219 历史写法 sw:<version> 只约束版本，不限软件", () => {
  assert.equal(evaluateApplicability(["sw:16.0"], { software: "android", version: "16.0" }), "applicable");
  assert.equal(evaluateApplicability(["sw:16.0"], { software: "android", version: "15.0" }), "inapplicable");
});

test("#1219 只变模型不改变适用性（模型不在匹配键里）", () => {
  assert.equal(evaluateApplicability(["sw:openharmony:16.0"], { software: "openharmony", version: "16.0" }), "applicable");
});
