import assert from "node:assert/strict";
import test from "node:test";
import {
  countIncludedModules,
  groupModuleOptions,
  isPluginGroupExpanded,
  moduleIsIncluded,
  moduleSelectorFor,
  pluginSelectorFor,
  sourceSelectorFor,
  togglePluginGroupExpanded,
  toggleSelector,
  type ModulePickerOption,
} from "./module-selector-state.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const option = (id: string, plugin: string): ModulePickerOption => ({
  id,
  kind: "skill",
  plugin,
  name: id,
  description: "",
  key: moduleSelectorFor(sourceId, id),
  sourceId,
  sourceName: "DeepSonar-Skills",
});

test("module picker groups source catalog by plugin and exposes stable selectors", () => {
  const groups = groupModuleOptions([option("whitebox/authz", "whitebox"), option("whitebox/xxe", "whitebox")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.selector, pluginSelectorFor(sourceId, "whitebox"));
  assert.equal(sourceSelectorFor(sourceId), `${sourceId}:source:*`);
});

test("cancelling group selector preserves independent module selections", () => {
  const explicit = moduleSelectorFor(sourceId, "blackbox/authz");
  const plugin = pluginSelectorFor(sourceId, "whitebox");
  const selected = [explicit, plugin];
  const next = toggleSelector(selected, plugin);
  assert.deepEqual(next, [explicit]);
  assert.equal(moduleIsIncluded(option("whitebox/xxe", "whitebox"), selected), true);
  assert.equal(moduleIsIncluded(option("whitebox/xxe", "whitebox"), next), false);
});

test("source selector includes current and future catalog entries without rewriting raw selection", () => {
  const selected = [sourceSelectorFor(sourceId)];
  assert.equal(moduleIsIncluded(option("whitebox/new-after-sync", "whitebox"), selected), true);
  assert.deepEqual(toggleSelector(selected, sourceSelectorFor(sourceId)), []);
});

test("plugin groups collapse by default and expand on search or user override", () => {
  assert.equal(isPluginGroupExpanded({
    groupKey: "whitebox",
    query: "",
    overrides: {},
    hasVisibleModules: true,
  }), false);
  assert.equal(isPluginGroupExpanded({
    groupKey: "whitebox",
    query: "auth",
    overrides: {},
    hasVisibleModules: true,
  }), true);
  assert.equal(isPluginGroupExpanded({
    groupKey: "whitebox",
    query: "auth",
    overrides: {},
    hasVisibleModules: false,
  }), false);
  assert.equal(isPluginGroupExpanded({
    groupKey: "whitebox",
    query: "",
    overrides: { whitebox: true },
    hasVisibleModules: true,
  }), true);
  assert.equal(isPluginGroupExpanded({
    groupKey: "whitebox",
    query: "auth",
    overrides: { whitebox: false },
    hasVisibleModules: true,
  }), false);
  const toggled = togglePluginGroupExpanded({}, "whitebox", false);
  assert.equal(toggled.get("whitebox"), true);
  assert.equal(countIncludedModules([option("a", "p"), option("b", "p")], [moduleSelectorFor(sourceId, "a")]), 1);
});
