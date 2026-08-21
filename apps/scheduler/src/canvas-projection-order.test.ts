import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("./domains/canvas/routes.ts", import.meta.url), "utf8");

test("canvas snapshots expose deterministic creation order for projection inputs", () => {
  assert.equal(
    routes.match(/FROM canvas_nodes WHERE canvas_id = \$\{(?:id|project\.canvas_id)\} ORDER BY created_at, id/g)?.length,
    3,
  );
  assert.equal(
    routes.match(/FROM canvas_edges WHERE canvas_id = \$\{(?:id|project\.canvas_id)\} ORDER BY created_at, id/g)?.length,
    3,
  );
});
