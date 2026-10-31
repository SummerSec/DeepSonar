import test from "node:test";
import assert from "node:assert/strict";
import { pageKnowledgeInput } from "./input-page.js";
import { KNOWLEDGE_LIMITS } from "@deepsonar/shared-types";

test("knowledge input pages preserve UTF8 and bind cursor to its authorized input", () => {
  const input = { long: "项目😀".repeat(6000) }, scope = "frozen-job/work/input/hash";
  let cursor: string | undefined, text = "", pages = 0;
  do {
    const page = pageKnowledgeInput(input, scope, cursor);
    assert.ok(Buffer.byteLength(page.content_fragment, "utf8") <= KNOWLEDGE_LIMITS.readBytes);
    assert.ok(!page.content_fragment.includes("�"));
    text += page.content_fragment; cursor = page.next_cursor ?? undefined; pages++;
    if (cursor) assert.throws(() => pageKnowledgeInput(input, "another-input", cursor), /cursor/i);
  } while (cursor);
  assert.deepEqual(JSON.parse(text), input); assert.ok(pages > 1);
  assert.throws(() => pageKnowledgeInput(input, scope, "not-a-cursor"), /cursor/i);
});
