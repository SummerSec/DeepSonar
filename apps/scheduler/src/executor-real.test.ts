import assert from "node:assert/strict";
import test from "node:test";
import { EventEnvelope } from "@deepsonar/shared-types";
import {
  ingestFactSemanticEvent,
  moduleEvidenceFromSnapshot,
  runtimeCredentialProviderError,
  semanticToolEventsFor,
} from "./executor-real.js";

const findingId = "00000000-0000-4000-8000-000000000011";
const intentNodeId = "00000000-0000-4000-8000-000000000012";

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
        factEvent({
          title: "Malformed evidence",
          description: "This must not be ingested.",
          verification: {
            finding_id: findingId,
            evidence_kind: "runtime",
            outcome: "supports",
            subject_revision: "app@abc123",
          },
        }),
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
