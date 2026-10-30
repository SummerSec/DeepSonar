import assert from "node:assert/strict";
import test from "node:test";
import { EmitFactDirectPayload, type EventEnvelopeInput } from "@deepsonar/shared-types";
import { expandWorkspacePayloadFile, ingestFactSemanticEvent } from "./executor-real.js";
const proposal = { schema_version: 1, kind: "negative_result", task_contract_sha256: `sha256:${"a".repeat(64)}`,
  target: "fixture-parser", criterion_ids: ["acceptance:0"], method: "Run the specified parser fixtures",
  observed: "Specified fixtures did not reproduce the target behavior", limitations: ["Only the frozen fixture set was exercised"],
  evidence_refs: ["00000000-0000-4000-8000-000000000001"] };
const payload = { title: "Bounded execution outcome", description: "Observed fixture results with retained evidence", artifact: { task_result: proposal } };
test("direct and payload_file runtime preserve non-Finding task result declarations", async () => {
  const expanded = await expandWorkspacePayloadFile("emit_fact", { payload_file: "result.json" }, {
    async readWorkspaceFile() { return Buffer.from(JSON.stringify(payload)); },
  });
  const accepted: unknown[] = [];
  for (const value of [payload, expanded]) await ingestFactSemanticEvent({ v: 1, event_id: "00000000-0000-4000-8000-000000000003", type: "fact", payload: value } as EventEnvelopeInput,
    "00000000-0000-4000-8000-000000000002", async event => { accepted.push(event.payload); });
  assert.equal(accepted.length, 2); assert.deepEqual(accepted[0], accepted[1]);
  assert.deepEqual((accepted[0] as typeof payload).artifact.task_result, proposal);
});
test("unexecuted output cannot be submitted as an evidence-free negative result", async () => {
  const invalid = { ...payload, artifact: { task_result: { ...proposal, evidence_refs: [] } } };
  assert.equal(EmitFactDirectPayload.safeParse(invalid).success, false);
  let accepted = false;
  await assert.rejects(ingestFactSemanticEvent({ v: 1, event_id: "00000000-0000-4000-8000-000000000004", type: "fact", payload: invalid } as EventEnvelopeInput,
    "00000000-0000-4000-8000-000000000002", async () => { accepted = true; }));
  assert.equal(accepted, false);
});
