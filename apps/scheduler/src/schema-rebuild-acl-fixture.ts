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
  const privateSchema = `acl_private_${suffix}`;
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const targetUrl = new URL(testUrl);
  targetUrl.pathname = `/${database}`;
  const db = postgres(targetUrl.toString(), { max: 1 });
  const readerDb = postgres(targetUrl.toString(), { max: 1, prepare: false });
  const project = randomUUID();
  let observedCopies = 0;
  let unpublishedChecks = 0;
  let publishedChecks = 0;
  const attemptTrigger = async (unpublished: boolean): Promise<void> => {
    await assert.rejects(readerDb.unsafe(`CREATE TRIGGER acl_private_capture AFTER UPDATE ON public.projects
      FOR EACH ROW EXECUTE FUNCTION ${quote(privateSchema)}.capture_private()`), (error: unknown) => {
      if (typeof error !== "object" || error === null || !("code" in error)) return false;
      return (unpublished ? ["42P01", "42501", "57014"] : ["42501"]).includes(String(error.code));
    });
  };
  const checkNoTriggerOrLeak = async (ownerConnection: MigrationConnection): Promise<void> => {
    const [triggers] = await ownerConnection<{ count: number }>`SELECT count(*)::int AS count
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND t.tgname='acl_private_capture'`;
    assert.equal(triggers?.count, 0);
    const [leaks] = await readerDb.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM ${quote(privateSchema)}.leaks`);
    assert.equal(leaks?.count, 0);
  };
  const checkReader = async (): Promise<void> => {
    const rows = await readerDb<{ name: string }[]>`SELECT name FROM public.projects`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, "acl-column-only");
    await assert.rejects(readerDb`SELECT config_json FROM public.projects`, { code: "42501" });
  };
  const reserveWithCopyCheck = async (failAfterCopy: boolean, failBeforeCommit = false) => {
    const session = await db.reserve();
    return new Proxy(session, {
      get(target, property, receiver) {
        if (property !== "unsafe") return Reflect.get(target, property, receiver);
        return async (query: string) => {
          if (query === "COMMIT" && failBeforeCommit) throw new Error("acl_rebuild_injected_publication_failure");
          const result = await target.unsafe(query);
          if (query.includes("CREATE TABLE schema_meta")) {
            // Probe the former baseline-COMMIT window using an independent role.
            await attemptTrigger(true);
            unpublishedChecks += 1;
          }
          if (query === "COMMIT") {
            await attemptTrigger(false);
            await checkNoTriggerOrLeak(target as unknown as MigrationConnection);
            publishedChecks += 1;
          }
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
    await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(owner.name)} IN SCHEMA public GRANT SELECT, TRIGGER ON TABLES TO ${quote(reader)}`);
    await db`INSERT INTO projects (id, name, config_json) VALUES (${project}, 'acl-column-only', '{"private":"acl-old-private-sentinel"}'::jsonb)`;
    await db.unsafe(`CREATE SCHEMA ${quote(privateSchema)} AUTHORIZATION ${quote(reader)}`);
    await readerDb.unsafe(`SET ROLE ${quote(reader)}`);
    await readerDb.unsafe("SET statement_timeout = '1s'");
    await readerDb.unsafe(`CREATE TABLE ${quote(privateSchema)}.leaks (payload jsonb)`);
    await readerDb.unsafe(`CREATE FUNCTION ${quote(privateSchema)}.capture_private() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN INSERT INTO ${quote(privateSchema)}.leaks VALUES (NEW.config_json); RETURN NEW; END $$`);
    const [permissions] = await db<{ trigger: boolean; execute: boolean }[]>`SELECT
      has_table_privilege(${reader}, 'public.projects', 'TRIGGER') AS trigger,
      has_function_privilege(${reader}, ${`${quote(privateSchema)}.capture_private()`}, 'EXECUTE') AS execute`;
    assert.deepEqual(permissions, { trigger: false, execute: true });
    await attemptTrigger(false);
    await checkReader();
    const before = await capturePublicAcl(connection);
    const beforeRoles = await db`SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname IN (${runtime}, ${reader}) ORDER BY rolname`;
    const schemaFile = path.join(temporary, "schema.sql");
    const baseline = await readFile(SCHEMA_FILE, "utf8");
    await writeFile(schemaFile, baseline.replace(/COMMIT;\s*$/, () => `
CREATE TABLE deepsonar_acl_future (id bigserial PRIMARY KEY, value text);
CREATE FUNCTION deepsonar_acl_future_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
COMMIT;
`));
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
    assert.equal(unpublishedChecks, 1);
    assert.equal(publishedChecks, 1);
    await db`UPDATE projects SET config_json=config_json WHERE id=${project}`;
    await checkNoTriggerOrLeak(connection);
    const [futureTrigger] = await db<{ allowed: boolean }[]>`SELECT
      has_table_privilege(${reader}, 'public.deepsonar_acl_future', 'TRIGGER') AS allowed`;
    assert.equal(futureTrigger?.allowed, true);
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
    assert.equal(unpublishedChecks, 2);
    assert.equal(publishedChecks, 2);
    await checkReader();
    await db`UPDATE projects SET config_json=config_json WHERE id=${project}`;
    await checkNoTriggerOrLeak(connection);
    // A failure before publication rolls back all newly created public objects.
    await assert.rejects(rebuildSchemaOnReservedSession(
      () => reserveWithCopyCheck(false, true),
      { mode: "apply", force: true, schemaFile, dump: false, terminateScheduler: false },
    ), { message: "acl_rebuild_injected_publication_failure" });
    assert.equal(unpublishedChecks, 3);
    assert.equal(publishedChecks, 2);
    assert.equal(observedCopies, 2);
    const [rolledBack] = await db<{ projects: string | null }[]>`SELECT to_regclass('public.projects')::text AS projects`;
    assert.equal(rolledBack?.projects, null);
    await checkNoTriggerOrLeak(connection);
  } finally {
    await readerDb.end();
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(database)}`);
    for (const name of [runtime, reader]) await admin.unsafe(`DROP ROLE IF EXISTS ${quote(name)}`);
    await admin.end();
    await rm(temporary, { recursive: true, force: true });
  }
}
