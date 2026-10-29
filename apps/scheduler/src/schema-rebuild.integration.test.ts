import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { MIGRATE_LOCK_ID, runMigrations, type MigrationConnection } from "./migration-runner.js";
import { readOwnedSequenceState } from "./owned-sequences.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";
import { SCHEMA_VERSION } from "./schema-version.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

const AUDIT_ID = 859;
const EVENT_ID = 3173;

async function createDatabase(admin: ReturnType<typeof postgres>): Promise<{ name: string; url: string }> {
  const base = new URL(testDatabaseUrl ?? "postgres://localhost/postgres");
  const name = `deepsonar_rebuild_seq_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  base.search = "";
  return { name, url: base.toString() };
}

async function withReserved<T>(
  db: ReturnType<typeof postgres>,
  fn: (conn: MigrationConnection & { release: () => void }) => Promise<T>,
): Promise<T> {
  const reserved = await db.reserve();
  await reserved`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
  try {
    return await fn(reserved as unknown as MigrationConnection & { release: () => void });
  } finally {
    await reserved`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
    reserved.release();
  }
}

async function seedHighIdHistory(db: ReturnType<typeof postgres>): Promise<{ jobId: string }> {
  const projectId = randomUUID();
  const canvasId = randomUUID();
  const jobId = randomUUID();
  await db`
    INSERT INTO projects (id, name)
    VALUES (${projectId}::uuid, 'seq-rebuild')`;
  await db`
    INSERT INTO canvases (id, project_id, title)
    VALUES (${canvasId}, ${projectId}::uuid, 'seq-rebuild')
  `;
  await db`
    INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
    VALUES (${jobId}::uuid, ${projectId}::uuid, ${canvasId}, 'explore', 'succeeded', '{}'::jsonb)
  `;
  await db.unsafe(
    `INSERT INTO events (id, job_id, event_id, job_seq, type) ` +
      `VALUES (${EVENT_ID}, '${jobId}', 'evt-high', 1, 'progress')`,
  );
  await db.unsafe(
    `INSERT INTO audit_logs (id, actor_type, actor_id, action, result) ` +
      `OVERRIDING SYSTEM VALUE ` +
      `VALUES (${AUDIT_ID}, 'system', 'rebuild-test', 'seq.probe', 'ok')`,
  );
  await db.unsafe("SELECT setval('public.events_id_seq', 1, false)");
  await db.unsafe("SELECT setval('public.audit_logs_id_seq', 47, true)");
  return { jobId };
}

async function assertSequenceReady(
  db: MigrationConnection,
  table: "audit_logs" | "events",
  maxId: number,
): Promise<void> {
  const state = await readOwnedSequenceState(db, table, "id");
  assert.equal(state.maxId, maxId, `${table} MAX(id)`);
  assert.ok(state.lastValue >= maxId, `${state.sequenceName}.last_value=${state.lastValue} < ${maxId}`);
  assert.equal(state.nextVal, maxId + 1, `${state.sequenceName} nextval`);
}

if (!testDatabaseUrl) {
  test("rebuild/boot owned-sequence integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("boot auto-setval heals drifted audit_logs/events and accepts the next INSERT", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const target = await createDatabase(admin);
    const db = postgres(target.url, { max: 2 });
    try {
      await withReserved(db, (conn) => runMigrations(conn));
      const { jobId } = await seedHighIdHistory(db);
      const beforeAudit = await withReserved(db, (conn) => readOwnedSequenceState(conn, "audit_logs", "id"));
      const beforeEvents = await withReserved(db, (conn) => readOwnedSequenceState(conn, "events", "id"));
      assert.equal(beforeAudit.maxId, AUDIT_ID);
      assert.ok(beforeAudit.lastValue < AUDIT_ID);
      assert.equal(beforeEvents.maxId, EVENT_ID);
      assert.ok(beforeEvents.lastValue < EVENT_ID);

      await withReserved(db, (conn) => runMigrations(conn));
      await withReserved(db, async (conn) => {
        await assertSequenceReady(conn, "audit_logs", AUDIT_ID);
        await assertSequenceReady(conn, "events", EVENT_ID);
      });

      const [audit] = await db<{ id: number }[]>`
        INSERT INTO audit_logs (actor_type, actor_id, action, result)
        VALUES ('system', 'rebuild-test', 'seq.boot', 'ok')
        RETURNING id
      `;
      const [event] = await db<{ id: number }[]>`
        INSERT INTO events (job_id, event_id, job_seq, type)
        VALUES (${jobId}::uuid, 'evt-boot', 2, 'progress')
        RETURNING id
      `;
      assert.equal(Number(audit?.id), AUDIT_ID + 1);
      assert.equal(Number(event?.id), EVENT_ID + 1);
    } finally {
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
      await admin.end();
    }
  });

  test("rebuild copy-back of high identity/serial ids setvals public sequences", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const target = await createDatabase(admin);
    const db = postgres(target.url, { max: 2 });
    try {
      await withReserved(db, (conn) => runMigrations(conn));
      const { jobId } = await seedHighIdHistory(db);

      const result = await rebuildSchemaOnReservedSession(
        () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void | Promise<void> }>,
        {
          mode: "apply",
          force: true,
          dump: false,
          keepStaging: true,
          terminateScheduler: false,
        },
      );
      assert.equal(result.applied, true);
      assert.ok(result.copiedTables.includes("audit_logs"));
      assert.ok(result.copiedTables.includes("events"));

      await withReserved(db, async (conn) => {
        await assertSequenceReady(conn, "audit_logs", AUDIT_ID);
        await assertSequenceReady(conn, "events", EVENT_ID);
      });

      const [staging] = await db<{ last_value: string | number; is_called: boolean }[]>`
        SELECT last_value, is_called
        FROM deepsonar_rebuild_src.audit_logs_id_seq
      `;
      const [live] = await db<{ last_value: string | number; is_called: boolean }[]>`
        SELECT last_value, is_called
        FROM public.audit_logs_id_seq
      `;
      assert.equal(Number(live?.last_value), AUDIT_ID);
      assert.equal(live?.is_called, true);
      assert.notEqual(
        `${String(staging?.last_value)}:${String(staging?.is_called)}`,
        `${AUDIT_ID}:true`,
        "setval must target public.audit_logs_id_seq, not the staging sequence",
      );

      const [audit] = await db<{ id: number }[]>`
        INSERT INTO audit_logs (actor_type, actor_id, action, result)
        VALUES ('system', 'rebuild-test', 'seq.after-rebuild', 'ok')
        RETURNING id
      `;
      const [event] = await db<{ id: number }[]>`
        INSERT INTO events (job_id, event_id, job_seq, type)
        VALUES (${jobId}::uuid, 'evt-after-rebuild', 2, 'progress')
        RETURNING id
      `;
      assert.equal(Number(audit?.id), AUDIT_ID + 1);
      assert.equal(Number(event?.id), EVENT_ID + 1);
    } finally {
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
      await admin.end();
    }
  });
}

if (testDatabaseUrl) {
  test("#757 upgrade rejects unproven CLI preferences before copy and preserves reviewed history", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const target = await createDatabase(admin);
    const db = postgres(target.url, { max: 2 });
    try {
      await withReserved(db, (conn) => runMigrations(conn));
      const { jobId } = await seedHighIdHistory(db);
      const historical = { agent_cli: "claude-code", model: "historical-model" };
      await db`UPDATE jobs SET agent_snapshot_json = ${db.json(historical)} WHERE id = ${jobId}`;
      await db`UPDATE role_configs SET agent_cli = 'claude-code', model = 'reviewed-global-model' WHERE project_id IS NULL`;
      await db`UPDATE schema_meta SET version = 59 WHERE id = 'global'`;
      const rebuild = (mode: "plan" | "apply", resetRoleIdentity = false) => rebuildSchemaOnReservedSession(
        () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void | Promise<void> }>,
        { mode, force: true, dump: false, keepStaging: true, resetRoleIdentity, terminateScheduler: false },
      );
      const plan = await rebuild("plan");
      assert.equal(plan.applied, false);
      assert.equal(plan.plan.currentVersion, 59);
      await assert.rejects(() => rebuild("apply"), /role_config_identity_review_required/);
      const [unchanged] = await db`SELECT version FROM schema_meta WHERE id = 'global'`;
      assert.equal(unchanged.version, 59, "rejection precedes destructive schema work, even with force");
      await db`DELETE FROM schema_meta WHERE id = 'global'`;
      await assert.rejects(() => rebuild("apply"), /role_config_identity_review_required/);
      await db`INSERT INTO schema_meta (id, version) VALUES ('global', 59)`;
      await db`ALTER TABLE role_configs ALTER COLUMN agent_cli SET NOT NULL`;
      await db`INSERT INTO role_configs (role_id, project_id, agent_cli, model, instructions_markdown)
        SELECT r.id, j.project_id, 'pi', 'obsolete-project-model', 'preserve project instructions'
        FROM agent_roles r CROSS JOIN jobs j WHERE r.name = 'audit' AND j.id = ${jobId}`;
      await assert.rejects(() => rebuild("apply"), /role_config_identity_review_required/);
      await assert.rejects(() => rebuildSchemaOnReservedSession(
        () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void | Promise<void> }>,
        { mode: "apply", force: true, dump: false, resetRoleIdentity: true, terminateScheduler: false },
      ), /requires a successful backup/);
      const result = await rebuild("apply", true);
      assert.equal(result.applied, true);
      const [backup] = await db`SELECT agent_cli, model FROM deepsonar_rebuild_src.role_configs WHERE project_id IS NOT NULL`;
      assert.deepEqual({ ...backup }, { agent_cli: "pi", model: "obsolete-project-model" });
      const [stored] = await db`SELECT agent_snapshot_json FROM jobs WHERE id = ${jobId}`;
      assert.deepEqual(stored.agent_snapshot_json, historical);
      const configs = await db`SELECT agent_cli, model FROM role_configs WHERE project_id IS NULL`;
      assert.ok(configs.every((row) => row.agent_cli === null));
      assert.ok(configs.every((row) => row.model === 'reviewed-global-model'));
      const [projectConfig] = await db`SELECT agent_cli, model, instructions_markdown FROM role_configs WHERE project_id IS NOT NULL`;
      assert.deepEqual({ ...projectConfig }, { agent_cli: null, model: null, instructions_markdown: 'preserve project instructions' });
    } finally {
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
      await admin.end();
    }
  });
}

if (testDatabaseUrl) {
  test("#752 current-layout fixture marked v60 preserves identity provenance on rebuild", async () => {
    const adminUrl = new URL(testDatabaseUrl); adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const target = await createDatabase(admin);
    const db = postgres(target.url, { max: 2 });
    try {
      await withReserved(db, (conn) => runMigrations(conn));
      const { jobId } = await seedHighIdHistory(db);
      await db`UPDATE role_configs SET agent_cli = 'pi', model = 'explicit-model' WHERE project_id IS NULL`;
      await db`UPDATE schema_meta SET version = 60 WHERE id = 'global'`;
      const result = await rebuildSchemaOnReservedSession(
        () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void | Promise<void> }>,
        { mode: "apply", dump: false, keepStaging: true, terminateScheduler: false },
      );
      assert.equal(result.applied, true);
      const [version] = await db`SELECT version FROM schema_meta WHERE id = 'global'`;
      assert.equal(version.version, SCHEMA_VERSION);
      const configs = await db`SELECT agent_cli, model FROM role_configs WHERE project_id IS NULL`;
      assert.ok(configs.length > 0 && configs.every(row => row.agent_cli === 'pi' && row.model === 'explicit-model'));
      const [history] = await db`SELECT id FROM jobs WHERE id = ${jobId}`;
      assert.equal(history.id, jobId);
      await db`SELECT id FROM project_knowledge_work LIMIT 0`;
      await db`SELECT id FROM project_knowledge_receipts LIMIT 0`;
    } finally {
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
      await admin.end();
    }
  });
}

if (testDatabaseUrl) {
  test("#770 v62 Finding shape rebuild preserves history and backup before accepting an independent source", async () => {
    const { runFindingSourceRebuildFixture } = await import("./schema-rebuild-finding-fixture.js");
    await runFindingSourceRebuildFixture(testDatabaseUrl);
  });
}
