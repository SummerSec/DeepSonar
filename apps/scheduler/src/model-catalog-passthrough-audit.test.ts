import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsRoutes = readFileSync(new URL("./domains/settings/routes.ts", import.meta.url), "utf8");
const roleConfigRoutes = readFileSync(new URL("./domains/role-config/routes.ts", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("./core.ts", import.meta.url), "utf8");

test("enabling model catalog passthrough writes dedicated audit actions (#679)", () => {
  assert.match(settingsRoutes, /project\.model_catalog_passthrough_enabled/);
  assert.match(settingsRoutes, /beforePassthrough/);
  assert.match(roleConfigRoutes, /role_config\.model_catalog_passthrough_enabled/);
  assert.match(coreSource, /job\.model_catalog_passthrough/);
});
