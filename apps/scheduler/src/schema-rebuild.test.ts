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
  assert.equal(SCHEMA_VERSION, 37);
});

/** 基线 CREATE TABLE 里声明了 serial / IDENTITY 的列（information_schema 投影）。 */
function ownedSequenceDeclarations(schemaSql: string): Array<{
  table: string;
  column: string;
  kind: "serial" | "identity";
}> {
  const found: Array<{ table: string; column: string; kind: "serial" | "identity" }> = [];
  const tableRe = /CREATE TABLE (\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(schemaSql))) {
    const table = match[1] ?? "";
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < schemaSql.length; i += 1) {
      const ch = schemaSql[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    for (const raw of schemaSql.slice(open + 1, close).split("\n")) {
      const line = raw.replace(/--.*$/, "").trim().replace(/,$/, "");
      if (!line || /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(line)) continue;
      const col = /^(\w+)\s+(.+)$/.exec(line);
      if (!col) continue;
      const column = col[1] ?? "";
      const rest = col[2] ?? "";
      if (/\bGENERATED\s+(?:ALWAYS|BY DEFAULT)\s+AS\s+IDENTITY\b/i.test(rest)) {
        found.push({ table, column, kind: "identity" });
      } else if (/\b(?:BIGSERIAL|SMALLSERIAL|SERIAL)\b/i.test(rest)) {
        found.push({ table, column, kind: "serial" });
      }
    }
  }
  return found;
}

function catalogForDeclaration(table: string, column: string, kind: "serial" | "identity") {
  return kind === "identity"
    ? { isIdentity: "YES", columnDefault: null }
    : { isIdentity: "NO", columnDefault: `nextval('${table}_${column}_seq'::regclass)` };
}

test("owned sequence reset includes bigserial nextval defaults and IDENTITY", () => {
  assert.equal(
    isOwnedSequenceColumn({
      isIdentity: "NO",
      columnDefault: "nextval('events_id_seq'::regclass)",
    }),
    true,
  );
  assert.equal(
    isOwnedSequenceColumn({
      isIdentity: "YES",
      columnDefault: null,
    }),
    true,
  );
  assert.equal(
    isOwnedSequenceColumn({
      isIdentity: "NO",
      columnDefault: null,
    }),
    false,
  );
  assert.equal(
    isOwnedSequenceColumn({
      isIdentity: "NO",
      columnDefault: "now()",
    }),
    false,
  );
  const sql = ownedSequenceResetSql("events", "id");
  const lookup = ownedSequenceLookupSql("events", "id");
  const maxSql = ownedSequenceMaxSql("events", "id");
  assert.equal(maxSql, '(SELECT MAX("id") FROM public."events")');
  assert.match(lookup, /tbl_ns\.nspname = 'public'/);
  assert.match(lookup, /seq_ns\.nspname = 'public'/);
  assert.match(lookup, /dep\.deptype IN \('a', 'i'\)/);
  assert.doesNotMatch(lookup, /pg_get_serial_sequence/);
  assert.match(sql, /setval\(\(/);
  assert.match(sql, /GREATEST\(COALESCE\(\(SELECT MAX\("id"\) FROM public\."events"\), 1\), 1\)/);
  assert.match(sql, /\(SELECT MAX\("id"\) FROM public\."events"\) IS NOT NULL/);
  assert.doesNotMatch(sql, /pg_get_serial_sequence/);
  assert.equal(ownedSequenceSetvalIsCalled(null), false);
  assert.equal(ownedSequenceSetvalIsCalled(1), true);
  assert.equal(ownedSequenceSetvalIsCalled(42), true);
});

test("schema baseline serial and IDENTITY primary keys are all in the rebuild reset set", async () => {
  const body = await readFile(SCHEMA_FILE, "utf8");
  const declared = ownedSequenceDeclarations(body);
  assert.deepEqual(
    declared,
    [
      { table: "events", column: "id", kind: "serial" },
      { table: "audit_logs", column: "id", kind: "identity" },
    ],
  );
  for (const item of declared) {
    assert.equal(
      isOwnedSequenceColumn(catalogForDeclaration(item.table, item.column, item.kind)),
      true,
      `${item.table}.${item.column} (${item.kind}) must be reset after rebuild`,
    );
  }
});

test("owned sequence reset is over all public base tables after official seeds", async () => {
  const source = await readFile(new URL("./schema-rebuild.ts", import.meta.url), "utf8");
  assert.match(source, /await ensureOfficialSeeds\(db, schemaSql\);\s*\n\s*await reconcileOwnedSequences\(db\);/);
  assert.match(source, /await assertOwnedSequencesAligned\(db\);/);
  assert.doesNotMatch(source, /resetOwnedSequences\(db, copiedTables\)/);
  assert.doesNotMatch(source, /pg_get_serial_sequence/);
});
