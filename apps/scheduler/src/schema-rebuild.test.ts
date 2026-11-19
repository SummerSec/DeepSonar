import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOwnedSequenceColumn,
  ownedSequenceLookupSql,
  ownedSequenceMaxSql,
  ownedSequenceResetSql,
  ownedSequenceSetvalIsCalled,
} from "./owned-sequences.js";
import {
  buildCopyInsertSql,
  CATALOG_TABLES,
  intersectColumns,
  officialCatalogBackfillSql,
  agentRoleDescriptionOverwriteSql,
  roleConfigBackfillSql,
  roleConfigModuleBackfillSql,
  topologicalCopyOrder,
} from "./schema-rebuild.js";
import { parseTableManifest, SCHEMA_FILE } from "./migration-runner.js";
import { SCHEMA_VERSION } from "./schema-version.js";

test("intersectColumns keeps only shared names in stable order", () => {
  assert.deepEqual(intersectColumns(["b", "a", "gone"], ["a", "b", "new"]), ["a", "b"]);
});

test("topologicalCopyOrder parents before children and is deterministic", () => {
  assert.deepEqual(
    topologicalCopyOrder(
      ["findings", "jobs", "projects", "canvases"],
      [
        { from: "canvases", to: "projects" },
        { from: "jobs", to: "projects" },
        { from: "jobs", to: "canvases" },
        { from: "findings", to: "jobs" },
        { from: "findings", to: "projects" },
      ],
    ),
    ["projects", "canvases", "jobs", "findings"],
  );
});

test("copy INSERT quotes identifiers and overrides identity columns", () => {
  assert.equal(
    buildCopyInsertSql({
      table: "audit_logs",
      columns: ["id", "action"],
      identityColumns: ["id"],
    }),
    'INSERT INTO public."audit_logs" ("action", "id") OVERRIDING SYSTEM VALUE ' +
      'SELECT "action", "id" FROM "deepsonar_rebuild_src"."audit_logs"',
  );
});

test("official catalog backfill overwrites builtin prompts and keeps project role_configs", async () => {
  const body = await readFile(SCHEMA_FILE, "utf8");
  const statements = officialCatalogBackfillSql(body);
  assert.equal(statements.length, 5);
  assert.match(statements[0] ?? "", /ON CONFLICT \(name\) DO NOTHING/);
  assert.match(statements[1] ?? "", /ON CONFLICT \(image_key\) DO NOTHING/);
  assert.match(statements[3] ?? "", /ON CONFLICT \(name\) DO NOTHING/);
  const roleStatements = roleConfigBackfillSql(body);
  assert.equal(roleStatements.length, 2);
  const [overwrite, insertMissing] = roleStatements;
  assert.match(overwrite ?? "", /UPDATE role_configs rc/);
  assert.match(overwrite ?? "", /instructions_markdown = templates\.instructions/);
  assert.match(overwrite ?? "", /rc\.project_id IS NULL/);
  assert.doesNotMatch(overwrite ?? "", /AND NOT EXISTS/);
  assert.match(insertMissing ?? "", /AND NOT EXISTS/);
  assert.match(insertMissing ?? "", /SELECT r\.id, NULL, templates\.instructions/);
  assert.doesNotMatch(overwrite ?? "", /SELECT r\.id/);
  assert.match(insertMissing ?? "", /rc\.project_id IS NULL/);
  const roleDesc = agentRoleDescriptionOverwriteSql(body);
  assert.equal(roleDesc.length, 2);
  assert.match(roleDesc[0] ?? "", /WHERE name = 'verify'/);
  assert.match(roleDesc[1] ?? "", /WHERE name = 'report'/);
  const moduleUpdate = roleConfigModuleBackfillSql(body);
  assert.match(moduleUpdate, /modules_json = '\[\]'::jsonb/);
  assert.match(moduleUpdate, /vuln-definitions/);
  assert.match(moduleUpdate, /project_id IS NULL/);
});

test("rebuild plan treats catalog tables as baseline-owned when source is empty", () => {
  assert.equal(CATALOG_TABLES.has("role_configs"), true);
  assert.equal(CATALOG_TABLES.has("projects"), false);
  const manifest = parseTableManifest(
    `CREATE TABLE schema_meta (id text, version int);
     CREATE TABLE projects (id uuid);
     CREATE TABLE role_configs (id uuid);`,
  );
  assert.equal(manifest.has("schema_meta"), true);
