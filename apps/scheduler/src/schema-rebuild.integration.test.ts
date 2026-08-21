import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { MIGRATE_LOCK_ID, runMigrations, type MigrationConnection } from "./migration-runner.js";
import { readOwnedSequenceState } from "./owned-sequences.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";

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
    INSERT INTO projects (id, canvas_id, name)
    VALUES (${projectId}::uuid, ${canvasId}, 'seq-rebuild')
  `;
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
