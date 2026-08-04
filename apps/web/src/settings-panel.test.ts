import assert from "node:assert/strict";
import test from "node:test";
import { resolveSettingsTab } from "./SettingsPanel";

test("global settings accepts repair tabs from the URL", () => {
  assert.equal(resolveSettingsTab(null, "credentials"), "credentials");
  assert.equal(resolveSettingsTab(null, "roles"), "roles");
  assert.equal(resolveSettingsTab(null, "rules"), "rules");
});

test("project settings only accepts project-owned tabs and falls back safely", () => {
  assert.equal(resolveSettingsTab("11111111-1111-4111-8111-111111111111", "roles"), "roles");
  assert.equal(resolveSettingsTab("11111111-1111-4111-8111-111111111111", "rules"), "rules");
  assert.equal(resolveSettingsTab("11111111-1111-4111-8111-111111111111", "credentials"), "roles");
  assert.equal(resolveSettingsTab("11111111-1111-4111-8111-111111111111", "missing"), "roles");
});
