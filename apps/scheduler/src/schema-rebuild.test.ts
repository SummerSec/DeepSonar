import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCopyInsertSql,
  CATALOG_TABLES,
  intersectColumns,
  officialCatalogBackfillSql,
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

test("official catalog backfill stays idempotent and does not wipe custom role_configs", async () => {
  const body = await readFile(SCHEMA_FILE, "utf8");
  const statements = officialCatalogBackfillSql(body);
  assert.equal(statements.length, 5);
  assert.match(statements[0] ?? "", /ON CONFLICT \(name\) DO NOTHING/);
  assert.match(statements[1] ?? "", /ON CONFLICT \(image_key\) DO NOTHING/);
  assert.match(statements[3] ?? "", /ON CONFLICT \(name\) DO NOTHING/);
  const roleInsert = roleConfigBackfillSql(body);
  assert.match(roleInsert, /AND NOT EXISTS/);
  assert.match(roleInsert, /rc.project_id IS NULL/);
  const moduleUpdate = roleConfigModuleBackfillSql(body);
  assert.match(moduleUpdate, /rc.modules_json = '\[\]'::jsonb/);
  assert.doesNotMatch(moduleUpdate, /AND r.name IN \('audit', 'review'\);$/);
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
  assert.equal(SCHEMA_VERSION, 35);
});
