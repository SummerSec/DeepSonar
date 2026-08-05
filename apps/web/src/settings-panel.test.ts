import assert from "node:assert/strict";
import test from "node:test";
import type { AuthMe } from "./api";
import { resolveSettingsSectionTab, resolveSettingsTab, settingsSectionDataNeeds, settingsTabsForActor } from "./SettingsPanel";

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

test("global settings sections cannot expose another governance domain", () => {
  assert.equal(resolveSettingsSectionTab("agents", "credentials"), "roles");
  assert.equal(resolveSettingsSectionTab("credentials", "roles"), "credentials");
  assert.equal(resolveSettingsSectionTab("access", "tokens"), "tokens");
  assert.equal(resolveSettingsSectionTab("platform", "transfer"), "transfer");
});

test("global settings sections load only their owned data domains", () => {
  assert.deepEqual(settingsSectionDataNeeds(null, "credentials"), { agent: false, modules: false, roleCredentialBindings: false });
  assert.deepEqual(settingsSectionDataNeeds(null, "modules"), { agent: false, modules: true, roleCredentialBindings: false });
  assert.deepEqual(settingsSectionDataNeeds(null, "platform"), { agent: false, modules: false, roleCredentialBindings: false });
  assert.deepEqual(settingsSectionDataNeeds("project-id", "agents"), { agent: true, modules: true, roleCredentialBindings: true });
});

test("global settings tabs follow the scheduler permission model", () => {
  const viewer: AuthMe = { auth_required: true, authenticated: true, actor: { type: "user", name: "viewer", role: "viewer", scopes: ["projects:read", "agents:read", "exports:read"] }, user: null };
  const operator: AuthMe = { auth_required: true, authenticated: true, actor: { type: "user", name: "operator", role: "operator", scopes: ["projects:read", "agents:read", "agents:write"] }, user: null };
  assert.deepEqual(settingsTabsForActor("access", viewer), ["account"]);
  assert.deepEqual(settingsTabsForActor("access", operator), ["account"]);
  assert.deepEqual(settingsTabsForActor("platform", viewer), ["rules", "transfer"]);
  assert.deepEqual(settingsTabsForActor("credentials", viewer), ["credentials"]);
});
