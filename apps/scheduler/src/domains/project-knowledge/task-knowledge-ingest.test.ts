import assert from "node:assert/strict";
import test from "node:test";
import { ingestibleSuggestions, taskKnowledgeLogicalKey } from "./task-knowledge-ingest.js";

const memory = { kind: "memory" as const, title: "构建要先升 SDK", scope: "ohos 构建",
  content: "1.x 先升 SDK 再打包", evidence_refs: [{ kind: "fact" as const, ref: "11111111-1111-4111-8111-111111111111" }] };
const skill = { kind: "skill" as const, title: "打包脚本", scope: "产物",
  content: "脚本内容", evidence_refs: [{ kind: "evidence" as const, ref: "22222222-2222-4222-8222-222222222222" }] };

test("#1219 任务沉淀的稳定逻辑键：同标题同键，空白与符号折叠，超长截断", () => {
  assert.equal(taskKnowledgeLogicalKey("构建要先升 SDK"), taskKnowledgeLogicalKey("构建要先升  SDK "));
  assert.equal(taskKnowledgeLogicalKey("构建要先升 SDK"), taskKnowledgeLogicalKey("构建要先升-SDK"));
  assert.match(taskKnowledgeLogicalKey("构建要先升 SDK"), /^task\/[^/ ]+$/u);
  assert.equal(taskKnowledgeLogicalKey("   "), "task/untitled");
  assert.ok(taskKnowledgeLogicalKey("x".repeat(400)).length <= 125);
});

test("#1219 只有 memory 沉淀进确定性入库路径，Skill 仍走显式送评", () => {
  assert.deepEqual(ingestibleSuggestions([memory, skill]), [memory]);
  assert.deepEqual(ingestibleSuggestions([skill]), []);
});
