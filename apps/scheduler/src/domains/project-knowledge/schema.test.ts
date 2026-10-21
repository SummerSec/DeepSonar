import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  SearchProjectKnowledgePayload, GetKnowledgeReceiptPayload, ProposeProjectKnowledgePayload,
  KnowledgeSkillBundle, KnowledgeControlPayloadSchemas,
} from "@deepsonar/shared-types";

test("knowledge search rejects caller identity, bounds pagination and keeps JSON schema object-shaped", () => {
  assert.equal(SearchProjectKnowledgePayload.safeParse({ query: "登录", project_id: "forged" }).success, false);
  assert.equal(SearchProjectKnowledgePayload.safeParse({ limit: 21 }).success, false);
  assert.equal(SearchProjectKnowledgePayload.parse({}).limit, 10);
  for (const schema of Object.values(KnowledgeControlPayloadSchemas)) {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    assert.equal(json.type, "object");
    assert.equal(json.anyOf, undefined);
    assert.equal(json.oneOf, undefined);
    assert.equal(json.additionalProperties, false);
  }
});

test("receipt lookup takes exactly one reference", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(GetKnowledgeReceiptPayload.safeParse({}).success, false);
  assert.equal(GetKnowledgeReceiptPayload.safeParse({ receipt_ref: id, idempotency_key: id }).success, false);
  assert.equal(GetKnowledgeReceiptPayload.safeParse({ receipt_ref: id }).success, true);
});

test("text packages reject executable files, traversal, aliases and oversized UTF8 bytes", () => {
  assert.equal(KnowledgeSkillBundle.safeParse({ "SKILL.md": "# inspect", "references/guide.md": "safe" }).success, true);
  for (const path of ["../SKILL.md", "/SKILL.md", "references/../secret.md", "scripts/run.sh", "references\\guide.md", "references/run.py"]) {
    assert.equal(KnowledgeSkillBundle.safeParse({ "SKILL.md": "safe", [path]: "bad" }).success, false, path);
  }
  assert.equal(KnowledgeSkillBundle.safeParse({ "SKILL.md": "中".repeat(44000) }).success, false);
  assert.equal(KnowledgeSkillBundle.safeParse({ "references/guide.md": "no entrypoint" }).success, false);
});

test("proposal requires a work, exact baseline, sources and bounded memory", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const candidate = { kind: "memory", logical_key: "observations/login", title: "登录观察", content: "an unverified observation", files: undefined, keywords: [] };
  const input = { work_ref: id, action: "create", revision: 1, base_refs: [], source_refs: [], reason: "record observation", candidate };
  assert.equal(ProposeProjectKnowledgePayload.safeParse(input).success, true);
  assert.equal(ProposeProjectKnowledgePayload.safeParse({ ...input, candidate: { ...candidate, content: "中".repeat(4097) } }).success, false);
  assert.equal(ProposeProjectKnowledgePayload.safeParse({ ...input, reviewer_ref: id }).success, false);
});
