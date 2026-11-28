import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readNextKnowledgeWake } from "./knowledge-wake.js";
import { enqueueKnowledgeWork } from "./domains/project-knowledge/requests.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./domains/project-knowledge/test-support.js";

test("historical automatic work never wakes a new stage; explicit work still observes busy-project admission", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db);
    const [active] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state)
      VALUES(${source.projectId},${randomUUID()},${"a".repeat(64)},'running') RETURNING id`;
    const [pending] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,trigger_key,governance_hash,next_attempt_at)
      VALUES(${source.projectId},${source.jobId},${`knowledge:auto:${source.jobId}`},${"a".repeat(64)},now()+interval '30 seconds') RETURNING id,next_attempt_at`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "ordinary queued work waits for its project's active work");
    await db`UPDATE project_knowledge_work SET reason='automatic_sources_pending' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null);
    await db`UPDATE project_knowledge_work SET reason='automatic_prepare_retry:1' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null);
    await db`UPDATE project_knowledge_work SET reason='automatic_prepare_retry:oops' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "only numeric Scheduler retry markers prepare on a busy project");
    await db`UPDATE project_knowledge_work SET reason=NULL WHERE id=${String(pending!.id)}`;
    await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${String(active!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "automatic work stays deferred even when project becomes idle");
    await db`UPDATE project_knowledge_work SET trigger_key=${randomUUID()} WHERE id=${String(pending!.id)}`;
    assert.equal((await readNextKnowledgeWake(db as never))!.getTime(), new Date(pending!.next_attempt_at as string).getTime());
    await db`UPDATE project_knowledge_work SET state='blocked' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null);
  });
});

test("Agent preparation-like reasons follow ordinary busy-project wake admission", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db);
    const [active] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state)
      VALUES(${source.projectId},${randomUUID()},${"a".repeat(64)},'running') RETURNING id`;
    for (const reason of ["automatic_sources_pending", "automatic_prepare_retry:oops", "automatic_prepare_retry:1"]) {
      const workId = await db.begin(raw => enqueueKnowledgeWork(raw as never, {
        actor: { ...source, snapshot: {} }, governanceHash: "a".repeat(64),
        trigger: { fixture: randomUUID() }, manifest: [], reason,
      }));
      assert.equal(await readNextKnowledgeWake(db as never), null, "Agent text cannot bypass an active project's wake gate");
      await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${String(active!.id)}`;
      assert.ok(await readNextKnowledgeWake(db as never), "ordinary Agent work wakes when its project is available");
      await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${workId}`;
      await db`UPDATE project_knowledge_work SET state='running' WHERE id=${String(active!.id)}`;
    }
  });
});

test("a newly committed Agent knowledge request notifies the existing Dispatcher channel", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db);
    let wake: (() => void) | undefined;
    const notified = new Promise<void>((resolve) => { wake = resolve; });
    const listener = await db.listen("deepsonar_jobs", (payload) => {
      if (payload === "knowledge_work") wake!();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const workId = await db.begin((raw) => enqueueKnowledgeWork(raw as never, {
        actor: { ...source, snapshot: {} }, governanceHash: "a".repeat(64),
        trigger: { test: randomUUID() }, manifest: [], reason: "fixture request",
      }));
      await Promise.race([notified, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("committed work did not wake Dispatcher")), 3000);
      })]);
      assert.equal((await db`SELECT id FROM project_knowledge_work WHERE id=${workId}`).length, 1);
    } finally { if (timeout) clearTimeout(timeout); await listener.unlisten(); }
  });
});

test("#1287 知识探测挂住时不挡普通挂表，且 kick 请求按批次消费", async () => {
  const { armedUntilForTests, bindScheduleWake, clearScheduleWake, noteKnowledgeWakeChange,
    refreshScheduleWakeFromDb, resetKnowledgeWakeForTests, setKnowledgeWakeProbeForTests } =
    await import("./schedule-wake.js");
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const scheduled = async (startAt: string) => {
      const canvasId = randomUUID();
      await db`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${owner.projectId},'sched',
        ${db.json({ schedule: { start_at: startAt } } as never)})`;
      await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,payload_json,agent_snapshot_json)
        VALUES(${randomUUID()},${owner.projectId},${canvasId},'explore','pending','{}'::jsonb,'{}'::jsonb)`;
    };
    await scheduled(new Date(Date.now() + 60 * 60 * 1000).toISOString());

    let kicks = 0;
    bindScheduleWake(() => { kicks += 1; });
    clearScheduleWake();

    let probes = 0;
    let releaseProbe: (() => void) | null = null;
    setKnowledgeWakeProbeForTests(() => {
      probes += 1;
      return new Promise<Date | null>((resolve) => { releaseProbe = () => resolve(null); });
    });
    try {
      const startedAt = Date.now();
      // 定时器触发的路径（kickDueTasks: true）只把知识探测放到后台，不等它返回。
      await refreshScheduleWakeFromDb({ kickDueTasks: true }, db as never);
      assert.ok(Date.now() - startedAt < 1000, "普通扫描不能等知识探测返回");
      await refreshScheduleWakeFromDb({ kickDueTasks: true }, db as never);
      assert.equal(probes, 1, "知识探测单飞：在途时不会发起第二次");
      // 正向情形：挂住探测 → 写入新的知识工作并显式失效 → 放行旧空结果后必须补查并挂上新期限。
      const dueAt = new Date(Date.now() + 30_000);
      await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state,next_attempt_at)
        VALUES(${owner.projectId},${randomUUID()},${"a".repeat(64)},'pending',${dueAt.toISOString()})`;
      setKnowledgeWakeProbeForTests(() => { probes += 1; return Promise.resolve(dueAt); });
      noteKnowledgeWakeChange();
      releaseProbe!();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(probes, 2, "代次推进后必须补查一次（旧结果被丢弃）");
      assert.equal(armedUntilForTests(), dueAt.getTime(), "新写入的知识工作必须挂上自己的期限");
      // 到期任务：同批次消费 kick 请求，随后的静默刷新不再触发领取。
      const canvasId = randomUUID();
      await db`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${owner.projectId},'due',
        ${db.json({ schedule: { start_at: new Date(Date.now() - 1000).toISOString() } } as never)})`;
      await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,payload_json,agent_snapshot_json)
        VALUES(${randomUUID()},${owner.projectId},${canvasId},'explore','pending','{}'::jsonb,'{}'::jsonb)`;
      const before = kicks;
      await refreshScheduleWakeFromDb({ kickDueTasks: true }, db as never);
      assert.equal(kicks, before + 1, "到期普通任务必须触发一次领取");
      await refreshScheduleWakeFromDb({ kickDueTasks: false }, db as never);
      assert.equal(kicks, before + 1, "静默刷新不能借旧请求再触发领取");
    } finally {
      setKnowledgeWakeProbeForTests(null);
      clearScheduleWake();
      bindScheduleWake(() => undefined);
      resetKnowledgeWakeForTests();
    }
  });
});
