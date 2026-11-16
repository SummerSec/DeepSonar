import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPublicJobTypeAllowed } from "./routes.js";
import { OperatorSettlementBody } from "./effect-settlement-routes.js";
import { actorHasScope, requiredScopeForRoute } from "../../auth.js";

const enabledRoles = [{ name: "explore" }, { name: "review" }];

test("operator settlement keeps strict single-effect input and admin authority", () => {
  const body = { outcome: "not_applied", evidence: "  operator inspected original host receipt  ", operation_id: "settle.1002:1" };
  assert.equal(OperatorSettlementBody.parse(body).evidence, body.evidence.trim());
  for (const patch of [{ evidence: "short" }, { evidence: "x".repeat(513) }, { outcome: "safe_to_retry" },
    { operation_id: "new key" }, { connection: { password: "must-not-accept" } }, { job_id: "caller-scope" }]) {
    assert.equal(OperatorSettlementBody.safeParse({ ...body, ...patch }).success, false);
  }
  const scope = requiredScopeForRoute("POST", "/jobs/:id/effects/:effectId/settlement");
  assert.equal(scope, "admin");
  assert.equal(actorHasScope({ type: "api_token", id: "token", name: "controller", projectId: null, scopes: ["jobs:control"] }, scope), false);
});

test("public POST /jobs rejects an ordinary role disabled for the project", () => {
  assert.equal(isPublicJobTypeAllowed("analyze", enabledRoles), false);
});

test("public POST /jobs rejects an unknown ordinary role", () => {
  assert.equal(isPublicJobTypeAllowed("not-registered", enabledRoles), false);
});

test("public POST /jobs rejects leftover audit_module and hub type aliases", () => {
  assert.equal(isPublicJobTypeAllowed("audit_module", [{ name: "audit" }]), false);
  assert.equal(isPublicJobTypeAllowed("hub", [{ name: "hub_reason" }]), false);
  assert.equal(isPublicJobTypeAllowed("audit", [{ name: "audit" }]), true);
});

test("public POST /jobs preserves the governed verify snapshot compatibility lane", () => {
  assert.equal(isPublicJobTypeAllowed("verify", []), true);
});

test("GET /jobs/:id returns operator-visible dispatched_prompt without runtime_context", () => {
  const source = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.match(source, /extractDispatchPrompt/);
  assert.match(source, /dispatched_prompt: dispatchedPrompt \|\| null/);
  assert.match(source, /SELECT title, target_json FROM canvases/);
  assert.doesNotMatch(source, /runtime_context\.prompt/);
});

test("job stream HTTP envelope no longer duplicates items as events", () => {
  const source = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /events: result\.items/);
  assert.doesNotMatch(source, /compatibility alias while `items`/);
});

test("GET /jobs 的查询耗时必须进指标直方图（#1136 建议 D）", () => {
  const source = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ observe \} from "\.\.\/\.\.\/metrics\.js"/);
  assert.match(source, /observe\("deepsonar_api_list_query_seconds", \(performance\.now\(\) - queryStartedAt\) \/ 1000/);
  // 评审 P2：失败查询也必须进样本，异常照常透传
  assert.match(source, /\.catch\(\(error: unknown\) => \{\s*queryResult = "error";\s*throw error;/);
  assert.match(source, /result: queryResult/);
  // 只覆盖 SQL 段：测量起点在 limit 计算之后、SELECT 之前
  assert.ok(source.indexOf("const queryStartedAt = performance.now();") < source.indexOf("SELECT j.id, j.project_id"));
});
