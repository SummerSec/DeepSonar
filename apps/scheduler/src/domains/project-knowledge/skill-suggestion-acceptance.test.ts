import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ControlToolInputSchemasJson, EventEnvelope, resolvePlatformTools, resolvePlatformToolsTightened } from "@deepsonar/shared-types";
import { buildPlatformOpenApiDocument, getPlatformOperation } from "../platform-api/operations.js";
import { assessSkillApplicability, type SuggestionEnvironment } from "./skill-suggestion-rules.js";

// Independent, frozen engineering expectations. These are not production efficacy labels.
const fixture = JSON.parse(readFileSync(new URL("../../../../../agent-harness/capability-applicability/online-fixtures/acceptance.json", import.meta.url), "utf8"));

test("suggestions require explicit global opt-in and project overrides can only tighten it", () => {
  for (const name of ["suggest_project_skills", "record_skill_choice"] as const) {
    assert.ok(!resolvePlatformTools("explore", "role", {}).includes(name));
    assert.ok(resolvePlatformTools("explore", "role", { [name]: true }).includes(name));
    assert.ok(!resolvePlatformToolsTightened("explore", "role", {}, { [name]: true }).includes(name));
    assert.ok(!resolvePlatformToolsTightened("explore", "role", { [name]: false }, { [name]: true }).includes(name));
    assert.ok(resolvePlatformToolsTightened("explore", "role", { [name]: true }, {}).includes(name));
    assert.ok(!resolvePlatformToolsTightened("explore", "role", { [name]: true }, { [name]: false }).includes(name));
    assert.ok(!resolvePlatformTools("verify", "system", { [name]: true }).includes(name));
  }
  assert.ok(resolvePlatformTools("explore", "role", {}).includes("pull_skill"));
  assert.ok(!resolvePlatformToolsTightened("explore", "role", { pull_skill: false }, {}).includes("pull_skill"));
});

test("frozen non-model holdout: exact applicability, abstention, and explicit denominators", t => {
  assert.equal(fixture.policy, "deepsonar.skill-suggestions/v1");
  assert.equal(fixture.baseline, "discovery_without_automatic_suggestion");
  assert.notEqual(fixture.splits.development.target.task_type, fixture.splits.holdout.target.task_type);
  const groups: Record<string, { cases: number; eligible: number; selected: number; wrong: number; omitted: number }> = {};
  for (const c of fixture.cases) {
    const split = fixture.splits[c.split];
    const declaration = c.missing ? undefined : JSON.stringify({ ...fixture.declaration, ...split.declaration, ...c.declaration });
    const environment = { ...fixture.environment, ...c.environment } as SuggestionEnvironment;
    const result = assessSkillApplicability(declaration, { ...fixture.target, ...split.target, ...c.target }, environment);
    assert.equal(result.status, c.expected, c.id);
    const group = groups[c.split] ??= { cases: 0, eligible: 0, selected: 0, wrong: 0, omitted: 0 };
    group.cases++;
    const eligible = c.expected === "compatible", selected = result.status === "compatible";
    group.eligible += Number(eligible); group.selected += Number(selected);
    group.wrong += Number(selected && !eligible); group.omitted += Number(eligible && !selected);
  }
  for (const split of ["development", "holdout"]) {
    const g = groups[split];
    assert.ok(g.cases >= fixture.thresholds.minimum_cases_per_split);
    assert.ok(g.eligible > 0, "omission denominator must be nonzero");
    assert.equal(g.wrong, fixture.thresholds.maximum_wrong_selections);
    assert.equal(g.omitted, fixture.thresholds.maximum_critical_omissions);
  }
  t.diagnostic(JSON.stringify({ schema: "deepsonar.skill-suggestion-engineering-acceptance/v1", groups,
    baseline: Object.fromEntries(Object.entries(groups).map(([split, g]) => [split,
      { cases: g.cases, selected: 0, wrong: 0, omitted: g.eligible, meaning: "no_automated_suggestion" }])),
    independent_business_quality: { status: "unknown", denominator: 0 },
    model_tokens: { status: "not_measured", denominator: 0 },
    monetary_cost: { status: "not_measured", denominator: 0 },
    task_wall_time: { status: "not_measured", denominator: 0 },
    uplift: "not_estimated_synthetic_small_sample", default_enablement: "not_authorized_by_this_report" }));
});

test("Job OpenAPI exposes only authorized suggestion and durable choice contracts", () => {
  const jobId = "00000000-0000-4000-8000-000000000001";
  const operations = ["suggest_project_skills", "record_skill_choice"] as const;
  const hidden = buildPlatformOpenApiDocument({ jobId, operationIds: [] }).paths as Record<string, unknown>;
  for (const operation of operations) {
    const path = `/control/v1/jobs/{jobId}/operations/${operation}`;
    assert.equal(hidden[path], undefined);
    const doc = buildPlatformOpenApiDocument({ jobId, operationIds: [operation] });
    const post = (doc.paths as Record<string, { post: { requestBody: { content: Record<string, { schema: unknown }> } } }>)[path]!.post;
    assert.deepEqual(post.requestBody.content["application/json"]!.schema, ControlToolInputSchemasJson[operation]);
    assert.equal(getPlatformOperation(operation)!.readOnly, operation === "suggest_project_skills");
    assert.equal(getPlatformOperation(operation)!.eventType, operation === "record_skill_choice" ? "knowledge" : null);
  }
  const payload = { operation: "record_skill_choice", input: { target: fixture.target,
    policy_version: fixture.policy, context_hash: "a".repeat(64), catalog_hash: "b".repeat(64),
    decision: "none", reason: "No applicable method" } };
  const event = { v: 1, event_id: jobId, type: "knowledge", payload };
  assert.equal(EventEnvelope.safeParse(event).success, true);
  assert.equal(EventEnvelope.safeParse({ ...event, payload: { ...payload, input: { ...payload.input, grant_permission: true } } }).success, false);
});
