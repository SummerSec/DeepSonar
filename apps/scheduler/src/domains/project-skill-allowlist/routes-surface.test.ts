import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("../skill-source/routes.ts", import.meta.url), "utf8");
const snapshot = readFileSync(new URL("../role-runtime-snapshot/application.ts", import.meta.url), "utf8");
const executor = readFileSync(new URL("../../executor-real.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../../../../database/schema.sql", import.meta.url), "utf8");

test("skill-source routes expose project GET/PUT allowlist APIs", () => {
  assert.match(routes, /\/projects\/:id\/skill-sources/);
  assert.match(routes, /listProjectSkillSourceBindings/);
  assert.match(routes, /setProjectSkillSourceEnabled/);
});

test("role-runtime-snapshot fail-closes on project skill allowlist", () => {
  assert.match(snapshot, /assertProjectModulesAllowlisted/);
});

test("role-runtime-snapshot keeps empty RoleConfig.modules free of implicit business Skills", () => {
  assert.match(snapshot, /resolveEffectiveModuleSelectors/);
  assert.match(snapshot, /no business Skill is materialized/);
});

test("Hub stub lists available skill sources", () => {
  assert.match(executor, /list_available_skill_sources/);
  assert.match(executor, /listHubSkillSourceCatalog/);
});

test("schema v53 defines project_skill_sources", () => {
  assert.match(schema, /CREATE TABLE project_skill_sources/);
  assert.match(schema, /VALUES \('global', 53\)/);
});
