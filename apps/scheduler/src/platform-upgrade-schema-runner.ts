import { MIGRATE_LOCK_ID, type MigrationConnection } from "./migration-runner.js";
import { rebuildSchemaToLatest } from "./schema-rebuild.js";
import { isCandidateDatabase, readUpgradePlan } from "./platform-upgrade-schema-plan.js";

export type UpgradeSchemaRequest = {
  action: "plan" | "apply";
  candidate_database: string;
  source_database?: string;
  reset_role_identity?: boolean;
  source_schema_sha256?: string;
  expected_plan_hash?: string;
  verified_backup_sha256?: string;
};

export async function runUpgradeSchema(db: MigrationConnection, input: UpgradeSchemaRequest) {
  const database = input.action === "plan" ? (input.source_database ?? input.candidate_database) : input.candidate_database;
  if (!["plan", "apply"].includes(input.action) || typeof database !== "string" || !database || (input.action === "apply" && !isCandidateDatabase(database))) throw new Error("INVALID_CANDIDATE_REQUEST");
  const identity = await db<{ name: string }>`SELECT current_database() AS name`;
  if (identity[0]?.name !== database) throw new Error("CANDIDATE_IDENTITY_MISMATCH");
  await db.unsafe(`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`);
  try {
    if (input.reset_role_identity !== undefined && typeof input.reset_role_identity !== "boolean") throw new Error("INVALID_RESET_OPTION");
    if (input.source_schema_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.source_schema_sha256)) throw new Error("INVALID_SOURCE_SCHEMA_HASH");
    const plan = await readUpgradePlan(db, {reset_role_identity: input.reset_role_identity, source_schema_sha256: input.source_schema_sha256});
    if (input.action === "plan") return {ok: plan.blocking_errors.length === 0, plan, applied: false};
    if (!/^[a-f0-9]{64}$/.test(input.verified_backup_sha256 ?? "")) throw new Error("VERIFIED_BACKUP_REQUIRED");
    if (input.expected_plan_hash !== plan.plan_hash) throw new Error("APPROVED_PLAN_MISMATCH");
    if (!plan.claims_paused) plan.blocking_errors.push({code: "SOURCE_CLAIMS_NOT_PAUSED"});
    if (plan.blocking_errors.length) return {ok: false, plan, applied: false};
    const result = await rebuildSchemaToLatest(db, {mode: "apply", dump: false, terminateScheduler: false, keepStaging: true, resetRoleIdentity: input.reset_role_identity === true});
    // Re-enable triggers explicitly: rebuild suppresses them while copying.
    // NOT VALID + VALIDATE forces a check even for catalog-marked-valid FKs.
    const foreignKeys = await db<{ table_name: string; constraint_name: string; definition: string }>`
      SELECT c.relname AS table_name,k.conname AS constraint_name,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND k.contype='f' ORDER BY c.relname,k.conname`;
    const ident = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    for (const key of foreignKeys) {
      await db.unsafe(`ALTER TABLE public.${ident(key.table_name)} DROP CONSTRAINT ${ident(key.constraint_name)}, ADD CONSTRAINT ${ident(key.constraint_name)} ${key.definition.replace(/ NOT VALID$/, "")} NOT VALID`);
      await db.unsafe(`ALTER TABLE public.${ident(key.table_name)} VALIDATE CONSTRAINT ${ident(key.constraint_name)}`);
    }
    const paused = await db<{ paused: boolean }>`SELECT claims_paused AS paused FROM global_settings WHERE id='global'`;
    if (paused[0]?.paused !== true) throw new Error("CANDIDATE_PAUSE_LOST");
    return {ok: true, plan, applied: result.applied, copied_tables: result.copiedTables};
  } finally { await db.unsafe(`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`); }
}
