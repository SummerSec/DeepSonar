import assert from "node:assert/strict";
import test from "node:test";
import { ControlEventEnvelope, EventEnvelope } from "@deepsonar/shared-types";
import {
  ingestFactSemanticEvent,
  moduleEvidenceFromSnapshot,
  normalizeLegacyControlInstructions,
  runtimeCredentialProviderError,
  semanticToolEventsFor,
} from "./executor-real.js";
import { expandModules } from "./skill-sources.js";

const findingId = "00000000-0000-4000-8000-000000000011";
const intentNodeId = "00000000-0000-4000-8000-000000000012";

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
    payload: { title: "事实", description: "证据" },
  }).success, true);
  assert.equal(ControlEventEnvelope.safeParse({
    ...base,
    type: "finding",
    payload: { title: "Finding", severity: "high" },
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
    factEvent({ title: "  Discovery  ", description: "  A new fact.  " }),
    intentNodeId,
    async (event) => {
      accepted.push(event);
    },
  );

  assert.deepEqual(accepted[0]?.payload, {
    intent_node_id: intentNodeId,
    title: "Discovery",
    description: "A new fact.",
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
    /claude-code.*anthropic\/kimi/,
  );
});

test("semantic tool capture only enables this Job's authorized tools", () => {
  assert.deepEqual(semanticToolEventsFor(["list_available_roles", "emit_fact", "mark_job_done"]), {
    "mcp__deepsonar-control__emit_fact": "fact",
    "mcp__deepsonar-control__mark_job_done": "done",
  });
});
