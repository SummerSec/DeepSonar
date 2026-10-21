import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { planSchemaRebuild } from "./schema-rebuild.js";
import { SCHEMA_VERSION } from "./schema-version.js";

export const schemaDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const isCandidateDatabase = (name: unknown): name is string => typeof name === "string" && /^ds_upgrade_[a-f0-9]{24,40}$/.test(name);
export type SchemaRisk = {code: string; table?: string; column?: string};

// No SQL writes, including temporary objects, are permitted during planning.
export async function readUpgradePlan(db: MigrationConnection, {reset_role_identity = false, source_schema_sha256}: {reset_role_identity?: boolean; source_schema_sha256?: string} = {}) {
  await db.unsafe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const plan = await planSchemaRebuild(db);
    const columns = await db`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`;
    const constraints = await db`SELECT c.relname AS table_name,k.conname,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,k.conname`;
    const effects = await db<{ count: number }>`SELECT count(*)::int AS count FROM job_attempt_effects WHERE status IN ('effect_pending','unknown')`;
    const paused = await db<{ paused: boolean }>`SELECT claims_paused AS paused FROM global_settings WHERE id='global'`;
    const roleTable = plan.tables.find(table => table.table === "role_configs" && table.action === "copy");
    const oldRoleIdentity = plan.currentVersion === null || plan.currentVersion < 60;
    const roleStructureUnknown = Boolean(roleTable && !["agent_cli", "model", "project_id"].every(column => roleTable.copied.includes(column)));
    let identityRequiresReset = false;
    if (roleTable && !roleStructureUnknown) {
      const identities = await db<{legacy_cli: number; project_model: number}>`SELECT
        count(*) FILTER (WHERE agent_cli IS NOT NULL)::int AS legacy_cli,
        count(*) FILTER (WHERE project_id IS NOT NULL AND model IS NOT NULL)::int AS project_model FROM role_configs`;
      identityRequiresReset = (oldRoleIdentity && Number(identities[0]?.legacy_cli ?? 0) > 0) || Number(identities[0]?.project_model ?? 0) > 0;
    }
    const risks: SchemaRisk[] = [];
    if (reset_role_identity) risks.push({code: "RESET_ROLE_IDENTITY"});
    for (const table of plan.droppedTables) risks.push({code: "DROPPED_TABLE", table});
    for (const entry of plan.tables) for (const column of entry.dropped) risks.push({code: "DROPPED_COLUMN", table: entry.table, column});
    if (!plan.alreadyCurrent) risks.push({code: "TYPE_CONSTRAINT_REVALIDATION_REQUIRED"}, {code: "BUILTIN_SEED_REPLACEMENT"});
    const targetSqlHash = createHash("sha256").update(readFileSync(SCHEMA_FILE)).digest("hex");
    const metadata = await db<{marker: string | null}>`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
    let rebuiltProof = false;
    try { const marker = JSON.parse(metadata[0]?.marker ?? "null"); rebuiltProof = marker?.phase === "rebuilt" && marker?.target_sql_sha256 === targetSqlHash; } catch { /* No trusted rebuild receipt. */ }
    const baselineProof = rebuiltProof || source_schema_sha256 === targetSqlHash;
    const structureAlias = plan.alreadyCurrent && (!baselineProof || plan.droppedTables.length > 0 || plan.newTables.length > 0 || plan.tables.some(table => table.action !== "skip" && (table.dropped.length > 0 || table.added.length > 0)));
    const blockers = [
      ...(structureAlias ? ["STRUCTURE_VERSION_ALIAS"] : []),
      ...(roleStructureUnknown ? ["ROLE_CONFIG_IDENTITY_STRUCTURE_UNSUPPORTED"] : []),
      ...(identityRequiresReset && !reset_role_identity ? ["ROLE_CONFIG_IDENTITY_REVIEW_REQUIRED"] : []),
      ...(identityRequiresReset && reset_role_identity && plan.alreadyCurrent ? ["ROLE_CONFIG_IDENTITY_RESET_REQUIRES_REBUILD"] : []),
      ...(plan.unknownStructure ? ["UNKNOWN_SOURCE_STRUCTURE"] : []),
      ...(plan.activeJobs.length ? ["ACTIVE_SOURCE_JOBS"] : []),
      ...(Number(effects[0]?.count) !== 0 ? ["UNSETTLED_SOURCE_EFFECTS"] : []),
    ];
    // Counts and active state are separately revalidated; neither destabilizes the approved structural plan.
    const structure = {source_version: plan.currentVersion, target_version: SCHEMA_VERSION,
      reset_role_identity, source_schema_sha256: source_schema_sha256 ?? null, target_sql_sha256: targetSqlHash, columns, constraints,
      dropped_tables: plan.droppedTables, tables: plan.tables.map(({sourceRows: _rows, action: _action, ...table}) => table), risks};
    return {schema: "deepsonar.schema-upgrade-plan/v1", plan_hash: schemaDigest(structure),
      source_schema_version: plan.currentVersion, target_schema_version: SCHEMA_VERSION,
      target_sql_sha256: structure.target_sql_sha256, source_structure_sha256: schemaDigest({columns, constraints}),
      reset_role_identity, role_identity_reset_required: identityRequiresReset, risks, claims_paused: paused[0]?.paused === true, blocking_errors: blockers.map(code => ({code})),
      row_counts: plan.tables.map(table => ({table: table.table, count: table.sourceRows})),
      not_checked: ["precise_type_constraint_diff", "historical_snapshot_semantics"]};
  } finally { await db.unsafe("ROLLBACK"); }
}
