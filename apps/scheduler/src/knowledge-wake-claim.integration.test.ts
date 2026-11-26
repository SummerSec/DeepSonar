import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("knowledge wake claim integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("#1287 知识探测挂住时，两个未来普通任务仍按各自时间被真实领取", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const { migrate, sql } = await import("./db.js");
    const { claimPendingJobs } = await import("./dispatcher.js");
    const { bindScheduleWake, clearScheduleWake, refreshScheduleWakeFromDb, resetKnowledgeWakeForTests,
      setKnowledgeWakeProbeForTests } = await import("./schedule-wake.js");
    await migrate();

    const projectId = randomUUID();
    const snapshot = { agent_cli: "claude-code", credential_id: null, credential_provider: null, model: null };
    const jobIds: string[] = [];
    const schedule = async (startInMs: number): Promise<string> => {
      const canvasId = `knowledge-wake-claim-${randomUUID()}`;
      const jobId = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES(${projectId},'knowledge wake claim') ON CONFLICT DO NOTHING`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json,status) VALUES(${canvasId},${projectId},'sched',
        ${sql.json({ schedule: { start_at: new Date(Date.now() + startInMs).toISOString() } })},'active')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,payload_json,agent_snapshot_json)
        VALUES(${jobId},${projectId},${canvasId},'explore','pending','{}'::jsonb,${sql.json(snapshot)})`;
      jobIds.push(jobId);
      return jobId;
    };
    try {
      await schedule(1_000);
      await schedule(2_000);
      const claimed: string[] = [];
      bindScheduleWake(() => {
        void (async () => {
          try {
            for (const row of await claimPendingJobs()) claimed.push(row.id);
          } catch { /* 领取失败会让下面的断言暴露 */ }
        })();
      });
      clearScheduleWake();
      resetKnowledgeWakeForTests();
      // 知识探测永远挂住：普通任务的领取不能依赖它返回。
      setKnowledgeWakeProbeForTests(() => new Promise<Date | null>(() => undefined));
      await refreshScheduleWakeFromDb({ kickDueTasks: true });
      const deadline = Date.now() + 12_000;
      while (jobIds.some(id => !claimed.includes(id)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const id of jobIds) {
        assert.ok(claimed.includes(id), `Job ${id} 必须在知识探测挂住期间按自己的时间被领取（已领取 ${claimed.length} 个）`);
      }
      const rows = await sql`SELECT id,status FROM jobs WHERE id = ANY(${sql.array(jobIds)}::uuid[])`;
      for (const row of rows) assert.notEqual(row.status, "pending", `Job ${String(row.id)} 不能还是 pending`);
    } finally {
      setKnowledgeWakeProbeForTests(null);
      clearScheduleWake();
      bindScheduleWake(() => undefined);
      resetKnowledgeWakeForTests();
      // 画布先删，否则 projects 的删除会被 canvases_project_id_fkey 挡住。
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
    }
  });
}
