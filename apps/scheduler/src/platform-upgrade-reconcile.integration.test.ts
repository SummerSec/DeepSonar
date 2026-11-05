import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { readUpgradePlan } from "./platform-upgrade-schema-plan.js";
import { beginEffect, createAttempt, markAttemptInterrupted, settleEffect, type AttemptDatabase } from "./domains/job-attempt/application.js";
import { countUnsettledEffects, DEFAULT_RECONCILE_LIMIT, runEffectReconcile, settleEffectByOperator } from "./domains/job-attempt/reconcile-effects-runner.js";
import { RECONCILE_INPUT_SCHEMA, RECONCILE_RESULT_SCHEMA } from "./domains/job-attempt/reconcile-effects.js";
import type { EffectKind } from "./domains/job-attempt/model.js";

const url = process.env.UPGRADE_SCHEMA_TEST_DATABASE_URL;
test("operator settlement: real PostgreSQL, kernel ownership, CLI and upgrade gate", { timeout: 120_000 }, async (t) => {
  // This suite is wired into the Actions PG job; missing configuration is a failure,
  // never a green skip. Only a freshly created database is changed or removed.
  assert.ok(url, "UPGRADE_SCHEMA_TEST_DATABASE_URL is required");
  const name = `ds_settle_test_${randomBytes(12).toString("hex")}`;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const parsed = new URL(url); parsed.pathname = `/${name}`;
  const db = postgres(parsed.toString(), { max: 3, onnotice: () => {} });
  const contender = postgres(parsed.toString(), { max: 1, onnotice: () => {}, connection: { application_name: name, statement_timeout: 10000 } });
  const migration = db as unknown as MigrationConnection;
  const operator = (id: string, operation = "operator-899") => ({ effect_id: id, outcome: "applied_run_terminated" as const, evidence: "fixture operator inspected positive runner exit evidence", operation_id: operation });
  let created = false;
  let roleCreated = false;
  const countRole = `${name}_count`;
  const project = randomUUID();
  async function fixture(kind: EffectKind = "agent_run", status = "effect_pending", active = true) {
    const job = randomUUID();
    await db`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json) VALUES(${job},${project},'explore','failed','{}')`;
    const attempt = await db.begin(async (tx) => {
      const kernel = tx as unknown as AttemptDatabase;
      const row = await createAttempt(kernel, job);
      await beginEffect(kernel, String(row.id), { effectId: "fixture-effect", kind });
      return String(row.id);
    });
    if (!active) await db.begin(tx => markAttemptInterrupted(tx as unknown as AttemptDatabase, job, "fixture interrupted"));
    await db`UPDATE job_attempt_effects SET status=${status} WHERE attempt_id=${attempt}`;
    const [row] = await db`SELECT id FROM job_attempt_effects WHERE attempt_id=${attempt}`;
    return { id: String(row.id), attempt, job };
  }
  const effect = async (id: string) => ({ ...(await db`SELECT * FROM job_attempt_effects WHERE id=${id}`)[0] });
  const attemptRow = async (id: string) => ({ ...(await db`SELECT * FROM job_attempts WHERE id=${id}`)[0] });
  async function reset() { await db`DELETE FROM jobs WHERE project_id=${project}`; }
  const kernelSettle = (connection: AttemptDatabase, attempt: string) => settleEffect(connection, attempt, "fixture-effect", {
    status: "settled", outcome: { result: "kernel-observed-exit" }, evidenceRef: "fixture:kernel-evidence",
  });
  const connection = { host: parsed.hostname, port: Number(parsed.port || 5432), username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database: name };
  function cli(fields: Record<string, unknown>) {
    const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const entry = fileURLToPath(new URL("./platform-upgrade-reconcile-cli.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--import", loader, entry], {
      input: JSON.stringify({ schema: RECONCILE_INPUT_SCHEMA, action: "settle", connection, ...fields }), encoding: "utf8", timeout: 20000,
    });
    assert.equal(run.error, undefined);
    assert.equal(run.stderr, "");
    assert.ok(run.status === 0 || run.status === 1);
    const output = JSON.parse(run.stdout);
    assert.equal(output.schema, RECONCILE_RESULT_SCHEMA);
    assert.equal(output.ok, run.status === 0, "ok and exit status agree");
    assert.equal(run.stdout.includes("fixture-secret-never-echo"), false);
    assert.equal(run.stdout.includes('"password"'), false);
    return output;
  }
  try {
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    const bootstrap = await db.reserve();
    try { await bootstrap.unsafe(readFileSync(SCHEMA_FILE, "utf8")); } finally { bootstrap.release(); }
    await db`INSERT INTO projects(id,name) VALUES(${project},'operator settlement fixture')`;

    for (const kind of ["provision", "agent_run", "gateway_model_request"] as const) {
      for (const status of ["effect_pending", "unknown"]) await t.test(`active ${kind}/${status}: no mutation, pending remains kernel-owned`, async () => {
        await reset();
        const f = await fixture(kind, status);
        const beforeEffect = await effect(f.id), beforeAttempt = await attemptRow(f.attempt);
        assert.equal((await settleEffectByOperator(migration, operator(f.id))).settled, false);
        assert.deepEqual(await effect(f.id), beforeEffect);
        assert.deepEqual(await attemptRow(f.attempt), beforeAttempt);
        const output = cli(operator(f.id));
        assert.equal(output.ok, false); assert.equal(output.applied, 0);
        assert.equal(output.settled, false); assert.equal(output.remaining_unknown, 1); assert.equal(output.backlog_clear, false);
        assert.deepEqual(await effect(f.id), beforeEffect);
        assert.deepEqual(await attemptRow(f.attempt), beforeAttempt);
        if (status === "effect_pending") {
          await db.begin(tx => kernelSettle(tx as unknown as AttemptDatabase, f.attempt));
          const after = await effect(f.id), state = await attemptRow(f.attempt);
          assert.equal(after.evidence_ref, "fixture:kernel-evidence");
          assert.deepEqual(after.settlement_json, { result: "kernel-observed-exit" });
          assert.equal(state.phase, kind === "provision" ? "provisioned" : kind === "agent_run" ? "settling" : beforeAttempt.phase);
          assert.equal(state.state_json.current_effect_id, null);
          assert.equal((await settleEffectByOperator(migration, operator(f.id))).settled, false);
          assert.deepEqual(await effect(f.id), after);
        }
      });
    }

    await t.test("interrupted unknown stays blocked until one audited attestation; repeat and late kernel preserve evidence", async () => {
      await reset();
      const f = await fixture("agent_run", "unknown", false);
      const before = await effect(f.id), state = await attemptRow(f.attempt);
      const maintenance = await db`SELECT * FROM platform_upgrade_state`;
      const settings = await db`SELECT * FROM global_settings`;
      const scan = await runEffectReconcile(migration, { action: "apply", operation_id: "auto-899" });
      assert.equal(scan.applied, 0); assert.equal(scan.ok, false);
      const reserved = await db.reserve();
      try {
        const plan = () => readUpgradePlan(reserved as unknown as MigrationConnection, { source_schema_sha256: createHash("sha256").update(readFileSync(SCHEMA_FILE)).digest("hex") });
        const blocked = await plan();
        assert.ok(blocked.blocking_errors.some(e => e.code === "UNSETTLED_SOURCE_EFFECTS"));
        const output = cli(operator(f.id));
        assert.equal(output.ok, true); assert.equal(output.remaining_unknown, 0); assert.equal(output.backlog_clear, true);
        const after = await effect(f.id);
        assert.equal(after.replay_policy, before.replay_policy);
        assert.equal(after.evidence_ref, "operator:operator-899");
        assert.deepEqual(after.settlement_json, { outcome: "applied_run_terminated", reconciled_by: "operator-settlement", reconcile_operation_id: "operator-899", operator_evidence: operator(f.id).evidence });
        assert.ok(after.settled_at);
        const clear = await plan();
        assert.equal(clear.blocking_errors.some(e => e.code === "UNSETTLED_SOURCE_EFFECTS"), false);
        assert.deepEqual(clear.blocking_errors, blocked.blocking_errors.filter(e => e.code !== "UNSETTLED_SOURCE_EFFECTS"));
        assert.equal(clear.plan_hash, blocked.plan_hash);
        assert.equal(clear.claims_paused, blocked.claims_paused);
        const duplicate = cli(operator(f.id, "operator-repeat"));
        assert.equal(duplicate.ok, false); assert.equal(duplicate.applied, 0); assert.equal(duplicate.remaining_unknown, 0); assert.equal(duplicate.backlog_clear, true);
        await db.begin(tx => kernelSettle(tx as unknown as AttemptDatabase, f.attempt));
        assert.deepEqual(await effect(f.id), after);
        assert.deepEqual(await attemptRow(f.attempt), state);
        assert.deepEqual(await db`SELECT * FROM platform_upgrade_state`, maintenance);
        assert.deepEqual(await db`SELECT * FROM global_settings`, settings);
      } finally { reserved.release(); }
    });

    for (const winner of ["operator", "kernel"] as const) await t.test(`${winner} wins overlapping settlement; loser cannot overwrite evidence`, async () => {
      await reset();
      const f = await fixture("agent_run", "effect_pending", false);
      const first = await db.reserve();
      let pending: Promise<unknown> | undefined;
      try {
        await first.unsafe("BEGIN");
        if (winner === "operator") await settleEffectByOperator(first as unknown as MigrationConnection, operator(f.id));
        else await kernelSettle(first as unknown as AttemptDatabase, f.attempt);
        const recorded = (await first`SELECT * FROM job_attempt_effects WHERE id=${f.id}`)[0];
        pending = winner === "operator"
          ? contender.begin(tx => kernelSettle(tx as unknown as AttemptDatabase, f.attempt))
          : settleEffectByOperator(contender as unknown as MigrationConnection, operator(f.id));
        // Observe a real PG lock wait before releasing the winner, not a timing guess.
        pending.catch(() => {});
        let blocked = false;
        for (let n = 0; n < 100; n++) {
          const rows = await db`SELECT 1 FROM pg_stat_activity WHERE application_name=${name} AND cardinality(pg_blocking_pids(pid)) > 0`;
          if (rows.length) { blocked = true; break; }
          await delay(20);
        }
        assert.equal(blocked, true, "the second connection actually competed for the row");
        await first.unsafe("COMMIT");
        const result = await pending;
        if (winner === "kernel") assert.equal((result as { settled: boolean }).settled, false);
        assert.deepEqual(await effect(f.id), { ...recorded });
      } finally {
        await first.unsafe("ROLLBACK"); first.release();
        await pending?.catch(() => {});
      }
    });

    await t.test("CLI separates single-row success from the global backlog, including beyond scan limit", async () => {
      await reset();
      const one = await fixture("agent_run", "unknown", false), two = await fixture("agent_run", "unknown", false);
      const partial = cli(operator(one.id));
      assert.equal(partial.ok, true); assert.equal(partial.applied, 1); assert.equal(partial.remaining_unknown, 1); assert.equal(partial.backlog_clear, false);
      assert.equal(cli(operator(two.id)).remaining_unknown, 0);
      const missing = cli(operator(randomUUID()));
      assert.equal(missing.ok, false); assert.equal(missing.applied, 0); assert.equal(missing.backlog_clear, true);
      const active = await fixture("gateway_model_request", "effect_pending", true);
      await db`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status)
        SELECT ${active.attempt},${active.job},'bulk-' || n,'gateway_model_request',CASE WHEN n % 2=0 THEN 'unknown' ELSE 'effect_pending' END FROM generate_series(1,${DEFAULT_RECONCILE_LIMIT + 1}) n`;
      const last = await fixture("agent_run", "unknown", false);
      const output = cli(operator(last.id));
      assert.equal(output.ok, true); assert.equal(output.remaining_unknown, DEFAULT_RECONCILE_LIMIT + 2);
      assert.equal(output.backlog_clear, false);
      assert.equal(await countUnsettledEffects(migration), DEFAULT_RECONCILE_LIMIT + 2);
    });

    await t.test("invalid CLI input and SQL failure never claim a verified empty backlog or echo secrets", async () => {
      await reset();
      const f = await fixture("agent_run", "unknown", false), before = await effect(f.id);
      for (const invalid of [{ effect_id: "bad" }, { outcome: "guessed" }, { evidence: "short" }, { evidence: "x".repeat(513) }, { operation_id: "bad operation" }]) {
        const output = cli({ ...operator(f.id), ...invalid });
        assert.equal(output.ok, false); assert.equal(output.remaining_unknown, null); assert.equal(output.backlog_clear, null);
        assert.deepEqual(await effect(f.id), before);
      }
      const badConnection = cli({ ...operator(f.id), connection: { ...connection, database: "fixture-secret-never-echo" } });
      assert.equal(badConnection.ok, false); assert.equal(badConnection.remaining_unknown, null);
      // An isolated role loses SELECT after its UPDATE commits. The real next
      // query fails, exercising partial success without a fake PostgreSQL driver.
      await admin.unsafe(`CREATE ROLE "${countRole}" LOGIN PASSWORD 'fixture-secret-never-echo'`);
      roleCreated = true;
      await db.unsafe(`GRANT USAGE ON SCHEMA public TO "${countRole}";
        GRANT SELECT, UPDATE ON job_attempt_effects TO "${countRole}";
        GRANT SELECT ON job_attempts TO "${countRole}";
        CREATE FUNCTION fixture_break_count() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
          REVOKE SELECT ON job_attempt_effects FROM "${countRole}";
          RETURN NULL; END $$;
        CREATE TRIGGER fixture_break_count AFTER UPDATE ON job_attempt_effects FOR EACH STATEMENT EXECUTE FUNCTION fixture_break_count()`);
      const failedCount = cli({ ...operator(f.id), connection: { ...connection, username: countRole, password: "fixture-secret-never-echo" } });
      assert.equal(failedCount.ok, false); assert.equal(failedCount.settled, true); assert.equal(failedCount.applied, 1);
      assert.equal(failedCount.remaining_unknown, null); assert.equal(failedCount.backlog_clear, null);
      await db.unsafe("DROP TRIGGER fixture_break_count ON job_attempt_effects; DROP FUNCTION fixture_break_count()");
      assert.equal((await effect(f.id)).status, "settled");
    });
  } finally {
    await contender.end({ timeout: 5 }); await db.end({ timeout: 5 });
    if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
    if (roleCreated) await admin.unsafe(`DROP ROLE "${countRole}"`);
    await admin.end({ timeout: 5 });
  }
});
