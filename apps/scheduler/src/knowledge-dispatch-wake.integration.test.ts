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
    let ticks = 0, completedTicks = 0, selfKicks = 0;
    let observed!: () => void;
    const firstTick = new Promise<void>(resolve => { observed = resolve; });
    let observedSecond!: () => void;
    const secondTick = new Promise<void>(resolve => { observedSecond = resolve; });
    const originalTick = projectKnowledgeScheduler.tick.bind(projectKnowledgeScheduler);
    const tick = mock.method(projectKnowledgeScheduler, "tick", async (stopped?: () => boolean) => {
      ticks++;
      const result = await originalTick(stopped);
      completedTicks = ticks;
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
      // External refreshes still wake due work; dispatch-internal refreshes do not repeat overdue task kicks.
      await wake.refreshScheduleWakeFromDb();
      assert.equal(selfKicks, 1);
      await secondTick;
      assert.equal(ticks, 2);
      assert.equal(selfKicks, 1, "the external wake must not create a feedback loop");

      const { queueAutomaticKnowledgeWork } = await import("./domains/project-knowledge/automatic.js");
      const { PROJECT_KNOWLEDGE_GOVERNANCE_HASH } = await import("./domains/project-knowledge/platform-skills.js");
      for (let index = 0; index < 9; index++) {
        const sourceJobId = randomUUID(), attemptId = randomUUID();
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,finished_at)
          VALUES(${sourceJobId},${projectId},${canvasId},'audit','succeeded',
            ${sql.json({ platform_tools: ["request_project_knowledge"] })},now())`;
        await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase,finished_at)
          VALUES(${attemptId},${sourceJobId},1,'succeeded','terminal',now())`;
        const queued = await sql.begin(async (tx) => {
          await tx`SELECT id FROM canvases WHERE id=${canvasId} FOR UPDATE`;
          await tx`SELECT id FROM jobs WHERE id=${sourceJobId} FOR UPDATE`;
          return queueAutomaticKnowledgeWork(tx as never, projectId, sourceJobId, PROJECT_KNOWLEDGE_GOVERNANCE_HASH);
        });
        assert.equal(queued.status, "queued");
        assert.ok(queued.work_ref);
      }

      const jobsBeforeBatch = Number((await sql`SELECT count(*)::int AS count FROM jobs`)[0]?.count);
      const notifications: string[] = [];
      const jobListener = await sql.listen("deepsonar_jobs", (payload) => notifications.push(payload));
      const batchStartTicks = ticks;
      selfKicks = 0;
      try {
        kickDispatcher();
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [counts] = await sql`SELECT count(*)::int AS total,
              count(*) FILTER (WHERE state='completed' AND reason='automatic_no_sources')::int AS completed
            FROM project_knowledge_work
            WHERE project_id=${projectId} AND trigger_key LIKE 'knowledge:auto:%'`;
          if (Number(counts?.total) === 9 && Number(counts?.completed) === 9
            && completedTicks >= batchStartTicks + 2) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await new Promise<void>(resolve => setImmediate(resolve));

        const automaticWorks = await sql`SELECT state,reason FROM project_knowledge_work
          WHERE project_id=${projectId} AND trigger_key LIKE 'knowledge:auto:%' ORDER BY created_at,id`;
        assert.equal(automaticWorks.length, 9);
        assert.ok(automaticWorks.every((work) => work.state === "completed" && work.reason === "automatic_no_sources"));
        assert.equal(ticks - batchStartTicks, 2, "the ninth due work is completed by one follow-up Dispatcher pass");
        assert.equal(selfKicks, 1, "only the remaining knowledge batch causes an internal kick");
        assert.deepEqual(notifications, [], "empty-source preparation creates no maker Job notification");
        assert.equal(Number((await sql`SELECT count(*)::int AS count FROM jobs`)[0]?.count), jobsBeforeBatch,
          "empty-source preparation creates no maker Job");
        assert.deepEqual((await sql`SELECT status FROM jobs WHERE id=${jobId}`)[0]?.status, "pending",
          "the overdue ordinary Job remains gated while the knowledge batch drains");
      } finally {
        await jobListener.unlisten();
      }
      // Ordinary pending knowledge work also retains its wake after automatic preparation drains.
      wake.bindScheduleWake(() => { selfKicks++; });
      await sql`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state)
        VALUES(${projectId},${randomUUID()},${"a".repeat(64)},'pending')`;
      await wake.refreshScheduleWakeFromDb({ kickDueTasks: false });
      assert.equal(selfKicks, 2, "suppressing ordinary task kicks must not strand due knowledge work");
    } finally { wake.unbindScheduleWake(); tick.mock.restore(); }
  } finally {
    await close();
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});
