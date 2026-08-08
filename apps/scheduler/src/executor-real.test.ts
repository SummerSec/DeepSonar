import assert from "node:assert/strict";
import test from "node:test";
import { ControlEventEnvelope, EventEnvelope } from "@deepsonar/shared-types";
import {
  canRolePublishSharedAsset,
  ingestFactSemanticEvent,
  assertSemanticTerminalExclusivity,
  moduleEvidenceFromSnapshot,
  normalizeLegacyControlInstructions,
  reconstructAgentRunError,
  recordFirstSemanticDone,
  buildDeferredSemanticTerminalEvents,
  isFinalAgentRunnerError,
  isSemanticAgentRunError,
  runtimeCredentialProviderError,
  semanticToolEventsFor,
  hasMaterializedProviderConfig,
  buildInstructionWorkspaceFiles,
} from "./executor-real.js";
import { expandModules } from "./skill-sources.js";

const findingId = "00000000-0000-4000-8000-000000000011";
const intentNodeId = "00000000-0000-4000-8000-000000000012";

test("real executor round-trips only controlled rate-limit details after string failure", () => {
  const error = reconstructAgentRunError("语义事件处理失败: [event_rate_limited]", {
    code: "event_rate_limited",
    metadata: {
      bucket: "progress",
      retry_after_sec: 4,
      limit: 30,
      window_seconds: 60,
      secret: "drop",
    },
  });
  assert.equal((error as Error & { code?: string }).code, "event_rate_limited");
  assert.deepEqual((error as Error & { metadata?: unknown }).metadata, {
    bucket: "progress",
    retry_after_sec: 4,
    limit: 30,
    window_seconds: 60,
  });
  assert.doesNotMatch(JSON.stringify(error), /secret|drop/i);
  assert.equal((reconstructAgentRunError("ordinary failure", { code: "invalid_node_ref" }) as Error & { code?: string }).code, undefined);
});

test("deferred Hub terminal events preserve decision-before-done ordering", () => {
  const intent = {
    from: [intentNodeId],
    role: "code",
    description: "Implement the verified remediation change.",
    prompt: "Implement the verified remediation change and report the exact test evidence.",
  };
  const events = buildDeferredSemanticTerminalEvents({
    state: {
      hub: { eventId: "00000000-0000-4000-8000-000000000021", payload: { intents: [intent] } },
      done: { eventId: "00000000-0000-4000-8000-000000000022", summary: "Hub completed" },
      human: null,
    },
    isHub: true,
    isVerify: false,
    hubDecision: { intents: [intent] },
    maxIntentsPerDecision: 10,
    factCount: 0,
    findingCount: 0,
  });

  assert.deepEqual(events.map((event) => event.type), ["hub_decision", "done"]);
  assert.deepEqual((events[0]?.payload as { intents?: unknown[] }).intents, [intent]);
  assert.equal((events[1]?.payload as { summary?: string }).summary, "Hub completed（派发 1 个意图）");
});

test("deferred Verify terminal event preserves verdict and missing evidence", () => {
  const events = buildDeferredSemanticTerminalEvents({
    state: {
      hub: null,
      done: {
        eventId: "00000000-0000-4000-8000-000000000023",
        summary: "Verification needs a rework pass",
        verdict: "rework",
        missingEvidence: ["reproduction transcript"],
      },
      human: null,
    },
    isHub: false,
    isVerify: true,
    hubDecision: null,
    maxIntentsPerDecision: 10,
    factCount: 0,
    findingCount: 0,
  });

  assert.deepEqual(events.map((event) => event.type), ["done"]);
  assert.deepEqual(events[0]?.payload, {
    summary: "Verification needs a rework pass",
    verdict: "rework",
    missing_evidence: ["reproduction transcript"],
  });
});

test("host semantic failures remain fail-closed while ordinary runner errors are distinct", () => {
  assert.equal(isSemanticAgentRunError({ errorKind: "semantic", error: "ordinary" }), true);
  assert.equal(isSemanticAgentRunError({ error: "语义事件处理失败: invalid control" }), true);
  assert.equal(isSemanticAgentRunError({ errorKind: "runner", error: "Provider 429" }), false);
  assert.equal(isFinalAgentRunnerError({ errorKind: "runner", error: "last retry failed", terminalOutcome: "failure" }), true);
  assert.equal(isFinalAgentRunnerError({ errorKind: "runner", error: "stale 429", terminalOutcome: "success" }), false);
});

test("real executor generates identical AGENTS.md and CLAUDE.md instructions", () => {
  const files = buildInstructionWorkspaceFiles("platform rules\n");
  assert.equal(files["/workspace/AGENTS.md"], "platform rules\n");
  assert.equal(files["/workspace/CLAUDE.md"], files["/workspace/AGENTS.md"]);
});

test("ControlEventEnvelope rejects Scheduler-owned fact and Finding fields", () => {
  const base = { v: 1 as const, event_id: "00000000-0000-4000-8000-000000000013" };
  assert.equal(ControlEventEnvelope.safeParse({
    ...base,
    type: "fact",
    payload: { title: "事实", description: "证据", intent_node_id: intentNodeId },
  }).success, false);
  assert.equal(ControlEventEnvelope.safeParse({
    ...base,
    type: "finding",
    payload: { title: "Finding", severity: "high", raw: { secret: "do-not-forward" } },
  }).success, false);
  assert.equal(ControlEventEnvelope.safeParse({
    ...base,
    type: "fact",
    payload: { title: "事实", description: "证据描述已达到平台要求的最小长度" },
  }).success, true);
  assert.equal(ControlEventEnvelope.safeParse({
    ...base,
    type: "finding",
    payload: { title: "Finding title", severity: "high", summary: "evidence summary with enough durable context" },
  }).success, true);
});

test("legacy RoleConfig acknowledgement wording is normalized at runtime", () => {
  const normalized = normalizeLegacyControlInstructions(`成功响应包含 ${"accepted"} ${"event"}；收到 isError 后重试。`);
  assert.match(normalized, /schema_validated \/ pending_scheduler_validation/);
  assert.doesNotMatch(normalized, /accepted\s+event/i);
});

test("module evidence carries structured omissions and defaults old snapshots to []", () => {
  const missing = [{
    selector: "source:plugin:one",
    source_id: "00000000-0000-4000-8000-000000000010",
    reason: "name-conflict" as const,
    kind: "skill" as const,
    name: "one",
  }];
  const current = moduleEvidenceFromSnapshot({
    modules: ["source:plugin:one"],
    module_selectors: ["source:plugin:one"],
    expanded_modules: [],
    missing_modules: missing,
    module_content_hash: "hash",
    skill_revisions: [],
  });
  assert.deepEqual(current.missing_modules, missing);
  assert.deepEqual(moduleEvidenceFromSnapshot({}).missing_modules, []);
});

test("manual catalog override is reflected in the frozen evidence set", async () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const catalog = [
    {
      id: "plugin-a/skill",
      kind: "skill" as const,
      plugin: "plugin-a",
      name: "shared",
      description: "catalog skill",
      files: { "SKILL.md": "catalog skill bytes" },
    },
    {
      id: "plugin-a/command",
      kind: "command" as const,
      plugin: "plugin-a",
      name: "shared",
      description: "catalog command",
      files: { "command.md": "catalog command bytes" },
    },
  ];
  const fakeDb = (async () => [{
    catalog_json: catalog,
    trust_status: "trusted",
    enabled: true,
    last_commit_sha: "abc123",
    last_content_hash: "catalog-hash",
  }]) as unknown as Parameters<typeof expandModules>[1];
  const expanded = await expandModules([`${sourceId}:source:*`], fakeDb, { skill_names: ["shared"] });
  const evidence = moduleEvidenceFromSnapshot({
    modules: [`${sourceId}:source:*`],
    module_selectors: [`${sourceId}:source:*`],
    expanded_modules: expanded.resolved_modules,
    missing_modules: expanded.missing_modules,
    module_content_hash: expanded.content_hash,
    skill_revisions: expanded.revisions,
  });
  assert.deepEqual(evidence.expanded_modules.map((module) => module.kind), ["command"]);
  assert.equal(evidence.module_content_hash, expanded.content_hash);
  assert.equal(evidence.missing_modules[0]?.reason, "manual-override");
});

function factEvent(payload: unknown): EventEnvelope {
  return EventEnvelope.parse({
    v: 1,
    event_id: "00000000-0000-4000-8000-000000000013",
    type: "fact",
    payload,
  });
}

test("real fact ingress forwards normalized verification to Scheduler convergence", async () => {
  const accepted: EventEnvelope[] = [];
  await ingestFactSemanticEvent(
    factEvent({
      title: "  Reproduction result  ",
      description: "  The isolated request still returns the protected record.  ",
      verification: {
        finding_id: findingId,
        evidence_kind: "test",
        outcome: "supports",
        subject_revision: "app@abc123",
        steps: ["Send the isolated request"],
        expected: "The request is rejected",
        actual: "The protected record is returned",
      },
    }),
    intentNodeId,
    async (event) => {
      accepted.push(event);
    },
  );

  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0]?.payload, {
    intent_node_id: intentNodeId,
    title: "Reproduction result",
    description: "The isolated request still returns the protected record.",
    verification: {
      finding_id: findingId,
      evidence_kind: "test",
      outcome: "supports",
      subject_revision: "app@abc123",
      steps: ["Send the isolated request"],
      expected: "The request is rejected",
      actual: "The protected record is returned",
    },
  });
});

test("real fact ingress preserves ordinary fact behavior and outer intent association", async () => {
  const accepted: EventEnvelope[] = [];
  await ingestFactSemanticEvent(
    factEvent({ title: "  Discovery  ", description: "  A new fact with enough evidence context.  " }),
    intentNodeId,
    async (event) => {
      accepted.push(event);
    },
  );

  assert.deepEqual(accepted[0]?.payload, {
    intent_node_id: intentNodeId,
    title: "Discovery",
    description: "A new fact with enough evidence context.",
  });
});

test("real fact ingress rejects malformed verification before convergence", async () => {
  let accepted = 0;
  await assert.rejects(
    () =>
      ingestFactSemanticEvent(
        {
          v: 1,
          event_id: "00000000-0000-4000-8000-000000000014",
          type: "fact",
          payload: {
          title: "Malformed evidence",
          description: "This must not be ingested.",
          verification: {
            finding_id: findingId,
            evidence_kind: "runtime",
            outcome: "supports",
            subject_revision: "app@abc123",
          },
          },
        },
        intentNodeId,
        async () => {
          accepted++;
        },
      ),
    /emit_fact 参数非法/,
  );
  assert.equal(accepted, 0);
});

test("runtime rejects stale or incompatible credential providers", () => {
  assert.equal(runtimeCredentialProviderError("claude-code", "anthropic", "anthropic"), null);
  assert.match(
    runtimeCredentialProviderError("claude-code", "openai", "anthropic") ?? "",
    /Job 快照已过期/,
  );
  assert.match(
    runtimeCredentialProviderError("claude-code", "openai", "openai") ?? "",
    /claude-code.*anthropic/,
  );
});

test("runtime recognizes materialized Provider settings for Gateway routing", () => {
  assert.equal(hasMaterializedProviderConfig({ env: { ANTHROPIC_MODEL: "model-id" } }), true);
  assert.equal(hasMaterializedProviderConfig({}), false);
  assert.equal(hasMaterializedProviderConfig(null), false);
});

test("semantic tool capture only enables this Job's authorized tools", () => {
  const semanticTools = semanticToolEventsFor(["list_available_roles", "emit_fact", "mark_job_done"]);
  assert.deepEqual({ ...semanticTools }, {
    "mcp__deepsonar-control__emit_fact": "fact",
    "mcp__deepsonar-control__mark_job_done": "done",
  });
  assert.equal(Object.getPrototypeOf(semanticTools), null);
});

test("late sub-agent completion keeps the first accepted mark_job_done proposal", () => {
  const first = { eventId: "first", summary: "parent completion" };
  const late = { eventId: "late", summary: "sub-agent completion" };
  const state: { done: typeof first | null } = { done: null };

  assert.equal(recordFirstSemanticDone(state, first), true);
  assert.equal(recordFirstSemanticDone(state, late), false);
  assert.equal(state.done, first);
});

test("all role Jobs, including audit, may publish shared assets", () => {
  // Publish is gated by frozen platform_tools, not role kind.
  assert.equal(canRolePublishSharedAsset("role"), true);
  assert.equal(canRolePublishSharedAsset("hub"), true);
  assert.equal(canRolePublishSharedAsset("system"), true);
});

test("semantic tool map rejects prototype keys", () => {
  const semanticTools = semanticToolEventsFor(["__proto__", "constructor", "toString", "emit_fact"]);
  assert.deepEqual({ ...semanticTools }, {
    "mcp__deepsonar-control__emit_fact": "fact",
  });
  for (const name of ["__proto__", "constructor", "toString"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(semanticTools, `mcp__deepsonar-control__${name}`), false);
  }
});

test("request_human 与 done/hub 终态双向互斥且重复 human 稳定拒绝", () => {
  const empty = () => ({ done: null, hub: null, human: null });
  assert.doesNotThrow(() => assertSemanticTerminalExclusivity(empty(), "human"));
  assert.throws(
    () => assertSemanticTerminalExclusivity({ done: null, hub: null, human: {} }, "human"),
    (error: unknown) => error instanceof Error && error.message.startsWith("[duplicate_tool_call]"),
  );
  for (const eventType of ["done", "hub_decision"] as const) {
    assert.throws(
      () => assertSemanticTerminalExclusivity({ done: null, hub: null, human: {} }, eventType),
      (error: unknown) => error instanceof Error && error.message.startsWith("[duplicate_tool_call]"),
    );
  }
  assert.throws(
    () => assertSemanticTerminalExclusivity({ done: {}, hub: null, human: null }, "human"),
    (error: unknown) => error instanceof Error && error.message.startsWith("[duplicate_tool_call]"),
  );
  assert.throws(
    () => assertSemanticTerminalExclusivity({ done: null, hub: {}, human: null }, "human"),
    (error: unknown) => error instanceof Error && error.message.startsWith("[duplicate_tool_call]"),
  );
});
