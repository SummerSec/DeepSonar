import type { MigrationConnection } from "./migration-runner.js";

type Grant = { grantee: string | null; privilege: string; grantable: boolean };
type ObjectAcl = { kind: string; target: string; column: string | null; grants: Grant[] };
type DefaultAcl = { owner: string; kind: string; grants: Grant[] };
export type PublicAclSnapshot = { objects: ObjectAcl[]; defaults: DefaultAcl[] };

const DEFAULT_KINDS: Record<string, string> = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES" };
const PRIVILEGES = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN", "USAGE", "CREATE", "EXECUTE"]);
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const role = (name: string | null): string => name === null ? "PUBLIC" : quote(name);
const key = (object: ObjectAcl): string => JSON.stringify([object.kind, object.target, object.column]);

async function readObjects(db: MigrationConnection): Promise<ObjectAcl[]> {
  return db<ObjectAcl>`
    WITH objects AS (
      SELECT 'SCHEMA' AS kind, format('%I', n.nspname) AS target, NULL::text AS "column",
        COALESCE(n.nspacl, acldefault('n', n.nspowner)) AS acl
      FROM pg_namespace n WHERE n.nspname = 'public'
      UNION ALL
      SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
        format('%I.%I', n.nspname, c.relname), NULL,
        COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      UNION ALL
      SELECT CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
        format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), NULL,
        COALESCE(p.proacl, acldefault('f', p.proowner))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'TYPE', format('%I.%I', n.nspname, t.typname), NULL,
        COALESCE(t.typacl, acldefault('T', t.typowner))
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0
      UNION ALL
      SELECT 'TABLE', format('%I.%I', n.nspname, c.relname), a.attname, a.attacl
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    )
    SELECT kind, target, "column", COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'grantee', r.rolname, 'privilege', x.privilege_type, 'grantable', x.is_grantable))
      FROM aclexplode(acl) x LEFT JOIN pg_roles r ON r.oid = x.grantee), '[]'::jsonb) AS grants
    FROM objects ORDER BY kind, target, "column" NULLS FIRST
  `;
}

export async function capturePublicAcl(db: MigrationConnection): Promise<PublicAclSnapshot> {
  const objects = await readObjects(db);
  const defaults = await db<DefaultAcl>`
    SELECT r.rolname AS owner, d.defaclobjtype::text AS kind,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee', grantee.rolname,
        'privilege', x.privilege_type, 'grantable', x.is_grantable))
        FROM aclexplode(d.defaclacl) x LEFT JOIN pg_roles grantee ON grantee.oid = x.grantee), '[]'::jsonb) AS grants
    FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole
    JOIN pg_namespace n ON n.oid = d.defaclnamespace WHERE n.nspname = 'public'
    ORDER BY r.rolname, d.defaclobjtype
  `;
  // Validate before moving any source table. Never interpolate an unknown privilege/kind.
  for (const object of [...objects, ...defaults]) {
    for (const grant of object.grants) {
      if (!PRIVILEGES.has(grant.privilege)) throw new Error("schema_rebuild_acl_privilege_unsupported");
    }
  }
  for (const entry of defaults) {
    if (!DEFAULT_KINDS[entry.kind]) throw new Error("schema_rebuild_default_acl_kind_unsupported");
  }
  return { objects, defaults };
}

async function grantAcl(db: MigrationConnection, prefix: string, on: string, grants: Grant[], column = ""): Promise<void> {
  const groups = new Map<string, { grantee: string | null; grantable: boolean; privileges: string[] }>();
  for (const grant of grants) {
    const groupKey = JSON.stringify([grant.grantee, grant.grantable]);
    let group = groups.get(groupKey);
    if (!group) {
      group = { grantee: grant.grantee, grantable: grant.grantable, privileges: [] };
      groups.set(groupKey, group);
    }
    group.privileges.push(`${grant.privilege}${column}`);
  }
  for (const group of groups.values()) {
    await db.unsafe(`${prefix}GRANT ${group.privileges.join(", ")}${on} TO ${role(group.grantee)}${group.grantable ? " WITH GRANT OPTION" : ""}`);
  }
}

async function replaceObjectAcl(db: MigrationConnection, source: ObjectAcl, current: ObjectAcl): Promise<void> {
  const column = source.column === null ? "" : ` (${quote(source.column)})`;
  const on = ` ON ${source.kind} ${source.target}`;
  for (const grantee of new Set(current.grants.map((grant) => grant.grantee))) {
    await db.unsafe(`REVOKE ALL${column}${on} FROM ${role(grantee)} CASCADE`);
  }
  await grantAcl(db, "", on, source.grants, column);
}

export async function restorePublicSchemaAcl(db: MigrationConnection, snapshot: PublicAclSnapshot): Promise<void> {
  const [current] = (await readObjects(db)).filter((object) => object.kind === "SCHEMA");
  const source = snapshot.objects.find((object) => object.kind === "SCHEMA");
  if (source && current) await replaceObjectAcl(db, source, current);
  for (const entry of snapshot.defaults) {
    const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(entry.owner)} IN SCHEMA public `;
    // Schema-local defaults are additive to unchanged database-wide defaults.
    await grantAcl(db, prefix, ` ON ${DEFAULT_KINDS[entry.kind]}`, entry.grants);
  }
}

export async function restorePublicObjectAcl(db: MigrationConnection, snapshot: PublicAclSnapshot): Promise<void> {
  const current = new Map((await readObjects(db)).map((object) => [key(object), object]));
  for (const object of snapshot.objects) {
    if (object.kind === "SCHEMA") continue;
    const target = current.get(key(object));
    // Removed contracts get no synthetic replacement grants. New objects use restored defaults.
    if (target) await replaceObjectAcl(db, object, target);
    else if (object.column !== null && current.has(key({ ...object, column: null }))) {
      // A recreated column has no ACL row yet; only restore it if the column still exists.
      const [column] = await db<{ exists: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${object.target})
          AND attname = ${object.column} AND attnum > 0 AND NOT attisdropped) AS exists`;
      if (column?.exists) await replaceObjectAcl(db, object, { ...object, grants: [] });
    }
  }
}
