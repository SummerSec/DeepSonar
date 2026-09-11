import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("task canvas decision overview passes report version and last-updated inputs", () => {
  const page = readFileSync(path.resolve(import.meta.dirname, "../pages/TaskCanvasPage.tsx"), "utf8");
  assert.match(page, /projectTaskOutcomeSummary\(\{/);
  assert.match(page, /version: taskReport\.version/);
  assert.match(page, /status: taskReport\.status/);
  assert.match(page, /generated_at: taskReport\.summary_json\?\.generated_at/);
  assert.match(page, /updated_at: taskReport\.updated_at/);
  assert.match(page, /created_at: taskReport\.created_at/);
  assert.match(page, /canvasUpdatedAt: meta\?\.created_at/);
});
