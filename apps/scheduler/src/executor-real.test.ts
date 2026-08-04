import assert from "node:assert/strict";
import test from "node:test";
import { EventEnvelope } from "@deepsonar/shared-types";
import { ingestFactSemanticEvent } from "./executor-real.js";

const findingId = "00000000-0000-4000-8000-000000000011";
const intentNodeId = "00000000-0000-4000-8000-000000000012";

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
