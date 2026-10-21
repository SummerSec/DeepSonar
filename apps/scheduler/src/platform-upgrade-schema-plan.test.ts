import {test} from "node:test";
import assert from "node:assert/strict";
import {readUpgradePlan, isCandidateDatabase} from "./platform-upgrade-schema-plan.js";
import {runUpgradeSchema} from "./platform-upgrade-schema-runner.js";
import type {MigrationConnection} from "./migration-runner.js";
import {SCHEMA_VERSION} from "./schema-version.js";

function fixture({count = 1, effects = 0, active = false, paused = true, type = "text"} = {}) {
  const queries: string[] = [];
  const db = Object.assign(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?"); queries.push(sql);
    if (sql.includes("current_database()")) return [{name: "ds_upgrade_" + "a".repeat(32)}];
    if (sql.includes("count(*)") && sql.includes("information_schema.tables")) return [{count: 1}];
    if (sql.includes("table_type = 'BASE TABLE'")) return [{table_name: "projects"}];
    if (sql.includes("is_identity")) return [{table_name: "projects", column_name: "id", is_identity: "NO"}];
    if (sql.includes("SELECT version")) return [{version: SCHEMA_VERSION - 1}];
    if (sql.includes("SELECT id::text")) return active ? [{id: "redacted", status: "running", type: "job"}] : [];
    if (sql.includes("data_type")) return [{table_name: "projects", column_name: "id", data_type: type}];
    if (sql.includes("job_attempt_effects")) return [{count: effects}];
    if (sql.includes("claims_paused")) return [{paused}];
    return [];
  }, {unsafe: async (sql: string) => {queries.push(sql); return sql.startsWith("SELECT count") ? [{count}] : [];}}) as unknown as MigrationConnection;
  return {db, queries};
}
test("plan opens read-only snapshot and hashes structure, not row counts", async () => {
  const first = fixture(); const a = await readUpgradePlan(first.db);
  const b = await readUpgradePlan(fixture({count: 99}).db);
  assert.equal(a.plan_hash, b.plan_hash);
  assert.notEqual(a.plan_hash, (await readUpgradePlan(fixture({type: "uuid"}).db)).plan_hash);
  assert.match(first.queries[0], /READ ONLY$/);
  assert.equal(first.queries.at(-1), "ROLLBACK");
  assert.equal(first.queries.some(sql => /CREATE|INSERT|UPDATE|DELETE|ALTER/.test(sql)), false);
  assert.equal(a.target_schema_version, SCHEMA_VERSION);
});
test("active work, external effects and lost pause block apply regardless of approved hash", async () => {
  for (const config of [{effects: 1}, {active: true}, {paused: false}]) {
    const {db, queries} = fixture(config);
    const plan = await readUpgradePlan(db);
    const result = await runUpgradeSchema(db, {action: "apply", candidate_database: "ds_upgrade_" + "a".repeat(32), expected_plan_hash: plan.plan_hash, verified_backup_sha256: "b".repeat(64)});
    assert.equal(result.ok, false);
    assert.equal(queries.some(sql => /DROP|CREATE|ALTER/.test(sql)), false);
  }
});
test("candidate identity and explicit plan approval are mandatory", async () => {
  assert.equal(isCandidateDatabase("deepsonar"), false);
  assert.equal(isCandidateDatabase("ds_upgrade_../source"), false);
  const {db, queries} = fixture();
  await assert.rejects(runUpgradeSchema(db, {action: "apply", candidate_database: "deepsonar"}), /INVALID_CANDIDATE/);
  assert.equal(queries.length, 0);
  await assert.rejects(runUpgradeSchema(db, {action: "apply", candidate_database: "ds_upgrade_" + "a".repeat(32), verified_backup_sha256: "b".repeat(64), expected_plan_hash: "c".repeat(64)}), /PLAN_MISMATCH/);
  assert.equal(queries.some(sql => /DROP|CREATE|ALTER/.test(sql)), false);
});
test("role identity reset is explicit, hash-bound and unavailable until target implementation exists", async () => {
  const normal = await readUpgradePlan(fixture().db);
  const reset = await readUpgradePlan(fixture().db, {reset_role_identity: true});
  assert.notEqual(normal.plan_hash, reset.plan_hash);
  assert.ok(reset.risks.some(risk => risk.code === 'RESET_ROLE_IDENTITY'));
  assert.ok(reset.blocking_errors.some(error => error.code === 'RESET_ROLE_IDENTITY_NOT_AVAILABLE'));
});
