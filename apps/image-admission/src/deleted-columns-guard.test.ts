import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** #704 / Schema v55: project_runtime_images.selected_version_id and pin_policy were dropped.
 *  image-admission must not query those columns (Postgres 42703 on startup). */
test("image-admission source must not reference deleted project_runtime_images pin columns", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = here.endsWith(`${path.sep}dist`) || here.endsWith("/dist")
    ? path.resolve(here, "../src")
    : here;
  const indexSource = readFileSync(path.join(srcDir, "index.ts"), "utf8");
  assert.doesNotMatch(
    indexSource,
    /selected_version_id/,
    "index.ts must not reference selected_version_id (removed in schema v55 / #691)",
  );
  assert.doesNotMatch(
    indexSource,
    /\bpin_policy\b/,
    "index.ts must not reference pin_policy (removed in schema v55 / #691)",
  );
  assert.doesNotMatch(
    indexSource,
    /FROM\s+project_runtime_images\b/i,
    "index.ts must not query project_runtime_images for pin state",
  );
});
