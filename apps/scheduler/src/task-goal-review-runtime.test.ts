import assert from "node:assert/strict";
import test from "node:test";
import { EmitFactDirectPayload, EventEnvelope, type EventEnvelopeInput } from "@deepsonar/shared-types";
import { expandWorkspacePayloadFile, ingestFactSemanticEvent } from "./executor-real.js";

const result = {
  schema_version: 1,
  assignment_sha256: `sha256:${"a".repeat(64)}`,
  criteria: [{ criterion_id: "acceptance:0", scope: "entire_criterion", assessment: "satisfied",
    expected: "All regression cases pass", actual: "All applicable cases executed and passed",
    rationale: "Independent retained test evidence covers the entire criterion", limitations: [],
    evidence_refs: ["00000000-0000-4000-8000-000000000006"] }],
};
const payload = { title: " Independent goal review ", description: " Independent review with retained evidence. ",
  artifact: { goal_review: result } };
const intentId = "00000000-0000-4000-8000-000000000007";
function event(value: unknown): EventEnvelopeInput {
  return { v: 1, event_id: "00000000-0000-4000-8000-000000000008", type: "fact", payload: value } as EventEnvelopeInput;
}

test("real emit_fact ingress preserves typed Artifact goal review for direct and payload_file inputs", async () => {
  const accepted: EventEnvelope[] = [];
  const expanded = await expandWorkspacePayloadFile("emit_fact", { payload_file: "reviews/result.json" }, {
    async readWorkspaceFile(path) {
      assert.equal(path, "/workspace/reviews/result.json");
      return Buffer.from(JSON.stringify(payload));
    },
  });
  for (const value of [payload, expanded]) {
    await ingestFactSemanticEvent(event(value), intentId, async (item) => { accepted.push(item); });
  }
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted[0], accepted[1]);
  assert.deepEqual(accepted[0].payload, { title: payload.title.trim(), description: payload.description.trim(),
    intent_node_id: intentId, artifact: payload.artifact });
});

test("real emit_fact ingress refuses malformed review scope or unsupported satisfied assertions before ingest", async () => {
  let accepted = 0;
  for (const override of [{ scope: "contribution" }, { evidence_refs: [] }, { limitations: ["Coverage unknown"] }]) {
    const invalid = { ...payload, artifact: { ...payload.artifact, goal_review: {
      ...result, criteria: [{ ...result.criteria[0], ...override }],
    } } };
    assert.equal(EmitFactDirectPayload.safeParse(invalid).success, false);
    await assert.rejects(ingestFactSemanticEvent(event(invalid), intentId, async () => { accepted++; }), /emit_fact 参数非法/);
  }
  assert.equal(accepted, 0);
});

test("retired top-level goal_review is rejected rather than silently dropped during runtime reconstruction", async () => {
  const invalid = { title: payload.title, description: payload.description, goal_review: result };
  assert.equal(EmitFactDirectPayload.safeParse(invalid).success, false);
  assert.equal(EventEnvelope.safeParse(event(invalid)).success, false);
  let accepted = 0;
  await assert.rejects(ingestFactSemanticEvent(event(invalid), intentId, async () => { accepted++; }), /emit_fact 参数非法/);
  assert.equal(accepted, 0);
});
