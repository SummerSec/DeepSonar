import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./pages/TasksPage.tsx", import.meta.url), "utf8");

test("NewTaskForm keeps the form open and renders the server failure", () => {
  assert.match(source, /const \[creationError, setCreationError\]/);
  assert.match(source, /catch \(error\)[\s\S]*?setCreationError\(message\)/);
  assert.match(source, /role="alert"[\s\S]*?任务未创建：\{creationError\}/);
  const catchBody = source.match(/catch \(error\) \{([\s\S]*?)\n\s*\} finally/)?.[1] ?? "";
  assert.doesNotMatch(catchBody, /onDone\(/);
});
