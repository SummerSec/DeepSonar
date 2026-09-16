import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");

test("项目 settings 暴露并持久化 CLI/Provider 白名单与软缺省", () => {
  assert.match(routes, /enabled_agent_clis/);
  assert.match(routes, /enabled_credential_ids/);
  assert.match(routes, /default_agent_cli/);
  assert.match(routes, /default_credential_id/);
  assert.match(routes, /applyProjectAgentAllowlistPatch/);
  assert.match(routes, /seedProjectAgentAllowlist/);
  assert.match(routes, /projectAllowlistResponse/);
});
