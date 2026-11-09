import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

test("knowledge ticks do not kick overdue ordinary jobs back into a paused Dispatcher", {
  skip: !databaseUrl && "TEST_DATABASE_URL is required", timeout: 15_000,
}, async () => {
  const url = new URL(databaseUrl!); url.pathname = "/postgres"; url.search = "";
  const admin = postgres(url.toString(), { max: 1 });
  const name = `knowledge_wake_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  let close = async () => {};
  try {
    const { sql, migrate } = await import("./db.js");
    close = () => sql.end({ timeout: 5 });
    await migrate();
    const { kickDispatcher } = await import("./dispatcher.js");
    const { projectKnowledgeScheduler } = await import("./project-knowledge-scheduler.js");
    const wake = await import("./schedule-wake.js");
    const projectId = randomUUID(), canvasId = randomUUID(), jobId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'knowledge wake fixture')`;
    await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'due task',
      ${sql.json({ schedule: { start_at: "2020-01-01T00:00:00.000Z", timezone: "Asia/Shanghai", preset: "custom" } })})`;
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES(${jobId},${projectId},${canvasId},'audit','pending','{}')`;
    await sql`UPDATE global_settings SET claims_paused=true,claims_pause_reason='maintenance',
      claims_paused_by='fixture',claims_paused_at=clock_timestamp() WHERE id='global'`;
    let ticks = 0, selfKicks = 0;
    let observed!: () => void;
    const firstTick = new Promise<void>(resolve => { observed = resolve; });
    let observedSecond!: () => void;
    const secondTick = new Promise<void>(resolve => { observedSecond = resolve; });
    const originalTick = projectKnowledgeScheduler.tick.bind(projectKnowledgeScheduler);
    const tick = mock.method(projectKnowledgeScheduler, "tick", async (stopped?: () => boolean) => {
      ticks++;
      const result = await originalTick(stopped);
      if (ticks === 1) observed();
      else observedSecond();
      return result;
    });
    // Exercise kickDispatcher -> dispatchOnce -> real knowledge tick -> refresh.
    // Bound a faulty implementation to three wakeups so failure cannot spin forever.
    wake.bindScheduleWake(() => { selfKicks++; if (selfKicks < 3) kickDispatcher(); });
    try {
      kickDispatcher();
      await firstTick;
      assert.equal(selfKicks, 0, "an overdue gated Job is not a new external scheduling event");
      assert.equal(ticks, 1, "the Dispatcher becomes idle after the paused claim attempt");
      assert.equal((await sql`SELECT status FROM jobs WHERE id=${jobId}`)[0]?.status, "pending");
      // External refreshes still wake due work; dispatch-internal refreshes only arm future timers.
      await wake.refreshScheduleWakeFromDb();
      assert.equal(selfKicks, 1);
      await secondTick;
      assert.equal(ticks, 2);
      assert.equal(selfKicks, 1, "the external wake must not create a feedback loop");
    } finally { wake.unbindScheduleWake(); tick.mock.restore(); }
  } finally {
    await close();
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});
