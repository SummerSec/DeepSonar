import assert from "node:assert/strict";
import test from "node:test";
import {
  groupModuleOptions,
  moduleIsIncluded,
  moduleSelectorFor,
  pluginSelectorFor,
  sourceSelectorFor,
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
