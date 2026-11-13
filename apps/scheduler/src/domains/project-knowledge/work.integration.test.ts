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
  status: "succeeded" | "orphan" = "succeeded") {
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
