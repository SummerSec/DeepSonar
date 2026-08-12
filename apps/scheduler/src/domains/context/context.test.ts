import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRuntimeContextEvent,
  createJobRuntimeContext,
  persistJobRuntimeContext,
  projectContextDiagnostics,
} from "./index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

test("调度器上下文按真实输入顺序记录图投影和预算", () => {
  const context = createJobRuntimeContext({
    attemptId: "attempt-context-1",
    adapterId: "codex",
    adapterVersion: "1.0.0",
    runtimeIdentity: digest("a"),
    compactionPolicy: "automatic",
    initialInput: "前置输入",
    graph: {
      yaml: "图摘要",
      suffix: "后置协议",
      truncated: true,
      omitted: { finding: 2 },
      maxChars: 100,
    },
  });
  assert.deepEqual(context.transforms.map((item) => item.stage), ["initial_input", "graph_scope", "budget_truncation", "summary_handoff"]);
  assert.equal(context.transforms[2]?.input_digest, context.transforms[1]?.output_digest);
  assert.equal(context.transforms[2]?.output_digest, context.transforms[1]?.output_digest);
  assert.equal(context.transforms[1]?.budget?.limit, 100);
  assert.equal(projectContextDiagnostics(context)?.transforms.length, 4);
});

test("压缩未知状态不增加 revision 且不暴露上下文正文", () => {
  const initial = createJobRuntimeContext({
    attemptId: null,
    adapterId: "codex",
    adapterVersion: "1.0.0",
    runtimeIdentity: digest("a"),
    compactionPolicy: "automatic",
    initialInput: "机密输入不应进入诊断",
  });
  const unknown = applyRuntimeContextEvent(initial, {
    type: "context.compaction_unknown",
    source: "provider",
    reason: "provider 未暴露边界",
  });
  assert.equal(unknown.compaction.observation, "unknown");
  assert.equal(unknown.context_revision, 0);
  assert.doesNotMatch(JSON.stringify(projectContextDiagnostics(unknown)), /机密输入/);
});

test("上下文持久化通过单事务写入 Job 证据", async () => {
  const statements: string[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(strings.join("?"));
    void values;
    return Promise.resolve([]);
  }) as unknown as { json: (value: unknown) => string } & ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>);
  tx.json = (value: unknown) => JSON.stringify(value);
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings;
    void values;
    return Promise.resolve([]);
  }) as unknown as { begin: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown> };
  db.begin = async (callback) => callback(tx);
  const context = createJobRuntimeContext({
    attemptId: null,
    adapterId: "codex",
    adapterVersion: "1.0.0",
    runtimeIdentity: digest("a"),
    compactionPolicy: "automatic",
    initialInput: "安全摘要",
  });
  await persistJobRuntimeContext(db as never, "job-context-1", context);
  assert.equal(statements.length, 1);
  assert.match(statements[0] ?? "", /jsonb_set/);
  assert.match(statements[0] ?? "", /runtime_evidence/);
});
