import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { runMigrations, SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { capturePublicAcl, type PublicAclSnapshot } from "./schema-rebuild-acl.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
function normalize(snapshot: PublicAclSnapshot): Map<string, string> {
  return new Map(snapshot.objects.map((object) => [JSON.stringify([object.kind, object.target, object.column]),
    JSON.stringify(object.grants.map((grant) => JSON.stringify(grant)).sort())]));
}

export async function runRebuildAclFixture(testUrl: string): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const database = `acl_rebuild_${suffix}`;
  const runtime = `acl_runtime_${suffix}"scope`;
  const reader = `acl_reader_${suffix}`;
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const targetUrl = new URL(testUrl);
  targetUrl.pathname = `/${database}`;
  const db = postgres(targetUrl.toString(), { max: 1 });
  const readerDb = postgres(targetUrl.toString(), { max: 1, prepare: false });
  const project = randomUUID();
  let observedCopies = 0;
  const checkReader = async (): Promise<void> => {
    const rows = await readerDb<{ name: string }[]>`SELECT name FROM public.projects`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, "acl-column-only");
    await assert.rejects(readerDb`SELECT config_json FROM public.projects`, { code: "42501" });
  };
  const reserveWithCopyCheck = async (failAfterCopy: boolean) => {
    const session = await db.reserve();
    return new Proxy(session, {
      get(target, property, receiver) {
        if (property !== "unsafe") return Reflect.get(target, property, receiver);
        return async (query: string) => {
          const result = await target.unsafe(query);
          if (query.startsWith('INSERT INTO public."projects" ')) {
            const [copied] = await target`SELECT config_json FROM public.projects WHERE id=${project}`;
            assert.deepEqual(copied?.config_json, { private: "acl-old-private-sentinel" });
            // This connection is independent of the rebuild/advisory-lock session.
            await checkReader();
            observedCopies += 1;
            if (failAfterCopy) throw new Error("acl_rebuild_injected_copy_failure");
          }
          return result;
        };
      },
    }) as unknown as MigrationConnection & { release: () => void };
  };
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deepsonar-acl-rebuild-"));
  try {
    await admin.unsafe(`CREATE DATABASE ${quote(database)}`);
    for (const name of [runtime, reader]) await admin.unsafe(`CREATE ROLE ${quote(name)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const connection = db as unknown as MigrationConnection;
    await runMigrations(connection);
    const [owner] = await db<{ name: string }[]>`SELECT current_user AS name`;
    assert.ok(owner);
    await db.unsafe("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await db.unsafe(`GRANT USAGE ON SCHEMA public TO ${quote(runtime)}, ${quote(reader)}`);
    await db.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${quote(runtime)}`);
    await db.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${quote(runtime)}`);
    await db.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${quote(runtime)}`);
    await db.unsafe(`GRANT SELECT ON TABLE public.projects TO ${quote(runtime)} WITH GRANT OPTION`);
    await db.unsafe(`GRANT SELECT (name) ON TABLE public.projects TO ${quote(reader)} WITH GRANT OPTION`);
    await db.unsafe("REVOKE EXECUTE ON FUNCTION public.deepsonar_identity_manifest_fields_valid(jsonb) FROM PUBLIC");
    for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
      await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(owner.name)} IN SCHEMA public GRANT ALL ON ${kind} TO ${quote(runtime)}`);
    }
    // Defaults grant whole-table SELECT to future tables, but the source
    // projects table intentionally exposes only its name column.
    await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(owner.name)} IN SCHEMA public GRANT SELECT ON TABLES TO ${quote(reader)}`);
    await db`INSERT INTO projects (id, name, config_json) VALUES (${project}, 'acl-column-only', '{"private":"acl-old-private-sentinel"}'::jsonb)`;
    await readerDb.unsafe(`SET ROLE ${quote(reader)}`);
    await checkReader();
    const before = await capturePublicAcl(connection);
    const beforeRoles = await db`SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname IN (${runtime}, ${reader}) ORDER BY rolname`;
    const schemaFile = path.join(temporary, "schema.sql");
    await writeFile(schemaFile, `${await readFile(SCHEMA_FILE, "utf8")}\nCREATE TABLE deepsonar_acl_future (id bigserial PRIMARY KEY, value text);\nCREATE FUNCTION deepsonar_acl_future_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;\n`);
    const plan = await rebuildSchemaOnReservedSession(
      () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void }>,
      { mode: "plan", force: true, schemaFile, dump: false, terminateScheduler: false },
    );
    assert.equal(plan.applied, false);
    assert.deepEqual(normalize(await capturePublicAcl(connection)), normalize(before));
    const result = await rebuildSchemaOnReservedSession(
      () => reserveWithCopyCheck(false),
      { mode: "apply", force: true, schemaFile, dump: false, terminateScheduler: false },
    );
    assert.equal(result.applied, true);
    assert.equal(observedCopies, 1);
    const after = await capturePublicAcl(connection);
    const grants = normalize(after);
    for (const [object, acl] of normalize(before)) assert.equal(grants.get(object), acl, object);
    const defaultAcl = (snapshot: PublicAclSnapshot) => snapshot.defaults.map((entry) => JSON.stringify({
      owner: entry.owner, kind: entry.kind, grants: entry.grants.map((grant) => JSON.stringify(grant)).sort(),
    })).sort();
    assert.deepEqual(defaultAcl(after), defaultAcl(before));
    assert.deepEqual(await db`SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname IN (${runtime}, ${reader}) ORDER BY rolname`, beforeRoles);
    await db.unsafe(`SET ROLE ${quote(runtime)}`);
    try {
      await db`INSERT INTO audit_logs (actor_type, actor_id, action, result) VALUES ('system', 'acl-runtime-fixture', 'acl.runtime', 'ok')`;
      const [future] = await db<{ id: string | number }[]>`INSERT INTO deepsonar_acl_future (value) VALUES ('allowed-by-defaults') RETURNING id`;
      assert.equal(Number(future?.id), 1);
      await db`SELECT deepsonar_acl_future_fn()`;
      await db`UPDATE deepsonar_acl_future SET value = 'retained' WHERE id = 1`;
      await assert.rejects(db.unsafe("CREATE TABLE public.acl_forbidden (id int)"), { code: "42501" });
    } finally {
      await db.unsafe("RESET ROLE");
    }
    await db.unsafe(`SET ROLE ${quote(reader)}`);
    try {
      await db`SELECT name FROM public.projects`;
      await assert.rejects(db`SELECT config_json FROM public.projects`, { code: "42501" });
      await assert.rejects(db`SELECT nextval('public.audit_logs_id_seq')`, { code: "42501" });
      await assert.rejects(db`SELECT deepsonar_identity_manifest_fields_valid('{}'::jsonb)`, { code: "42501" });
      await assert.rejects(db`INSERT INTO deepsonar_acl_future (value) VALUES ('forbidden')`, { code: "42501" });
    } finally {
      await db.unsafe("RESET ROLE");
    }
    const [options] = await db<{ runtime_grant: boolean; reader_grant: boolean; public_create: boolean }[]>`
      SELECT has_table_privilege(${runtime}, 'public.projects', 'SELECT WITH GRANT OPTION') AS runtime_grant,
        has_column_privilege(${reader}, 'public.projects', 'name', 'SELECT WITH GRANT OPTION') AS reader_grant,
        EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) x
          WHERE n.nspname = 'public' AND x.grantee = 0 AND x.privilege_type = 'CREATE') AS public_create`;
    assert.deepEqual(options, { runtime_grant: true, reader_grant: true, public_create: false });
    // An error after the committed historical copy must not leave defaults
    // exposing the private column while the final ACL pass is never reached.
    await assert.rejects(rebuildSchemaOnReservedSession(
      () => reserveWithCopyCheck(true),
      { mode: "apply", force: true, schemaFile, dump: false, terminateScheduler: false },
    ), { message: "acl_rebuild_injected_copy_failure" });
    assert.equal(observedCopies, 2);
    await checkReader();
  } finally {
    await readerDb.end();
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(database)}`);
    for (const name of [runtime, reader]) await admin.unsafe(`DROP ROLE IF EXISTS ${quote(name)}`);
    await admin.end();
    await rm(temporary, { recursive: true, force: true });
  }
}
