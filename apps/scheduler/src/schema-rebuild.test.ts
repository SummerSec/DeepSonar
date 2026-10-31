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
  assert.equal(SCHEMA_VERSION, 66);
});

test("role prompt backfill accepts LF and Windows CRLF baselines", async () => {
  const body = (await readFile(SCHEMA_FILE, "utf8")).replace(/\r\n/g, "\n");
  assert.deepEqual(roleConfigBackfillSql(body.replace(/\n/g, "\r\n")), roleConfigBackfillSql(body));
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
      { table: "device_events", column: "id", kind: "serial" },
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

test("Finding backup restore uses private connection environment and redacts child-process failures", async () => {
  const { restoreFindingSourceBackup } = await import("./schema-rebuild-finding-fixture.js");
  const target = new URL("postgres://fixture-user:fixture%3Asecret@127.0.0.1:55471/fixture-backup?sslmode=require");
  let called = false;
  restoreFindingSourceBackup(target, "/tmp/fixture.dump", (command, args, options) => {
    called = true;
    assert.equal(command, "pg_restore");
    assert.deepEqual(args, ["--exit-on-error", "--dbname", "fixture-backup", "/tmp/fixture.dump"]);
    assert.equal(options.env?.PGHOST, "127.0.0.1");
    assert.equal(options.env?.PGPORT, "55471");
    assert.equal(options.env?.PGUSER, "fixture-user");
    assert.equal(options.env?.PGPASSWORD, "fixture:secret");
    assert.equal(options.env?.PGSSLMODE, "require");
    assert.equal(options.stdio, "pipe");
    assert.equal(options.timeout, 30_000);
  });
  assert.equal(called, true);
  assert.throws(() => restoreFindingSourceBackup(target, "/tmp/fixture.dump", () => {
    throw Object.assign(new Error(`Command failed: ${target}`), { stderr: "fixture:secret", stdout: "fixture-user" });
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /backup restore failed/);
    assert.doesNotMatch(error.message, /fixture|postgres:\/\//);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), []);
    return true;
  });
});

test("CI dump and restore clients are pinned to the PostgreSQL 16 service", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /  gate:\n    runs-on: ubuntu-24\.04/);
  assert.match(workflow, /image: postgres:16-alpine/);
  assert.match(workflow, /apt-get install -y postgresql-client-16\b/);
  assert.match(workflow, /echo "\/usr\/lib\/postgresql\/16\/bin" >> "\$GITHUB_PATH"/);
  assert.doesNotMatch(workflow, /apt-get install -y postgresql-client\s*$/m);
});


test("CI uses installed PG16 without apt and rejects mismatched clients", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const workflow = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const block = workflow.match(/      - name: Select PostgreSQL 16 client[^\n]*\n        run: \|\n([\s\S]*?)\n\n/);
  assert.ok(block, "execute the actual CI setup script");
  const directory = await mkdtemp(join(tmpdir(), "deepsonar-pg16-setup-"));
  try {
    const script = block[1].split("\n").map(line => line.slice(10)).join("\n")
      .replaceAll("/usr/lib/postgresql/16/bin", directory);
    const pathFile = join(directory, "github-path");
    const aptMarker = join(directory, "apt-called");
    await writeFile(join(directory, "pg_dump"), '#!/bin/sh\necho "pg_dump (PostgreSQL) 16.15"\n', { mode: 0o755 });
    await writeFile(join(directory, "pg_restore"), '#!/bin/sh\necho "pg_restore (PostgreSQL) 16.15"\n', { mode: 0o755 });
    await writeFile(join(directory, "sudo"), `#!/bin/sh\ntouch "${aptMarker}"\nexit 19\n`, { mode: 0o755 });
    const run = () => spawnSync("bash", ["-e", "-c", script], {
      encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_PATH: pathFile },
    });
    assert.equal(run().status, 0);
    assert.equal((await readFile(pathFile, "utf8")).trim(), directory);
    await assert.rejects(readFile(aptMarker), { code: "ENOENT" });
    await writeFile(join(directory, "pg_restore"), '#!/bin/sh\necho "pg_restore (PostgreSQL) 17.1"\n', { mode: 0o755 });
    assert.notEqual(run().status, 0, "existing but wrong-major tools must not pass");
    await assert.rejects(readFile(aptMarker), { code: "ENOENT" });
    await rm(join(directory, "pg_restore"));
    assert.notEqual(run().status, 0, "missing tools try installation and fail closed when installation fails");
    assert.equal(await readFile(aptMarker, "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
