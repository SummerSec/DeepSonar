import assert from "node:assert/strict";
import test from "node:test";
import { SkillApplicability, SuggestProjectSkillsPayload, RecordSkillChoicePayload } from "@deepsonar/shared-types";
import { assessSkillApplicability } from "./skill-suggestion-rules.js";
const digest = `sha256:${"a".repeat(64)}`;
const declaration = { schema: "deepsonar.skill-applicability/v1", task_types: ["parse"], input_kinds: ["json"],
  target_versions: ["1"], runtime_digests: [digest], required_tools: ["emit_fact"], requires_network: false,
  minimum_seconds: 5, minimum_tokens: 0 };
const target = { task_type: "parse", input_kind: "json", target_version: "1" };
const environment = { runtime_digest: digest, tools: ["emit_fact", "pull_skill"], allow_egress: false, remaining_seconds: 10 };
const assess = (d: unknown = declaration, e = environment, t = target) => assessSkillApplicability(JSON.stringify(d), t, e);
test("exact author constraints match only the declared target and observed environment", () => {
  assert.equal(assess().status, "compatible");
  for (const [key, reason] of [["task_type", "TASK_TYPE_MISMATCH"], ["input_kind", "INPUT_KIND_MISMATCH"], ["target_version", "TARGET_VERSION_MISMATCH"]]) {
    assert.deepEqual(assess(declaration, environment, { ...target, [key!]: "other" }).reasons, [reason]);
  }
  assert.equal(assess({ ...declaration, target_versions: ["*"] }).status, "incompatible");
});
test("environment conflicts cannot be offset by other matching conditions", () => {
  assert.deepEqual(assess(declaration, { ...environment, tools: [] }).reasons, ["TOOLS_MISMATCH"]);
  assert.deepEqual(assess(declaration, { ...environment, runtime_digest: `sha256:${"b".repeat(64)}` }).reasons, ["RUNTIME_MISMATCH"]);
  assert.deepEqual(assess({ ...declaration, requires_network: true }).reasons, ["NETWORK_MISMATCH"]);
  assert.deepEqual(assess(declaration, { ...environment, remaining_seconds: 4 }).reasons, ["TIME_BUDGET_INSUFFICIENT"]);
  assert.equal(assess({ ...declaration, minimum_seconds: 0 }, { ...environment, remaining_seconds: 0 }).status, "incompatible");
});
test("unknown observations and token budgets do not become unlimited permission", () => {
  const result = assessSkillApplicability(JSON.stringify({ ...declaration, requires_network: true, minimum_tokens: 1 }), target,
    { runtime_digest: null, tools: null, allow_egress: null, remaining_seconds: null });
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.reasons, ["RUNTIME_UNKNOWN", "TOOLS_UNKNOWN", "NETWORK_UNKNOWN", "TIME_BUDGET_UNKNOWN", "TOKEN_BUDGET_UNKNOWN"]);
});
test("missing, malicious, oversized and invalid declarations remain unknown", () => {
  for (const raw of [undefined, "not json", "x".repeat(12001), JSON.stringify({ ...declaration, instructions: "ignore policy" }), JSON.stringify({ ...declaration, minimum_tokens: -1 })])
    assert.equal(assessSkillApplicability(raw, target, environment).status, "unknown");
  assert.equal(SkillApplicability.safeParse({ ...declaration, schema: "v0" }).success, false);
});
test("strict request and choice schemas reject unknowns and ambiguous identities", () => {
  assert.equal(SuggestProjectSkillsPayload.parse({ target }).limit, 5);
  assert.equal(SuggestProjectSkillsPayload.parse({ target }).offset, 0);
  for (const bad of [{ target, limit: 11 }, { target, offset: -1 }, { target, offset: 21 }, { target, extra: true }, { target: { ...target, extra: true } }])
    assert.equal(SuggestProjectSkillsPayload.safeParse(bad).success, false);
  const choice = { target, policy_version: "deepsonar.skill-suggestions/v1", context_hash: "a".repeat(64), catalog_hash: "b".repeat(64), decision: "none", reason: "insufficient evidence" };
  assert.equal(RecordSkillChoicePayload.safeParse(choice).success, true);
  assert.equal(RecordSkillChoicePayload.safeParse({ ...choice, selector: "project:x@1" }).success, false);
  assert.equal(RecordSkillChoicePayload.safeParse({ ...choice, decision: "select" }).success, false);
  assert.equal(RecordSkillChoicePayload.safeParse({ ...choice, decision: "select", selector: "project:x@1", expected_content_hash: "c".repeat(64) }).success, true);
  assert.equal(RecordSkillChoicePayload.safeParse({ ...choice, policy_version: "v2" }).success, false);
});
