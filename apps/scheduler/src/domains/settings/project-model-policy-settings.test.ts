import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");

test("项目 settings 暴露并持久化模型白名单 / 缺省 / fallback", () => {
  assert.match(routes, /enabled_model_ids/);
  assert.match(routes, /default_model_id/);
  assert.match(routes, /fallback_model_ids/);
  assert.match(routes, /applyProjectModelPolicyPatch/);
  assert.match(routes, /model_policy_configured/);
});
