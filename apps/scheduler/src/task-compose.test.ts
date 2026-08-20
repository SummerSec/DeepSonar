import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_TASK_SEED_FINDINGS,
  TaskSeedInputError,
  freezeTaskSeedTarget,
  frozenTaskSeeds,
  taskTargetForPrompt,
} from "./task-compose.js";
import { serializeFindingStatusIndex } from "./graph.js";
import { buildOpenApiDocument } from "./openapi.js";

const noDb = null as never;
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("compose integration teardown deletes events before jobs", () => {
  const source = readFileSync(new URL("./task-compose.integration.test.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("async function wipeProjectComposeFixtures");
  const helper = source.slice(helperStart, source.indexOf("if (!testDatabaseUrl)"));
  const eventsAt = helper.indexOf("DELETE FROM events");
  const jobsAt = helper.lastIndexOf("DELETE FROM jobs");
  assert.ok(helperStart >= 0);
  assert.match(helper, /DELETE FROM event_dedup/);
  assert.match(helper, /parent_job_id = NULL/);
  assert.match(helper, /finding_verification_rounds/);
  assert.ok(eventsAt >= 0 && eventsAt < jobsAt);
  assert.equal(source.split("wipeProjectComposeFixtures(").length - 1, 3);
});

test("OpenAPI advertises compose task input and Finding candidate filters", () => {
  const document = buildOpenApiDocument() as {
    paths: Record<string, Record<string, {
      parameters?: Array<{ name: string }>;
      requestBody?: { content?: { "application/json"?: { schema?: { properties?: Record<string, unknown> } } } };
    }>>;
  };
  const taskProperties = document.paths["/projects/{id}/tasks"].post.requestBody?.content?.["application/json"]?.schema?.properties ?? {};
  assert.ok("kind" in taskProperties);
  assert.ok("seed_finding_ids" in taskProperties);
  assert.doesNotMatch(JSON.stringify(taskProperties.seed_finding_ids), /当前 confirmed/);
  assert.match(JSON.stringify(taskProperties.seed_finding_ids), /未确认/);
  const findingFilters = new Set((document.paths["/findings"].get.parameters ?? []).map((parameter) => parameter.name));
  for (const filter of ["severity", "profile", "category", "verify_status", "disposition"]) assert.ok(findingFilters.has(filter));
});

test("standard tasks remain seedless and unauthorized entries cannot opt into compose", async () => {
  const target = await freezeTaskSeedTarget(noDb, id(99), { goal: "plain" });
  assert.equal(target.kind, "standard");
  assert.deepEqual(frozenTaskSeeds(target), []);

  await assert.rejects(
    freezeTaskSeedTarget(noDb, id(99), { kind: "compose", seed_finding_ids: [id(1)] }),
    (error: unknown) => error instanceof TaskSeedInputError && /不允许选择历史/.test(error.message),
  );
});

test("standard rejects any seed field and compose enforces a unique bounded explicit selection", async () => {
  await assert.rejects(
    freezeTaskSeedTarget(noDb, id(99), { kind: "standard", seed_finding_ids: [] }, true),
    /standard 任务禁止/,
  );
  await assert.rejects(
    freezeTaskSeedTarget(noDb, id(99), { kind: "compose", seed_finding_ids: [] }, true),
    /必须选择 1-/,
  );
  await assert.rejects(
    freezeTaskSeedTarget(noDb, id(99), { kind: "compose", seed_finding_ids: [id(1), id(1)] }, true),
    /不能重复/,
  );
  await assert.rejects(
    freezeTaskSeedTarget(noDb, id(99), {
      kind: "compose",
      seed_finding_ids: Array.from({ length: MAX_TASK_SEED_FINDINGS + 1 }, (_, index) => id(index + 1)),
    }, true),
    /必须选择 1-/,
  );
});

test("frozen compose targets retain summaries while prompt targets hide database identities", () => {
  const target = {
    kind: "compose",
    goal: "combine evidence",
    seed_finding_ids: [id(1)],
    seed_findings: [{
      id: id(1),
      title: "Known primitive",
      severity: "high",
      profile: "security",
      category: "injection",
      tags: ["chain"],
      location: "src/a.ts:1",
      summary: "Untrusted historical data",
      origin_canvas_id: id(2),
      origin_job_id: id(3),
      disposition: "open",
      verify_status: "confirmed",
    }],
  };
  assert.equal(frozenTaskSeeds(target)[0].id, id(1));
  const prompt = taskTargetForPrompt(target);
  assert.equal(prompt.kind, "compose");
  assert.equal(prompt.seed_count, 1);
  assert.equal("seed_finding_ids" in prompt, false);
  assert.equal("seed_findings" in prompt, false);
  assert.deepEqual((prompt.compose_scope as { mode: string; locations: string[] }).mode, "seed_assets_only");
  assert.deepEqual((prompt.compose_scope as { locations: string[] }).locations, ["src/a.ts:1"]);
});

test("Hub Finding index marks imported seeds and never serializes their database Finding id", () => {
  const result = serializeFindingStatusIndex([{
    id: id(10),
    finding_id: null,
    title: "Imported primitive",
    severity: "high",
    verify_status: "confirmed",
    imported: true,
  }], 4_000);
  const serialized = result.lines.join("\n");
  assert.match(serialized, /"imported":true/);
  assert.match(serialized, /"readonly":true/);
  assert.doesNotMatch(serialized, /finding_id/);
});
