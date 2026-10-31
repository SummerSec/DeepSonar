import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlInputError, invalidNodeReference, invalidRole } from "./control-input.js";
import { assertHubDecisionCanvasReferences, parseHubDecision } from "./graph.js";
import { HUB_REFERENCE_LIMITS, HubDecisionPayload } from "@deepsonar/shared-types";

const rootId = "00000000-0000-4000-8000-000000000001";
const otherCanvasId = "00000000-0000-4000-8000-000000000002";
const roles = new Set(["review"]);
const intentDescription = "复核已有证据并确认剩余验证边界";
const intentPrompt = "复核当前画布引用的全部证据，独立确认结论、缺口与下一步验证动作，并只提交新增事实。";

function referenceId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function boundedIntents(total: number) {
  const refs = Array.from({ length: total }, (_, index) => referenceId(index + 10));
  const intents = [];
  let offset = 0;
  while (offset < refs.length) {
    const from = refs.slice(offset, offset + HUB_REFERENCE_LIMITS.perFrom);
    intents.push({ from, role: "review", description: intentDescription, prompt: intentPrompt });
    offset += from.length;
  }
  return intents;
}

function parseIntent(from: unknown) {
  return parseHubDecision(
    JSON.stringify({ intents: [{ from, role: "review", description: intentDescription, prompt: intentPrompt }] }),
    roles,
    [rootId],
  );
}

function assertInvalidNodeRef(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ControlInputError);
    assert.equal(error.code, "invalid_node_ref");
    assert.match(error.message, /YAML root_id/);
    assert.doesNotMatch(error.message, /invalid input syntax for type uuid/i);
    return true;
  });
}

test("Hub parser rejects root_id field names and non-UUID references", () => {
  assertInvalidNodeRef(() => parseIntent(["root_id"]));
  assertInvalidNodeRef(() => parseIntent(["not-a-uuid"]));
});

test("control input errors do not echo token-like untrusted values", () => {
  const token = "ghp_super_secret_should_not_echo";
  assert.doesNotMatch(invalidNodeReference("intents.0.from.0", token).message, new RegExp(token));
  assert.doesNotMatch(invalidRole(token, "intents.0.role").message, new RegExp(token));
});

test("Hub parser accepts canonical UUIDs and rejects cross-canvas IDs", () => {
  const decision = parseIntent([rootId]);
  assert.equal(decision?.intents?.[0]?.from[0], rootId);
  assert.equal(parseIntent([])?.intents?.[0]?.from.length, 0);
  assertInvalidNodeRef(() => parseIntent([otherCanvasId]));
});

test("complete.from and missing references use the same stable rejection", () => {
  const complete = parseHubDecision(
    JSON.stringify({ complete: { from: [rootId], description: "当前目标已经由引用证据完整覆盖" } }),
    roles,
    [rootId],
  );
  assert.equal(complete?.complete?.from[0], rootId);
  assertInvalidNodeRef(() =>
    parseHubDecision(JSON.stringify({ complete: { description: "缺少引用" } }), roles, [rootId]),
  );
});

test("Hub parser rejects a single oversized from list with a stable budget error", () => {
  const oversizedFrom = Array.from({ length: HUB_REFERENCE_LIMITS.perFrom + 1 }, (_, index) => referenceId(index + 1));
  assert.throws(
    () => parseHubDecision(
      JSON.stringify({ intents: [{ from: oversizedFrom, role: "review", description: intentDescription, prompt: intentPrompt }] }),
      roles,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ControlInputError);
      assert.equal(error.code, "invalid_reference_budget");
      assert.match(error.message, /invalid_reference_budget/);
      assert.match(error.message, /complete\.from|intents\.0\.from/);
      return true;
    },
  );
});

test("Hub parser rejects total unique references across intents but accepts the exact boundary", () => {
  const atLimit = parseHubDecision(JSON.stringify({ intents: boundedIntents(HUB_REFERENCE_LIMITS.totalUnique) }), roles);
  assert.equal(atLimit?.intents?.reduce((total, intent) => total + intent.from.length, 0), HUB_REFERENCE_LIMITS.totalUnique);

  assert.throws(
    () => parseHubDecision(JSON.stringify({ intents: boundedIntents(HUB_REFERENCE_LIMITS.totalUnique + 1) }), roles),
    (error: unknown) => {
      assert.ok(error instanceof ControlInputError);
      assert.equal(error.code, "invalid_reference_budget");
      assert.match(error.message, /intents/);
      return true;
    },
  );
});

test("shared Hub schema enforces per-from and total reference budgets", () => {
  const perFrom = HubDecisionPayload.safeParse({
    intents: [{ from: Array.from({ length: HUB_REFERENCE_LIMITS.perFrom + 1 }, (_, index) => referenceId(index + 1)), role: "review", description: intentDescription, prompt: intentPrompt }],
  });
  assert.equal(perFrom.success, false);

  const total = HubDecisionPayload.safeParse({ intents: boundedIntents(HUB_REFERENCE_LIMITS.totalUnique + 1) });
  assert.equal(total.success, false);
});

test("duplicate references count once toward the total budget and are queried once", async () => {
  const decision = parseHubDecision(
    JSON.stringify({ intents: [{ from: Array(HUB_REFERENCE_LIMITS.perFrom).fill(rootId), role: "review", description: intentDescription, prompt: intentPrompt }] }),
    roles,
    [rootId],
  );
  assert.equal(decision?.intents?.[0]?.from.length, HUB_REFERENCE_LIMITS.perFrom);

  const queries: Array<{ values: unknown[] }> = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings;
    queries.push({ values });
    return Promise.resolve([{ id: rootId, node_type: "root" }]);
  }) as unknown as Parameters<typeof assertHubDecisionCanvasReferences>[0];
  await assertHubDecisionCanvasReferences(tx, "canvas-1", decision!);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.values[0], [rootId]);
});

test("max Hub decision uses one batched membership query with no per-reference reads", async () => {
  const decision = parseHubDecision(JSON.stringify({ intents: boundedIntents(HUB_REFERENCE_LIMITS.totalUnique) }), roles);
  const refs = decision?.intents?.flatMap((intent) => intent.from) ?? [];
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: [...strings].join("?"), values });
    return Promise.resolve(refs.map((id) => ({ id, node_type: "fact" })));
  }) as unknown as Parameters<typeof assertHubDecisionCanvasReferences>[0];

  const validated = await assertHubDecisionCanvasReferences(tx, "canvas-1", decision!);
  assert.equal(validated.size, HUB_REFERENCE_LIMITS.totalUnique);
  assert.equal(queries.length, 1);
  assert.equal((queries[0]?.values[0] as string[]).length, HUB_REFERENCE_LIMITS.totalUnique);
  assert.match(queries[0]?.text ?? "", /ANY/);
});
