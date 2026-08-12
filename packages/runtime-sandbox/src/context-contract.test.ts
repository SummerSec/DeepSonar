import assert from "node:assert/strict";
import test from "node:test";
import {
  appendContextTransform,
  applyContextCompactedEvent,
  assertContextResume,
  contextIdentity,
  contextTextDigest,
  createContextState,
  markContextCompactionUnobservable,
  validateContextResume,
} from "./context-contract.js";

function state() {
  return createContextState({
    attempt_id: "attempt-1",
    adapter_id: "codex",
    adapter_version: "0.1.0",
    runtime_identity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    policy: "automatic",
    input_digest: contextTextDigest("输入摘要"),
    snapshot_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
}

test("上下文身份对同一冻结输入稳定且不包含原文", () => {
  const left = state();
  const right = state();
  assert.equal(left.context_id, right.context_id);
  assert.match(left.context_id, /^ctx_[a-f0-9]{32}$/u);
  assert.equal(JSON.stringify(left).includes("输入摘要"), false);
  assert.notEqual(left.context_id, createContextState({
    ...{
      adapter_id: "claude-code",
      adapter_version: "0.1.0",
      runtime_identity: left.runtime_identity,
      policy: left.policy,
      input_digest: left.transforms[0].input_digest,
    },
  }).context_id);
});

test("transform manifest 递增并保留预算和省略原因", () => {
  const before = state();
  const after = appendContextTransform(before, {
    stage: "graph_scope",
    version: 1,
    input_digest: before.transforms[0].output_digest,
    output_digest: contextTextDigest("图投影摘要"),
    budget: { unit: "chars", limit: 1000, observed: 960 },
    omission: { kind: "finding", count: 2, reason: "超过图投影预算", truncated: true },
    source: "scheduler",
  });
  assert.equal(after.context_revision, 1);
  assert.equal(after.transforms[1].revision, 1);
  assert.equal(after.transforms[1].omission?.count, 2);
  assert.notEqual(after.transform_chain_digest, before.transform_chain_digest);
});

test("context.compacted 支持正常递增、重复幂等并拒绝乱序和身份错误", () => {
  const before = appendContextTransform(state(), {
    stage: "graph_scope",
    version: 1,
    input_digest: state().transforms[0].output_digest,
    output_digest: contextTextDigest("图投影摘要"),
    budget: null,
    omission: null,
    source: "scheduler",
  });
  const event = {
    type: "context.compacted" as const,
    event_id: "compact-1",
    context_id: before.context_id,
    context_revision: 2,
    adapter_id: before.adapter_id,
    adapter_version: before.adapter_version,
    runtime_identity: before.runtime_identity,
    transform_chain_digest: before.transform_chain_digest,
    policy: before.policy,
    boundary: { kind: "tail" as const, retained_tail_count: 8, retained_tail_digest: contextTextDigest("tail") },
    input_digest: before.transforms.at(-1)!.output_digest,
    output_digest: contextTextDigest("压缩后摘要"),
    budget: { unit: "tokens" as const, limit: 4096, observed: 3000 },
    omission: { kind: "history", count: 4, reason: "provider compaction", truncated: true },
    source: "adapter" as const,
  };
  const after = applyContextCompactedEvent(before, event);
  assert.equal(after.context_revision, 2);
  assert.equal(applyContextCompactedEvent(after, event), after);
  assert.throws(() => applyContextCompactedEvent(after, {
    ...event,
    event_id: "compact-2",
    context_revision: 4,
    transform_chain_digest: after.transform_chain_digest,
  }), /CONTEXT_REVISION_GAP/);
  assert.throws(() => applyContextCompactedEvent(after, { ...event, event_id: "compact-3", context_id: "ctx_other" }), /CONTEXT_ID_MISMATCH/);
  assert.throws(() => applyContextCompactedEvent(after, { ...event, event_id: "compact-1", output_digest: contextTextDigest("篡改") }), /CONTEXT_EVENT_ID_REUSE/);
});

test("不可观测和不支持的压缩显式记录但不伪造 revision", () => {
  const unknown = markContextCompactionUnobservable(state(), "unknown", "provider 未暴露压缩事件");
  assert.equal(unknown.compaction.observation, "unknown");
  assert.equal(unknown.context_revision, 0);
  const unsupported = createContextState({
    adapter_id: "pi",
    adapter_version: "1.0.0",
    runtime_identity: state().runtime_identity,
    policy: "unsupported",
    input_digest: state().transforms[0].input_digest,
  });
  assert.equal(unsupported.compaction.observation, "unsupported");
  assert.equal(unsupported.compaction.source, "unsupported");
});

test("resume 身份必须完整匹配，任何 revision 或运行时差异都 fail closed", () => {
  const current = contextIdentity(state());
  assert.deepEqual(validateContextResume(current, current), { ok: true });
  const mismatch = validateContextResume(current, { ...current, context_revision: 1 });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, "context_revision");
  assert.throws(() => assertContextResume(current, { ...current, runtime_identity: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }), /CONTEXT_RESUME_IDENTITY_MISMATCH:runtime_identity/);
});
