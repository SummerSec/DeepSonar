import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  healRoleConfigSelectorsAfterSync,
  rewriteModuleSelectorsForCatalog,
  scanSkillSourceRepo,
  suggestMigratedModuleId,
} from "./skill-sources.js";

const SOURCE = "f150e774-d237-57e4-847c-4800722f88ee";

function writeSkill(repoRoot: string, relDir: string, name: string, body = `# ${name}\n`): void {
  const dir = path.join(repoRoot, ...relDir.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test ${name}\n---\n${body}`,
    "utf8",
  );
}

function withTempRepo(run: (repoRoot: string) => void): void {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "deepsonar-scan-"));
  try {
    run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("scanSkillSourceRepo bare layout uses relative dir as module id (no invented skills/)", () => {
  withTempRepo((repoRoot) => {
    writeSkill(repoRoot, "vuln-scoring", "vuln-scoring");
    writeSkill(repoRoot, "vuln-definitions", "vuln-definitions");
    mkdirSync(path.join(repoRoot, "vuln-scoring", ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(repoRoot, "vuln-scoring", ".claude-plugin", "plugin.json"), "{}", "utf8");

    const catalog = scanSkillSourceRepo(repoRoot);
    const ids = catalog.map((m) => m.id).sort();
    assert.deepEqual(ids, ["vuln-definitions", "vuln-scoring"]);
    const scoring = catalog.find((m) => m.id === "vuln-scoring");
    assert.equal(scoring?.plugin, "vuln-scoring");
    assert.ok(scoring?.files["SKILL.md"]);
    assert.ok(!ids.some((id) => id.includes("/skills/")));
  });
});

test("scanSkillSourceRepo wrapped layout keeps plugin/skills/name path", () => {
  withTempRepo((repoRoot) => {
    writeSkill(repoRoot, "whitebox/authz/skills/wb-authz", "wb-authz");
    mkdirSync(path.join(repoRoot, "whitebox", "authz", ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, "whitebox", "authz", ".claude-plugin", "plugin.json"),
      "{}",
      "utf8",
    );

    const catalog = scanSkillSourceRepo(repoRoot);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]?.id, "whitebox/authz/skills/wb-authz");
    assert.equal(catalog[0]?.plugin, "whitebox/authz");
    assert.equal(catalog[0]?.name, "wb-authz");
  });
});

test("scanSkillSourceRepo mixed layouts produce path-faithful ids", () => {
  withTempRepo((repoRoot) => {
    writeSkill(repoRoot, "vuln-scoring", "vuln-scoring");
    writeSkill(repoRoot, "mobile-audit/skills/mobile-app-audit", "mobile-app-audit");
    const ids = scanSkillSourceRepo(repoRoot).map((m) => m.id).sort();
    assert.deepEqual(ids, ["mobile-audit/skills/mobile-app-audit", "vuln-scoring"]);
  });
});

test("suggestMigratedModuleId maps wrapped foo/skills/foo → bare foo", () => {
  const newIds = new Set(["vuln-definitions", "vuln-scoring", "whitebox/authz/skills/wb-authz"]);
  assert.equal(
    suggestMigratedModuleId("vuln-definitions/skills/vuln-definitions", newIds),
    "vuln-definitions",
  );
  assert.equal(suggestMigratedModuleId("vuln-scoring/skills/vuln-scoring", newIds), "vuln-scoring");
  assert.equal(suggestMigratedModuleId("whitebox/authz/skills/wb-authz", newIds), "whitebox/authz/skills/wb-authz");
});

test("suggestMigratedModuleId uses unique basename when /skills/ parent missing", () => {
  const newIds = new Set(["whitebox/authz/skills/wb-authz", "vuln-scoring"]);
  assert.equal(suggestMigratedModuleId("legacy/skills/wb-authz", newIds), "whitebox/authz/skills/wb-authz");
  assert.equal(suggestMigratedModuleId("gone/skills/missing", newIds), null);
  // Ambiguous basename → null (do not guess)
  const ambiguous = new Set(["a/skills/shared", "b/skills/shared"]);
  assert.equal(suggestMigratedModuleId("old/skills/shared", ambiguous), null);
});

test("rewriteModuleSelectorsForCatalog migrates dangling module selectors and keeps others", () => {
  const newIds = new Set(["vuln-definitions", "whitebox/authz/skills/wb-authz"]);
  const rewritten = rewriteModuleSelectorsForCatalog(
    [
      `${SOURCE}:vuln-definitions/skills/vuln-definitions`,
      `${SOURCE}:plugin:whitebox/authz`,
      `${SOURCE}:source:*`,
      `${SOURCE}:whitebox/authz/skills/wb-authz`,
      `${SOURCE}:deleted/skills/gone`,
    ],
    SOURCE,
    newIds,
  );
  assert.deepEqual(rewritten.selectors, [
    `${SOURCE}:vuln-definitions`,
    `${SOURCE}:plugin:whitebox/authz`,
    `${SOURCE}:source:*`,
    `${SOURCE}:whitebox/authz/skills/wb-authz`,
  ]);
  assert.deepEqual(rewritten.migrated, [
    {
      from: `${SOURCE}:vuln-definitions/skills/vuln-definitions`,
      to: `${SOURCE}:vuln-definitions`,
    },
  ]);
  assert.deepEqual(rewritten.removed, [`${SOURCE}:deleted/skills/gone`]);
  assert.equal(rewritten.changed, true);
});

test("rewriteModuleSelectorsForCatalog dedupes when migration target already selected", () => {
  const newIds = new Set(["vuln-definitions"]);
  const rewritten = rewriteModuleSelectorsForCatalog(
    [
      `${SOURCE}:vuln-definitions`,
      `${SOURCE}:vuln-definitions/skills/vuln-definitions`,
    ],
    SOURCE,
    newIds,
  );
  assert.deepEqual(rewritten.selectors, [`${SOURCE}:vuln-definitions`]);
  assert.equal(rewritten.migrated.length, 1);
  assert.equal(rewritten.changed, true);
});

test("rewriteModuleSelectorsForCatalog ignores other skill sources", () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const newIds = new Set(["vuln-definitions"]);
  const rewritten = rewriteModuleSelectorsForCatalog(
    [`${other}:vuln-definitions/skills/vuln-definitions`, `${SOURCE}:vuln-definitions/skills/vuln-definitions`],
    SOURCE,
    newIds,
  );
  assert.deepEqual(rewritten.selectors, [
    `${other}:vuln-definitions/skills/vuln-definitions`,
    `${SOURCE}:vuln-definitions`,
  ]);
});

test("healRoleConfigSelectorsAfterSync persists migrated/removed selectors and audits", async () => {
  const sourceId = SOURCE;
  const roleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const updates: unknown[] = [];
  const audits: unknown[] = [];
  const rows = [
    {
      id: roleId,
      project_id: null,
      modules_json: [
        `${SOURCE}:vuln-definitions/skills/vuln-definitions`,
        `${SOURCE}:source:*`,
        `${SOURCE}:deleted/only`,
      ],
    },
  ];

  const fakeDb = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlText = strings.join("?");
      if (sqlText.includes("SELECT id, project_id, modules_json")) {
        return rows;
      }
      if (sqlText.includes("UPDATE role_configs")) {
        updates.push({ sqlText, values });
        return [{ id: roleId }];
      }
      throw new Error(`unexpected sql: ${sqlText}`);
    },
    {
      json: (value: unknown) => ({ __json: value }),
    },
  );

  const summary = await healRoleConfigSelectorsAfterSync({
    sourceId,
    newCatalogIds: new Set(["vuln-definitions"]),
    db: fakeDb as never,
    recordAudit: async (entry) => {
      audits.push(entry);
    },
  });

  assert.equal(summary.role_configs_updated, 1);
  assert.deepEqual(summary.migrated, [
    {
      role_config_id: roleId,
      from: `${SOURCE}:vuln-definitions/skills/vuln-definitions`,
      to: `${SOURCE}:vuln-definitions`,
    },
  ]);
  assert.deepEqual(summary.removed, [
    { role_config_id: roleId, selector: `${SOURCE}:deleted/only` },
  ]);
  assert.equal(updates.length, 1);
  const payload = (updates[0] as { values: unknown[] }).values;
  assert.deepEqual((payload[0] as { __json: string[] }).__json, [
    `${SOURCE}:vuln-definitions`,
    `${SOURCE}:source:*`,
  ]);
  assert.equal(audits.length, 1);
  assert.equal((audits[0] as { action: string }).action, "skill_source.resync_selector_cleanup");
});
