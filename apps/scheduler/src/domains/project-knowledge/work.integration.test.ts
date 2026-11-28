import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { KnowledgeJobAssignment } from "@deepsonar/shared-types";
import { KNOWLEDGE_CASE_KINDS } from "@deepsonar/shared-types";
import type { CreateJobInput, EnsureCanvasInput } from "../../core.js";
import { createKnowledgeWorkScheduler } from "./work.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { KNOWLEDGE_FIXED_CASES } from "./case-policy.js";
import { enqueueKnowledgeWork } from "./requests.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";

const GOVERNANCE = "a".repeat(64);

function schedulerFor(db: TestSql) {
  return createKnowledgeWorkScheduler({
    db: db as never,
    governanceHash: GOVERNANCE,
    ensureCanvasForTaskInTransaction: async (tx, input: EnsureCanvasInput) => {
      const [row] = await tx`INSERT INTO canvases(project_id,title,target_json,trigger_source,trigger_event_id)
        VALUES(${input.projectId},${input.title},${tx.json(input.target as never)},
          ${input.triggerSource ?? null},${input.triggerEventId ?? null})
        ON CONFLICT(project_id,trigger_source,trigger_event_id) WHERE trigger_event_id IS NOT NULL
        DO UPDATE SET title=EXCLUDED.title RETURNING id`;
      await tx`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json)
        VALUES(${String(row!.id)},'root',${input.title},'active',${tx.json({ target: input.target } as never)})
        ON CONFLICT DO NOTHING`;
      return String(row!.id);
    },
    createJobInTransaction: async (tx, input: CreateJobInput, assignment?: KnowledgeJobAssignment) => {
      assert.ok(assignment);
      const [created] = await tx`INSERT INTO jobs(project_id,canvas_id,parent_job_id,type,status,agent_snapshot_json,payload_json,timeout_sec)
        VALUES(${input.projectId},${input.canvasId ?? null},${input.parentJobId ?? null},${input.type},
          'pending',${tx.json({ role_kind: "role", knowledge_assignment: assignment } as never)},
          ${tx.json((input.payload ?? {}) as never)},${input.timeoutSec ?? 1800}) RETURNING *`;
      return { created: created! };
    },
  });
}

async function workFixture(db: TestSql) {
  const source = await seedKnowledgeJob(db);
  const [work] = await db`INSERT INTO project_knowledge_work
    (project_id,origin_job_id,canvas_id,trigger_key,input_manifest_json,governance_hash,reason)
    VALUES(${source.projectId},${source.jobId},${source.canvasId},${randomUUID()},
      ${db.json([])},${GOVERNANCE},'fixture') RETURNING id`;
  return { ...source, workId: String(work!.id) };
}

async function beginJob(db: TestSql, jobId: string) {
  const [attempt] = await db`INSERT INTO job_attempts(job_id,attempt_no,status,phase,started_at)
    VALUES(${jobId},1,'active','agent.ready',now()) RETURNING id`;
  await db`UPDATE jobs SET status='running',started_at=now() WHERE id=${jobId}`;
  return String(attempt!.id);
}

async function finishJob(db: TestSql, scheduler: ReturnType<typeof schedulerFor>, jobId: string,
  status: "succeeded" | "orphan" | "timeout" = "succeeded") {
  const [existing] = await db`SELECT id FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no DESC LIMIT 1`;
  const attemptId = existing ? String(existing.id) : await beginJob(db, jobId);
  const [assignment] = await db`SELECT stage,case_id,arm,project_id FROM project_knowledge_job_assignments WHERE job_id=${jobId}`;
  if (assignment?.stage === "trial" && status === "succeeded") {
    // State-machine fixture: model output is synthesized here, while provenance
    // still follows the same Job/Attempt/Event/Artifact/asset relationships.
    const output = { case_id: assignment.case_id, arm: assignment.arm, outcome: "pass", observations: ["fixture execution"] };
    const blob = await writeKnowledgeBlob(db as never, output);
    await registerKnowledgeBlob(db as never, blob.hash, blob.bytes);
    const [asset] = await db`INSERT INTO shared_assets(scope_type,project_id,logical_key,origin,created_by_job_id)
      VALUES('project',${String(assignment.project_id)},${`trial-${jobId}`},'system',${jobId}) RETURNING id`;
    const [version] = await db`INSERT INTO shared_asset_versions(asset_id,version,content_sha256,bytes,content_type,origin,created_by_job_id)
      VALUES(${String(asset!.id)},1,${blob.hash},${blob.bytes},'application/json','system',${jobId}) RETURNING id`;
    const eventId = randomUUID();
    await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
      VALUES(${jobId},${eventId},1,${attemptId},'fact',${db.json({ title: "trial fixture" })})`;
    const [artifact] = await db`INSERT INTO artifacts(project_id,job_id,artifact_key,kind,source_event_id,source_operation)
      VALUES(${String(assignment.project_id)},${jobId},${`trial:${jobId}`},'observation',${eventId},'emit_fact') RETURNING id`;
    await db`INSERT INTO artifact_evidence(artifact_id,statement,uri,sha256)
      VALUES(${String(artifact!.id)},'fixture execution',${`asset:${version!.id}`},${blob.hash})`;
  }
  await db.begin(async (tx) => {
    const [job] = await tx`SELECT id,project_id,canvas_id FROM jobs WHERE id=${jobId}`;
    await tx`SELECT id FROM canvases WHERE id=${String(job!.canvas_id)} FOR UPDATE`;
    await tx`UPDATE jobs SET status=${status},finished_at=now() WHERE id=${jobId}`;
    await tx`UPDATE job_attempts SET status=${status},phase='terminal',finished_at=now()
      WHERE id=${attemptId}`;
    const [settled] = await tx`SELECT id,project_id,canvas_id,started_at,finished_at FROM jobs WHERE id=${jobId}`;
    assert.equal(await scheduler.onTerminal(tx as never, settled as { id: unknown }, status), true);
  });
}

async function assigned(db: TestSql, workId: string, stage: string) {
  return db`SELECT a.*,j.status,j.agent_snapshot_json FROM project_knowledge_job_assignments a
    JOIN jobs j ON j.id=a.job_id WHERE a.work_id=${workId} AND a.stage=${stage}
    ORDER BY a.created_at,a.job_id`;
}

test("ordinary Agent work claims despite reasons matching automatic preparation text", async () => {
  await withKnowledgeDatabase(async (db) => {
    const scheduler = schedulerFor(db);
    for (const reason of ["automatic_sources_pending", "automatic_prepare_retry:oops", "automatic_prepare_retry:1"]) {
      const source = await seedKnowledgeJob(db);
      const workId = await db.begin(raw => enqueueKnowledgeWork(raw as never, {
        actor: { ...source, snapshot: {} }, governanceHash: GOVERNANCE,
        trigger: { fixture: randomUUID() }, manifest: [], reason,
      }));
      assert.equal(await scheduler.tick(), 1);
      assert.equal((await assigned(db, workId, "maker")).length, 1);
      const [work] = await db`SELECT reason,job_count FROM project_knowledge_work WHERE id=${workId}`;
      assert.equal(work!.reason, reason);
      assert.equal(work!.job_count, 1);
    }
  });
});

test("knowledge work claims once and freezes an isolated maker Job/Canvas", async () => {
  await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    const scheduler = schedulerFor(db);
    assert.equal(await scheduler.tick(), 1);
    assert.equal(await scheduler.tick(), 0);
    const maker = await assigned(db, fixture.workId, "maker");
    assert.equal(maker.length, 1);
    const [work] = await db`SELECT state,stage,canvas_id,active_job_id,job_count FROM project_knowledge_work WHERE id=${fixture.workId}`;
    assert.equal(work!.state, "running");
    assert.equal(work!.stage, "maker");
    assert.notEqual(work!.canvas_id, fixture.canvasId);
    assert.equal(work!.active_job_id, maker[0]!.job_id);
    assert.equal(work!.job_count, 1);
    assert.equal((maker[0]!.agent_snapshot_json as Record<string, any>).knowledge_assignment.work_id, fixture.workId);
    const hubs = await db`SELECT id FROM jobs WHERE canvas_id=${String(work!.canvas_id)} AND type='hub_reason'`;
    assert.equal(hubs.length, 0);
  });
});

test("each required case arm is a separate trial Job; evaluator and reviewer wait for prior stage", async () => {
  await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    const sourceRef = { kind: "fact" as const, ref: randomUUID(), content_hash: "c".repeat(64) };
    const sourceBlob = await writeKnowledgeBlob(db, { input: "raw task input without candidate or scoring answer" });
    await registerKnowledgeBlob(db, sourceBlob.hash, sourceBlob.bytes);
    await db`UPDATE project_knowledge_work SET input_manifest_json=${db.json([{
      input_ref: `fact:${sourceRef.ref}`, kind: "fact", project_id: fixture.projectId,
      content_hash: sourceRef.content_hash, blob_hash: sourceBlob.hash, bytes: sourceBlob.bytes,
      audience: ["maker", "evaluator", "reviewer"],
    }])} WHERE id=${fixture.workId}`;
    const scheduler = schedulerFor(db);
    await scheduler.tick();
    const maker = (await assigned(db, fixture.workId, "maker"))[0]!;
    const makerId = String(maker.job_id);
    const makerAttempt = await beginJob(db, makerId);
    const candidate = { kind: "memory", logical_key: "known-pattern", title: "Known pattern", keywords: [], content: "Evidence-backed guidance" };
    const blob = await writeKnowledgeBlob(db as never, candidate);
    await registerKnowledgeBlob(db as never, blob.hash, blob.bytes);
    const [item] = await db`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title)
      VALUES(${fixture.projectId},'memory','known-pattern','Known pattern') RETURNING id`;
    const [version] = await db`INSERT INTO project_knowledge_versions
      (project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${fixture.projectId},${String(item!.id)},1,${blob.hash},${makerId},${makerAttempt},${db.json([])},${GOVERNANCE})
      RETURNING id`;
    const cases = KNOWLEDGE_CASE_KINDS.map((kind, n) => ({
      id: `case-${n}`, kind,
      ...(kind === "target" ? { prompt: "Execute the target behavior", expected: "Observable safe result" } : KNOWLEDGE_FIXED_CASES[kind]),
      critical: true,
      task_inputs: kind === "target" ? [sourceRef] : [],
    }));
    const digest = "b".repeat(64);
    const [proposal] = await db`INSERT INTO project_knowledge_proposals
      (project_id,work_id,action,state,revision,candidate_version_id,maker_job_id,idempotency_key,
       request_digest,input_digest,base_refs_json,evaluation_plan_json,reason)
      VALUES(${fixture.projectId},${fixture.workId},'create','evaluating',1,${String(version!.id)},
        ${makerId},${randomUUID()},${digest},${digest},${db.json([])},${db.json(cases)},'fixture')
      RETURNING id`;
    await db`UPDATE project_knowledge_work SET stage='evaluator' WHERE id=${fixture.workId}`;
    await finishJob(db, scheduler, makerId);
    let evaluatorId = "";
    for (let n = 0; n < 20; n++) {
      await scheduler.tick();
      const [work] = await db`SELECT active_job_id FROM project_knowledge_work WHERE id=${fixture.workId}`;
      if (!work?.active_job_id) continue;
      const [assignment] = await db`SELECT stage FROM project_knowledge_job_assignments WHERE job_id=${String(work.active_job_id)}`;
      if (assignment!.stage === "evaluator") { evaluatorId = String(work.active_job_id); break; }
      assert.equal(assignment!.stage, "trial");
      await finishJob(db, scheduler, String(work.active_job_id));
    }
    assert.ok(evaluatorId);
    const trials = await assigned(db, fixture.workId, "trial");
    assert.equal(trials.length, 12);
    assert.equal(new Set(trials.map((row) => String(row.job_id))).size, 12);
    for (const row of trials) {
      const manifest = row.input_manifest_json as Array<{ input_ref: string }>;
      const testCase = cases.find((item) => item.id === row.case_id)!;
      const probes = manifest.filter((entry) => entry.input_ref.startsWith("platform-probe:"));
      if (testCase.kind === "cross_project") assert.deepEqual(probes.map((entry) => entry.input_ref), ["platform-probe:foreign-scope"]);
      else if (testCase.kind === "revocation") assert.deepEqual(probes.map((entry) => entry.input_ref), ["platform-probe:revoked"]);
      else assert.equal(probes.length, 0);
      const resources = manifest.filter((entry) => !entry.input_ref.startsWith("platform-probe:"));
      const common = testCase.kind === "target" ? [`fact:${sourceRef.ref}`]
        : testCase.kind === "coexistence" ? ["trial-context:coexistence"] : [];
      assert.deepEqual(resources.map(entry => entry.input_ref), [...common, ...(row.arm === "candidate" ? [`candidate:${version!.id}`] : [])]);
      const [job] = await db`SELECT payload_json FROM jobs WHERE id=${String(row.job_id)}`;
      assert.ok(!JSON.stringify(job!.payload_json).includes(testCase.expected), "trial prompt must not disclose grading expectations");
    }
    const evaluator = (await assigned(db, fixture.workId, "evaluator"))[0]!;
    assert.equal(evaluator.job_id, evaluatorId);
    assert.notEqual(evaluator.job_id, makerId);
    assert.ok((evaluator.input_manifest_json as unknown[]).length >= 12);
    const evaluatorAttempt = await beginJob(db, evaluatorId);
    await db`INSERT INTO project_knowledge_evaluations(project_id,proposal_id,proposal_revision,kind,
      actor_job_id,actor_attempt_id,input_digest,result_json)
      VALUES(${fixture.projectId},${String(proposal!.id)},1,'behavior',${evaluatorId},
        ${evaluatorAttempt},${digest},${db.json({ case_results: [] })})`;
    await db`UPDATE project_knowledge_proposals SET state='review_pending' WHERE id=${String(proposal!.id)}`;
    await db`UPDATE project_knowledge_work SET stage='reviewer' WHERE id=${fixture.workId}`;
    await finishJob(db, scheduler, evaluatorId);
    await scheduler.tick();
    const reviewer = (await assigned(db, fixture.workId, "reviewer"))[0]!;
    assert.notEqual(reviewer.job_id, evaluatorId);
    assert.ok((reviewer.input_manifest_json as unknown[]).length >= 12);
    await finishJob(db, scheduler, String(reviewer.job_id), "orphan");
    const [blocked] = await db`SELECT state,reason FROM project_knowledge_work WHERE id=${fixture.workId}`;
    assert.equal(blocked!.state, "blocked");
    assert.equal(blocked!.reason, "unknown_external_effect");
    assert.equal(await scheduler.tick(), 0);
  });
});

test("concurrent schedulers and a restart do not duplicate an assigned Job", async () => {
  await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    await Promise.all([schedulerFor(db).tick(), schedulerFor(db).tick()]);
    assert.equal((await assigned(db, fixture.workId, "maker")).length, 1);
    assert.equal(await schedulerFor(db).tick(), 0);
    const [work] = await db`SELECT job_count FROM project_knowledge_work WHERE id=${fixture.workId}`;
    assert.equal(work!.job_count, 1);
  });
});

test("restart reconciles an orphan without repeating unknown effects", async () => {
  await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    await schedulerFor(db).tick();
    const maker = (await assigned(db, fixture.workId, "maker"))[0]!;
    // Simulate process loss after the Job terminal commit, before domain advancement.
    await db`UPDATE jobs SET status='orphan',finished_at=now() WHERE id=${String(maker.job_id)}`;
    const restarted = schedulerFor(db);
    await restarted.tick();
    const [work] = await db`SELECT state,reason,active_job_id FROM project_knowledge_work WHERE id=${fixture.workId}`;
    assert.equal(work!.state, "blocked");
    assert.equal(work!.reason, "unknown_external_effect");
    assert.equal(work!.active_job_id, null);
    assert.equal(await schedulerFor(db).tick(), 0);
    assert.equal((await assigned(db, fixture.workId, "maker")).length, 1);
  });
});

test("exhausted work budgets survive restart without creating another Job", async () => {
  for (const budget of ["jobs", "seconds"] as const) await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    await db`UPDATE project_knowledge_work SET job_count=${budget === "jobs" ? 32 : 0},
      run_seconds=${budget === "seconds" ? 1800 : 0} WHERE id=${fixture.workId}`;
    await schedulerFor(db).tick();
    const [work] = await db`SELECT state,reason FROM project_knowledge_work WHERE id=${fixture.workId}`;
    assert.equal(work!.state, "blocked");
    assert.equal(work!.reason, budget === "jobs" ? "job_budget_exhausted" : "work_budget_exhausted");
    assert.equal(await schedulerFor(db).tick(), 0);
    assert.equal((await assigned(db, fixture.workId, "maker")).length, 0);
  });
});

test("knowledge Job timeout stays within the remaining budget and short balances block the work", async () => {
  await withKnowledgeDatabase(async (db) => {
    const scheduler = schedulerFor(db);
    // 获准派发的 Job 超时不得超过余额；余额恰好等于最小可执行预算时仍按余额派发。
    for (const [runSeconds, expected] of [[200, 1600], [1500, 300]] as const) {
      const fixture = await workFixture(db);
      await db`UPDATE project_knowledge_work SET run_seconds=${runSeconds} WHERE id=${fixture.workId}`;
      await scheduler.tick();
      const maker = (await assigned(db, fixture.workId, "maker"))[0]!;
      const [job] = await db`SELECT timeout_sec FROM jobs WHERE id=${String(maker.job_id)}`;
      assert.equal(Number(job!.timeout_sec), expected,
        `run_seconds=${runSeconds} 时 Job 超时不得超过余额 ${expected} 秒`);
    }
    // 余额低于最小可执行预算（#1111 现场的 60/68/88 秒级余额）：显式阻断，不创建 Job/assignment。
    const short = await workFixture(db);
    await db`UPDATE project_knowledge_work SET run_seconds=1700 WHERE id=${short.workId}`;
    await scheduler.tick();
    const [work] = await db`SELECT state,reason,active_job_id FROM project_knowledge_work WHERE id=${short.workId}`;
    assert.equal(work!.state, "blocked");
    assert.equal(work!.reason, "work_budget_exhausted");
    assert.equal(work!.active_job_id, null);
    assert.equal((await assigned(db, short.workId, "maker")).length, 0);
  });
});

test("short-balance admission waits for the active Job instead of unbinding it (upgrade window)", async () => {
  await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    const scheduler = schedulerFor(db);
    await scheduler.tick();
    const maker = (await assigned(db, fixture.workId, "maker"))[0]!;
    // 模拟升级窗口：旧版本已派出短余额 Job，work 余额只剩 100 秒且 Job 正在运行。
    await db`UPDATE project_knowledge_work SET run_seconds=1700 WHERE id=${fixture.workId}`;
    await db`INSERT INTO job_attempts(job_id,attempt_no,status,phase,started_at)
      VALUES(${String(maker.job_id)},1,'active','agent.ready',now() - interval '30 seconds')`;
    await db`UPDATE jobs SET status='running',started_at=now() - interval '30 seconds' WHERE id=${String(maker.job_id)}`;
    await scheduler.tick();
    let [work] = await db`SELECT state,active_job_id,run_seconds FROM project_knowledge_work WHERE id=${fixture.workId}`;
    assert.equal(work!.state, "running", "运行中的旧 Job 不得被最小预算门禁提前解绑");
    assert.equal(String(work!.active_job_id), String(maker.job_id));
    assert.equal(Number(work!.run_seconds), 1700);
    // 终态对账：真实终态（timeout）先记录，耗时只累计一次，之后再不派发新 Job。
    await finishJob(db, scheduler, String(maker.job_id), "timeout");
    [work] = await db`SELECT state,run_seconds,reason,active_job_id FROM project_knowledge_work WHERE id=${fixture.workId}`;
    assert.equal(work!.state, "blocked");
    assert.equal(work!.reason, "job_timeout");
    assert.ok(Number(work!.run_seconds) >= 1730, `耗时应对账累计一次（>=1730），实际 ${String(work!.run_seconds)}`);
    assert.equal(work!.active_job_id, null);
    assert.equal((await assigned(db, fixture.workId, "maker")).length, 1);
  });
});

test("#1132 修订轮 maker 的 prompt 对 create 修订给出「base_refs 必须为空」的权威规则", async () => {
  await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    const scheduler = schedulerFor(db);
    assert.equal(await scheduler.tick(), 1);
    const firstMaker = (await assigned(db, fixture.workId, "maker"))[0]!;
    const firstMakerId = String(firstMaker.job_id);
    const firstAttempt = await beginJob(db, firstMakerId);
    const blob = await writeKnowledgeBlob(db as never, { content: "candidate body for baseline hint" });
    await registerKnowledgeBlob(db as never, blob.hash, blob.bytes);
    const [item] = await db`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,generation)
      VALUES(${fixture.projectId},'memory','base-ref-hint','Base ref hint',3) RETURNING id`;
    const [version] = await db`INSERT INTO project_knowledge_versions
      (project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${fixture.projectId},${String(item!.id)},1,${blob.hash},${firstMakerId},${firstAttempt},${db.json([])},${GOVERNANCE})
      RETURNING id`;
    await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,candidate_version_id,
      maker_job_id,idempotency_key,request_digest,input_digest,base_refs_json,evaluation_plan_json,reason)
      VALUES(${fixture.projectId},${fixture.workId},'create','needs_eval',1,${String(version!.id)},${firstMakerId},
        ${randomUUID()},${"d".repeat(64)},${"d".repeat(64)},${db.json([])},${db.json([])},'fixture')`;
    await finishJob(db, scheduler, firstMakerId);
    await db`UPDATE project_knowledge_work SET stage='maker',state='running',active_job_id=NULL WHERE id=${fixture.workId}`;
    await scheduler.tick();
    const makers = await assigned(db, fixture.workId, "maker");
    assert.equal(makers.length, 2, "needs_eval 之后必须能再派一轮 maker 修订");
    const revisionJobId = String(makers.find((row) => String(row.job_id) !== firstMakerId)!.job_id);
    const [job] = await db`SELECT payload_json FROM jobs WHERE id=${revisionJobId}`;
    const prompt = String((job!.payload_json as { intent?: { prompt?: string } }).intent?.prompt ?? "");
    // create 候选的修订：base_refs 必须为空（与 proposals.ts 的严格校验一致）。
    assert.match(prompt, /base_refs 必须为空数组/);
    assert.match(prompt, /上一提案=/);
  });
});

test("#1134 revise 的提示精确取自上一提案的 base_refs（不会被前 3 项截断），过期基线明确不可行", async () => {
  await withKnowledgeDatabase(async (db) => {
    const fixture = await workFixture(db);
    const scheduler = schedulerFor(db);
    assert.equal(await scheduler.tick(), 1);
    const firstMaker = (await assigned(db, fixture.workId, "maker"))[0]!;
    const firstMakerId = String(firstMaker.job_id);
    const firstAttempt = await beginJob(db, firstMakerId);
    // 四个 active 项：目标基线排在第四位（按 id 排序会被 LIMIT 3 截断）。
    const versions: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const blob = await writeKnowledgeBlob(db as never, { content: `baseline ${n}` });
      await registerKnowledgeBlob(db as never, blob.hash, blob.bytes);
      const [item] = await db`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,generation)
        VALUES(${fixture.projectId},'memory',${`baseline-${n}`},${`Baseline ${n}`},${n}) RETURNING id`;
      const [version] = await db`INSERT INTO project_knowledge_versions
        (project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${fixture.projectId},${String(item!.id)},1,${blob.hash},${firstMakerId},${firstAttempt},${db.json([])},${GOVERNANCE})
        RETURNING id`;
      await db`UPDATE project_knowledge_items SET status='active',active_version_id=${String(version!.id)} WHERE id=${String(item!.id)}`;
      versions.push(String(version!.id));
    }
    const target = versions[3]!;
    const [proposal] = await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,
      candidate_version_id,maker_job_id,idempotency_key,request_digest,input_digest,base_refs_json,evaluation_plan_json,reason)
      VALUES(${fixture.projectId},${fixture.workId},'revise','needs_eval',1,${target},${firstMakerId},
        ${randomUUID()},${"e".repeat(64)},${"e".repeat(64)},${db.json([{ version_ref: target }])},${db.json([])},'fixture')
      RETURNING id`;
    await finishJob(db, scheduler, firstMakerId);
    await db`UPDATE project_knowledge_work SET stage='maker',state='running',active_job_id=NULL WHERE id=${fixture.workId}`;
    await scheduler.tick();
    const makerJobs = await assigned(db, fixture.workId, "maker");
    const revisionJobId = String(makerJobs.find((row) => String(row.job_id) !== firstMakerId)!.job_id);
    const [job] = await db`SELECT payload_json FROM jobs WHERE id=${revisionJobId}`;
    const prompt = String((job!.payload_json as { intent?: { prompt?: string } }).intent?.prompt ?? "");
    assert.match(prompt, /revise 需恰好 1 个 base/);
    assert.ok(prompt.includes(target), "第四位的目标基线必须出现在提示里");
    for (const other of versions.slice(0, 3)) assert.ok(!prompt.includes(other), "不得把非目标基线放进可复制集合");
    // 基线过期（不再是 active）时，提示必须明确不可行，而不是给出替代目录。
    await db`UPDATE project_knowledge_items SET active_version_id=NULL,status='draft' WHERE active_version_id=${target}`;
    await finishJob(db, scheduler, revisionJobId);
    await db`UPDATE project_knowledge_work SET stage='maker',state='running',active_job_id=NULL WHERE id=${fixture.workId}`;
    await db`UPDATE project_knowledge_proposals SET state='needs_eval' WHERE id=${String(proposal!.id)}`;
    await scheduler.tick();
    const third = (await assigned(db, fixture.workId, "maker")).filter((row) => ![firstMakerId, revisionJobId].includes(String(row.job_id)))[0];
    const [thirdJob] = await db`SELECT payload_json FROM jobs WHERE id=${String(third!.job_id)}`;
    const stalePrompt = String((thirdJob!.payload_json as { intent?: { prompt?: string } }).intent?.prompt ?? "");
    assert.match(stalePrompt, /已不是当前 active 版本[\s\S]*本次修订不可行/);
  });
});

test("#1219 旧 project 批次（knowledge:project:）仍会被推进或按既有规则结束", async () => {
  await withKnowledgeDatabase(async (db) => {
    // 同一项目里只要有一条 running 的知识工作就会挡住 pending 认领，所以两条旧批次
    // 分别落在各自项目，才能分别观察「认领推进」与「在途结束」。
    const source = await seedKnowledgeJob(db);
    const inflightSource = await seedKnowledgeJob(db);
    const pendingKey = `knowledge:project:${randomUUID()}`;
    const inflightKey = `knowledge:project:${randomUUID()}`;
    const [pending] = await db`INSERT INTO project_knowledge_work
      (project_id,origin_job_id,canvas_id,trigger_key,input_manifest_json,governance_hash,reason,state,next_attempt_at)
      VALUES(${source.projectId},${source.jobId},${source.canvasId},${pendingKey},${db.json([])},${GOVERNANCE},
        'fixture', 'pending', now() - interval '1 second') RETURNING id`;
    const [inflight] = await db`INSERT INTO project_knowledge_work
      (project_id,origin_job_id,canvas_id,trigger_key,input_manifest_json,governance_hash,reason,state,claim_expires_at)
      VALUES(${inflightSource.projectId},${inflightSource.jobId},${inflightSource.canvasId},${inflightKey},${db.json([])},${GOVERNANCE},
        'fixture', 'running', now() - interval '1 second') RETURNING id`;
    const scheduler = schedulerFor(db);
    await scheduler.tick();
    const [pendingRow] = await db`SELECT state,reason,claim_expires_at FROM project_knowledge_work WHERE id=${String(pending!.id)}`;
    // 旧批次不允许永远停在 pending：要么被认领推进，要么按既有规则结束并留下原因。
    assert.notEqual(pendingRow!.state, "pending", "旧知识批次不得永久停留在 pending");
    const [inflightRow] = await db`SELECT state,reason,active_job_id FROM project_knowledge_work WHERE id=${String(inflight!.id)}`;
    assert.ok(["running", "blocked", "completed"].includes(String(inflightRow!.state)), "在途旧批次必须有明确状态");
    if (inflightRow!.state === "blocked") assert.equal(typeof inflightRow!.reason, "string", "结束必须留下原因");
    // 同一 trigger_key 不得被重复认领成第二条工作。
    const duplicates = await db`SELECT trigger_key, count(*)::int AS count FROM project_knowledge_work
      WHERE project_id IN (${source.projectId}, ${inflightSource.projectId})
        AND trigger_key IN (${pendingKey}, ${inflightKey}) GROUP BY 1`;
    assert.deepEqual(duplicates.map((row) => Number(row.count)), [1, 1], "旧批次不得被重复认领");
    // 历史仍可查：行本身与 trigger_key 保留，归档的 knowledge:auto: 准备行不会被重新激活。
    const history = await db`SELECT count(*)::int AS count FROM project_knowledge_work
      WHERE project_id IN (${source.projectId}, ${inflightSource.projectId})
        AND trigger_key IN (${pendingKey}, ${inflightKey})`;
    assert.equal(Number(history[0]!.count), 2, "旧批次历史必须仍可查询");
  });
});
