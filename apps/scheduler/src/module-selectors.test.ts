import assert from "node:assert/strict";
import test from "node:test";
import {
  parseModuleSelector,
  normalizeModuleSelectorPath,
  validateModuleSelectors,
} from "@deepsonar/shared-types";
import {
  contentHashOf,
  contentHashOfSelected,
  expandCatalogSelectors,
  expandModules,
  resolveModuleNameConflicts,
  type SourceModule,
} from "./skill-sources.js";
import { sanitizeAgentSnapshot } from "./transfer/sanitize.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";

function catalog(modules: Array<Partial<SourceModule> & Pick<SourceModule, "id" | "plugin">>): SourceModule[] {
  return modules.map((module) => ({
    id: module.id,
    plugin: module.plugin,
    kind: module.kind ?? "skill",
    name: module.name ?? module.id,
    description: module.description ?? "",
    files: module.files ?? { "SKILL.md": `# ${module.id}` },
  }));
}

test("module selector parser keeps legacy and understands plugin/source selectors", () => {
  const legacy = parseModuleSelector(`${SOURCE}:whitebox/authz`);
  assert.deepEqual(
    { source_id: legacy.source_id, kind: legacy.kind, module_id: legacy.module_id, canonical: legacy.canonical },
    { source_id: SOURCE, kind: "module", module_id: "whitebox/authz", canonical: `${SOURCE}:whitebox/authz` },
  );
  assert.equal(parseModuleSelector(`${SOURCE}:plugin:whitebox/injection`).plugin, "whitebox/injection");
  assert.equal(parseModuleSelector(`${SOURCE}:source:*`).kind, "source");
  const upper = parseModuleSelector(`${SOURCE.toUpperCase()}:plugin:./whitebox//injection`);
  assert.equal(upper.source_id, SOURCE);
  assert.equal(upper.plugin, "whitebox/injection");
  assert.equal(upper.raw, `${SOURCE.toUpperCase()}:plugin:./whitebox//injection`);
});

test("selector parser rejects traversal, absolute and ambiguous formats", () => {
  assert.throws(() => parseModuleSelector(`${SOURCE}:plugin:`), /不能为空/);
  assert.throws(() => parseModuleSelector(`${SOURCE}:`), /不能为空/);
  assert.throws(() => parseModuleSelector(`${SOURCE}:plugin:../whitebox`), /不得包含/);
  assert.throws(() => parseModuleSelector(`${SOURCE}:plugin:/whitebox`), /绝对路径/);
  assert.throws(() => parseModuleSelector(`${SOURCE}:source:whitebox`), /source:\*/);
  assert.throws(() => parseModuleSelector(`not-a-uuid:plugin:whitebox`), /source UUID/);
  assert.throws(() => parseModuleSelector(`${SOURCE}:plugin:whitebox:extra`), /非法路径|未知保留前缀/);
  assert.equal(normalizeModuleSelectorPath("whitebox\\authz"), "whitebox/authz");
  assert.throws(() => normalizeModuleSelectorPath("whitebox\\..\\escape"), /不得包含/);
  assert.throws(() => normalizeModuleSelectorPath("whitebox/%2e%2e/escape"), /越界/);
  assert.throws(() => normalizeModuleSelectorPath("whitebox/%3Asecret"), /非法路径字符|越界/);
});

test("plugin and source expansion deduplicates explicit modules and follows sync additions", () => {
  const first = catalog([
    { id: "whitebox/authz", plugin: "whitebox" },
    { id: "whitebox/xxe", plugin: "whitebox" },
    { id: "blackbox/authz", plugin: "blackbox" },
  ]);
  const selectors = [
    parseModuleSelector(`${SOURCE}:plugin:whitebox`),
    parseModuleSelector(`${SOURCE}:whitebox/authz`),
  ];
  const expanded = expandCatalogSelectors(SOURCE, first, selectors);
  assert.deepEqual(expanded.missing, []);
  assert.deepEqual(expanded.modules.map(({ module }) => module.id), ["whitebox/authz", "whitebox/xxe"]);

  const afterSync = catalog([...first, { id: "whitebox/sqli", plugin: "whitebox" }]);
  const followed = expandCatalogSelectors(SOURCE, afterSync, [parseModuleSelector(`${SOURCE}:plugin:whitebox`)]);
  assert.deepEqual(followed.modules.map(({ module }) => module.id), ["whitebox/authz", "whitebox/xxe", "whitebox/sqli"]);
  const explicitOnly = expandCatalogSelectors(SOURCE, afterSync, [parseModuleSelector(`${SOURCE}:whitebox/authz`)]);
  assert.deepEqual(explicitOnly.modules.map(({ module }) => module.id), ["whitebox/authz"]);
});

test("source selector expands all catalog entries and reports missing groups", () => {
  const entries = catalog([
    { id: "whitebox/authz", plugin: "whitebox" },
    { id: "commands/review", plugin: "(root)", kind: "command", files: { "command.md": "review" } },
  ]);
  const source = expandCatalogSelectors(SOURCE, entries, [parseModuleSelector(`${SOURCE}:source:*`)]);
  assert.equal(source.modules.length, 2);
  const missingPlugin = expandCatalogSelectors(SOURCE, entries, [parseModuleSelector(`${SOURCE}:plugin:nope`)]);
  assert.match(missingPlugin.missing[0] ?? "", /plugin-not-found/);
  const empty = expandCatalogSelectors(SOURCE, [], [parseModuleSelector(`${SOURCE}:source:*`)]);
  assert.match(empty.missing[0] ?? "", /catalog-empty/);
});

test("duplicate embedded names are excluded deterministically and audited", () => {
  const duplicateSkill = catalog([
    { id: "plugin-a/one", plugin: "plugin-a", name: "shared", description: "A" },
    { id: "plugin-b/two", plugin: "plugin-b", name: "shared", description: "B" },
    { id: "plugin-c/command", plugin: "plugin-c", kind: "command", name: "shared", files: { "command.md": "run" } },
  ]);
  const resolved = resolveModuleNameConflicts([
    { source_id: SOURCE, module: duplicateSkill[0]! },
    { source_id: "22222222-2222-4222-8222-222222222222", module: duplicateSkill[1]! },
    { source_id: SOURCE, module: duplicateSkill[2]! },
  ]);
  assert.deepEqual(resolved.modules.map(({ module }) => `${module.kind}:${module.name}`), ["command:shared"]);
  assert.equal(resolved.missing_modules.length, 2);
  assert.deepEqual(
    resolved.missing_modules.map((item) => item.reason),
    ["name-conflict", "name-conflict"],
  );
  assert.equal(resolved.missing_modules[0]?.conflicts_with?.length, 1);

  const sameSource = expandCatalogSelectors(
    SOURCE,
    duplicateSkill,
    [parseModuleSelector(`${SOURCE}:source:*`)],
  );
  assert.deepEqual(sameSource.modules.map(({ module }) => `${module.kind}:${module.name}`), ["command:shared"]);
  assert.equal(sameSource.missing_modules.length, 2);

  // Hashing is over the final embedded set and is order independent.
  const finalHash = contentHashOfSelected(resolved.modules);
  assert.equal(finalHash, contentHashOfSelected([...resolved.modules].reverse()));
  const renamed = catalog([{ id: "plugin-a/one", plugin: "plugin-a", name: "shared-renamed", description: "A" }]);
  assert.notEqual(contentHashOf([duplicateSkill[0]!]), contentHashOf(renamed));
  const described = catalog([{ id: "plugin-a/one", plugin: "plugin-a", name: "shared", description: "changed" }]);
  assert.notEqual(contentHashOf([duplicateSkill[0]!]), contentHashOf(described));
});

test("expandModules returns structured missing evidence for the frozen snapshot", async () => {
  const source = catalog([
    { id: "plugin-a/one", plugin: "plugin-a", name: "shared" },
    { id: "plugin-b/two", plugin: "plugin-b", name: "shared" },
  ]);
  const fakeDb = (async () => [{
    catalog_json: source,
    trust_status: "trusted",
    enabled: true,
    last_commit_sha: "abc123",
    last_content_hash: "catalog-hash",
  }]) as unknown as Parameters<typeof expandModules>[1];
  const expanded = await expandModules(
    [`${SOURCE}:source:*`],
    fakeDb,
  );
  assert.equal(expanded.skills.length, 0);
  assert.equal(expanded.missing_modules.length, 2);
  assert.equal(expanded.missing_modules[0]?.reason, "name-conflict");
  assert.deepEqual(expanded.resolved_modules, []);
  assert.equal(expanded.content_hash, contentHashOfSelected([]));
  assert.match(expanded.missing[0] ?? "", /name-conflict/);
});

test("transfer validation preserves legal selector bytes and rejects malicious selectors", () => {
  const selectors = [`${SOURCE}:plugin:whitebox/injection`, `${SOURCE}:source:*`, `${SOURCE}:whitebox/authz`];
  assert.deepEqual(validateModuleSelectors(selectors), selectors);
  const snapshot = sanitizeAgentSnapshot({ module_selectors: selectors, modules: selectors, credential_id: null });
  assert.deepEqual(snapshot.module_selectors, selectors);
  assert.deepEqual(snapshot.modules, selectors);
  assert.throws(
    () => sanitizeAgentSnapshot({ module_selectors: [`${SOURCE}:plugin:../escape`] }),
    /不得包含/,
  );
});
