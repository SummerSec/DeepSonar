import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes, randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {SCHEMA_FILE, type MigrationConnection} from "./migration-runner.js";
import {SCHEMA_VERSION} from "./schema-version.js";
import {runUpgradeSchema} from "./platform-upgrade-schema-runner.js";

const url = process.env.UPGRADE_SCHEMA_TEST_DATABASE_URL;
// Requires a dedicated isolated PostgreSQL admin. It never edits the URL's DB.
// The previous-version fixture deliberately tests DDL divergence; it does not
// claim to be an actual historical release image or backup-transport rehearsal.
test("real candidate rebuild preserves source and frozen records, checks approved structural plan", {skip: !url, timeout: 120_000}, async () => {
  const suffix = randomBytes(16).toString("hex");
  const sourceName = `ds_schema_test_${suffix}`;
  const candidateName = `ds_upgrade_${suffix}`;
  const admin = postgres(url!, {max: 1, onnotice: () => {}});
  const connect = (database: string) => {const parsed = new URL(url!); parsed.pathname = '/' + database; return postgres(parsed.toString(), {max: 1, onnotice: () => {}});};
  let source: ReturnType<typeof postgres> | undefined;
  let candidate: ReturnType<typeof postgres> | undefined;
  const sourceCreated = {value: false}; const candidateCreated = {value: false};
  try {
    await admin.unsafe(`CREATE DATABASE "${sourceName}" TEMPLATE template0`); sourceCreated.value = true;
    source = connect(sourceName);
    await source.unsafe(readFileSync(SCHEMA_FILE, "utf8"));
    await source`UPDATE schema_meta SET version=${SCHEMA_VERSION - 1} WHERE id='global'`;
    await source`UPDATE global_settings SET claims_paused=true,claims_pause_reason='platform_upgrade',claims_paused_by='isolated-upgrade-test',claims_paused_at=now() WHERE id='global'`;
    await source.unsafe("CREATE TABLE upgrade_removed_fixture (id int PRIMARY KEY); INSERT INTO upgrade_removed_fixture VALUES (7); ALTER TABLE projects ADD COLUMN upgrade_removed_column text");
    const marker = randomUUID();
    await source`INSERT INTO projects(id,name,upgrade_removed_column) VALUES (${marker},'upgrade marker','preserve in source')`;
    const sourceSession = await source.reserve();
    let sourcePlanHash: string;
    try {
      const sourcePlan = await runUpgradeSchema(sourceSession as unknown as MigrationConnection, {action: "plan", source_database: sourceName, candidate_database: candidateName});
      assert.equal(sourcePlan.ok, true);
      sourcePlanHash = sourcePlan.plan.plan_hash;
    } finally { sourceSession.release(); }
    await source.end(); source = undefined;
    await admin.unsafe(`CREATE DATABASE "${candidateName}" TEMPLATE "${sourceName}"`); candidateCreated.value = true;
    candidate = connect(candidateName);
    const reserved = await candidate.reserve();
    try {
      const db = reserved as unknown as MigrationConnection;
      const preview = await runUpgradeSchema(db, {action: "plan", candidate_database: candidateName});
      assert.equal(preview.ok, true);
      assert.equal(preview.plan.plan_hash, sourcePlanHash);
      assert.ok(preview.plan.risks.some(risk => risk.code === 'DROPPED_TABLE' && risk.table === 'upgrade_removed_fixture'));
      assert.ok(preview.plan.risks.some(risk => risk.code === 'DROPPED_COLUMN' && risk.column === 'upgrade_removed_column'));
      await assert.rejects(runUpgradeSchema(db, {action: "apply", candidate_database: candidateName, expected_plan_hash: '0'.repeat(64), verified_backup_sha256: 'b'.repeat(64)}), /PLAN_MISMATCH/);
      const applied = await runUpgradeSchema(db, {action: "apply", candidate_database: candidateName, expected_plan_hash: preview.plan.plan_hash, verified_backup_sha256: 'b'.repeat(64)});
      assert.equal(applied.ok, true);
      const noProof = await runUpgradeSchema(db, {action: "plan", candidate_database: candidateName});
      assert.ok(noProof.plan.blocking_errors.some(error => error.code === 'STRUCTURE_VERSION_ALIAS'));
      const proved = await runUpgradeSchema(db, {action: "plan", candidate_database: candidateName, source_schema_sha256: preview.plan.target_sql_sha256});
      assert.equal(proved.ok, true);
    } finally { reserved.release(); }
    assert.equal((await candidate`SELECT version FROM schema_meta WHERE id='global'`)[0].version, SCHEMA_VERSION);
    assert.equal((await candidate`SELECT claims_paused FROM global_settings WHERE id='global'`)[0].claims_paused, true);
    assert.equal((await candidate`SELECT count(*)::int AS n FROM projects WHERE id=${marker}`)[0].n, 1);
    source = connect(sourceName);
    assert.equal((await source`SELECT version FROM schema_meta WHERE id='global'`)[0].version, SCHEMA_VERSION - 1);
    assert.equal((await source`SELECT upgrade_removed_column FROM projects WHERE id=${marker}`)[0].upgrade_removed_column, 'preserve in source');
    assert.equal((await source`SELECT id FROM upgrade_removed_fixture`)[0].id, 7);
  } finally {
    await source?.end({timeout: 5}); await candidate?.end({timeout: 5});
    // Cleanup is test-owned, never part of the product candidate manager.
    if (candidateCreated.value) await admin.unsafe(`DROP DATABASE "${candidateName}"`);
    if (sourceCreated.value) await admin.unsafe(`DROP DATABASE "${sourceName}"`);
    await admin.end({timeout: 5});
  }
});
