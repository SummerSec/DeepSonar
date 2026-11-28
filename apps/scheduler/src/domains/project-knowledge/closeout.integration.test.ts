import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { TASK_KNOWLEDGE_SUGGESTION_OPERATION as operation } from "@deepsonar/shared-types";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { hashJobSnapshot } from "../platform-api/tokens.js";
import { registerProjectKnowledgeRoutes } from "./routes.js";
import { submitTaskKnowledgeSuggestion } from "./closeout-intake.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

test("task suggestions are private, attributable, idempotent and readable without dispatch", async () => {
  await withKnowledgeDatabase(async db => {
    const owner = await seedKnowledgeJob(db, undefined, [operation]);
    const other = await seedKnowledgeJob(db);
    const rootId = randomUUID(), factId = randomUUID(), tokenId = randomUUID(), eventId = randomUUID();
    const [{ agent_snapshot_json: snapshot }] = await db`SELECT agent_snapshot_json FROM jobs WHERE id=${owner.jobId}`;
    await db`INSERT INTO job_capability_tokens(id,job_id,project_id,canvas_id,role_name,snapshot_sha256,token_prefix,token_hash,operation_ids,expires_at)
      VALUES(${tokenId},${owner.jobId},${owner.projectId},${owner.canvasId},'fixture',${hashJobSnapshot(snapshot)},${tokenId},'test',${[operation]},now()+interval '1 hour')`;
    await db`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status) VALUES(${rootId},${owner.canvasId},'root','Task','running')`;
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,verification_status)
      VALUES(${factId},${owner.canvasId},${owner.jobId},'fact','Measured result','unverified')`;
    await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type) VALUES(${owner.jobId},${eventId},1,${owner.attemptId},'fact')`;
    await db`INSERT INTO artifacts(project_id,canvas_id,job_id,node_id,artifact_key,kind,source_event_id,source_operation)
      VALUES(${owner.projectId},${owner.canvasId},${owner.jobId},${factId},'sample','fact',${eventId},'emit_fact')`;
    const secondFactId = randomUUID(), secondEventId = randomUUID();
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,verification_status)
      VALUES(${secondFactId},${owner.canvasId},${owner.jobId},'fact','Independent observation','unverified')`;
    await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type)
      VALUES(${owner.jobId},${secondEventId},2,${owner.attemptId},'fact')`;
    await db`INSERT INTO artifacts(project_id,canvas_id,job_id,node_id,artifact_key,kind,source_event_id,source_operation)
      VALUES(${owner.projectId},${owner.canvasId},${owner.jobId},${secondFactId},'another-sample','fact',${secondEventId},'emit_fact')`;
    const blobs = new Map<string, Buffer>();
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async key => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async key => blobs.has(key), materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    const app = Fastify();
    let scopes = ["projects:read", "tasks:read"];
    let actorName = "reader";
    app.addHook("onRequest", async request => {
      request.actor = { type: "api_token", id: tokenId, name: actorName, projectId: owner.projectId, scopes };
    });
    registerProjectKnowledgeRoutes(app, { db });
    const item = { kind: "memory", title: "Result", scope: "Known fixture", content: "Useful measurement", evidence_refs: [{ kind: "fact", ref: factId }] };
    const secondItem = { ...item, kind: "skill", title: "Independent result", content: "Another observation", evidence_refs: [{ kind: "fact", ref: secondFactId }] };
    const context = { ...owner, tokenId, operationId: operation, eventId: randomUUID(), idempotencyKey: randomUUID(), input: { result: "suggestions", items: [item, secondItem] } };
    const runtime = { attemptId: owner.attemptId, secrets: ["fixture-secret-value"] };
    const submit = (request = context, origin = runtime) => submitTaskKnowledgeSuggestion(request, db, origin);
    try {
      await assert.rejects(submit({ ...context, input: { ...context.input, items: [{ ...item, content: runtime.secrets[0]! }] } }), { error_code: "KNOWLEDGE_SUGGESTION_SECRET" });
      await assert.rejects(submit({ ...context, input: { ...context.input, items: [{ ...item, evidence_refs: [{ kind: "fact", ref: other.jobId }] }] } }), { error_code: "KNOWLEDGE_SCOPE_DENIED" });
      await assert.rejects(submit(context, { ...runtime, attemptId: other.attemptId }), { error_code: "KNOWLEDGE_SCOPE_DENIED" });
      assert.equal(blobs.size, 0);
      const receipt = await submit();
      assert.deepEqual(await submit(), receipt);
      await assert.rejects(submit({ ...context, input: { result: "no_new", items: [] } }), { error_code: "KNOWLEDGE_IDEMPOTENCY_CONFLICT" });
      await assert.rejects(submit({ ...context, idempotencyKey: randomUUID() }), { error_code: "KNOWLEDGE_SUGGESTION_ALREADY_ACCEPTED" });
      const [metadata] = await db`SELECT payload_json FROM events WHERE job_id=${owner.jobId} AND type='control_receipt'`;
      assert.ok(!JSON.stringify(metadata).includes(item.content));
      await db`UPDATE jobs SET status='succeeded' WHERE id=${owner.jobId}`;
      await db`UPDATE job_attempts SET status='succeeded',finished_at=now() WHERE id=${owner.attemptId}`;
      await db`UPDATE canvas_nodes SET status='succeeded' WHERE id=${rootId}`;
      const path = `/projects/${owner.projectId}/knowledge`;
      const [stored] = await db`SELECT id,result_json FROM project_knowledge_receipts WHERE job_id=${owner.jobId}`;
      assert.ok(stored);
      assert.equal(stored.result_json.session_id, `session-${owner.jobId}`);
      assert.match(stored.result_json.blob_hash, /^[a-f0-9]{64}$/);
      assert.equal(stored.result_json.fingerprints.length, 2);
      scopes = ["projects:read"];
      const list = await app.inject({ url: `${path}/receipts?job_id=${owner.jobId}` });
      const detail = await app.inject({ url: `${path}/receipts/${stored.id}` });
      assert.equal(list.statusCode, 200);
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(list.json().items.map((row: { result_json: unknown }) => row.result_json), [receipt]);
      assert.deepEqual(detail.json().result_json, receipt);
      scopes = ["projects:read", "tasks:read"];
      // #1219 第四阶段第 3 步后仍保留只读历史入口：批量整理已下线，但历史沉淀
      // 必须查得到，且查询本身不得触发任何整理或写入。
      await db`INSERT INTO audit_logs (actor_type, actor_id, action, project_id, resource_type, resource_id)
        SELECT 'system', 'scheduler', 'project_knowledge.source_registered', ${owner.projectId},
          'job', id::text FROM jobs WHERE id=${owner.jobId}`;
      // GET 自身会写一条请求审计，所以「不产生写入」的判据是：不新增整理工作、
      // 不新增采集/跳过审计（而不是审计总行数不变）。
      const workBefore = (await db`SELECT count(*)::int AS count FROM project_knowledge_work`)[0]!.count;
      const history = await app.inject({ url: `${path}/backfill` });
      assert.equal(history.statusCode, 200, history.body);
      const historyBody = history.json() as { items: Array<Record<string, unknown>> };
      const historyRow = historyBody.items.find((row) => row.job_id === owner.jobId);
      assert.ok(historyRow, "历史入口必须列出该任务步骤");
      const historyFacts = (historyRow as { history: { registered_at: unknown; collected_at: unknown;
        skipped_at: unknown; collection: unknown } }).history;
      assert.equal(typeof historyFacts.registered_at, "string", "登记时间必须可查");
      assert.equal(historyFacts.collected_at, null);
      assert.equal(historyFacts.skipped_at, null);
      assert.equal(historyFacts.collection, "retired");
      assert.equal(historyRow!.status, "registered_retired",
        "仅登记未处理的旧来源必须给出「旧批量整理已下线」的明确结论，不能永久显示待整理");
      // 旧 source-retry 的跳过写入是 result='error'：这些记录必须照旧读出跳过状态。
      await db`INSERT INTO audit_logs (actor_type, actor_id, action, project_id, resource_type, resource_id, result, after_json)
        SELECT 'system', 'scheduler', 'project_knowledge.source_collection_skipped', ${owner.projectId},
          'job', id::text, 'error', ${db.json({ reason: "source_collection_retry_exhausted" } as never)}
        FROM jobs WHERE id=${owner.jobId}`;
      const rowOf = (body: string) => (JSON.parse(body) as { items: Array<Record<string, unknown>> }).items
        .find((row) => row.job_id === owner.jobId) as { status: string; reason?: string;
          history: { skipped_at: unknown } } | undefined;
      const skippedResponse = await app.inject({ url: `${path}/backfill` });
      assert.equal(skippedResponse.statusCode, 200, skippedResponse.body);
      const skippedRow = rowOf(skippedResponse.body)!;
      assert.equal(skippedRow.status, "skipped", "旧 result='error' 的跳过记录必须照旧识别");
      assert.equal(skippedRow.reason, "source_collection_retry_exhausted", "标准原因码照旧返回");
      assert.equal(typeof skippedRow.history.skipped_at, "string", "跳过时间必须可查");
      // 任意历史原因文本都不得从接口返回；只有标准代码可读（取最近一条，命中即过滤）。
      await db`INSERT INTO audit_logs (actor_type, actor_id, action, project_id, resource_type, resource_id, result, after_json)
        SELECT 'system', 'scheduler', 'project_knowledge.source_collection_skipped', ${owner.projectId},
          'job', id::text, 'error', ${db.json({ reason: "prompt 里的任意文本 SYNTHETIC-LEAK" } as never)}
        FROM jobs WHERE id=${owner.jobId}`;
      // 快照放在写入跳过审计之后：只判定「查询本身」不再新增采集/跳过审计。
      const collectBefore = (await db`SELECT count(*)::int AS count FROM audit_logs
        WHERE action IN ('project_knowledge.source_collected','project_knowledge.source_collection_skipped')`)[0]!.count;
      const filtered = await app.inject({ url: `${path}/backfill` });
      assert.equal(filtered.statusCode, 200, filtered.body);
      assert.doesNotMatch(filtered.body, /SYNTHETIC-LEAK/, "原始跳过原因不得进入只读历史响应");
      assert.equal(rowOf(filtered.body)!.status, "skipped", "跳过状态与原因过滤互不影响");
      assert.equal((await db`SELECT count(*)::int AS count FROM project_knowledge_work`)[0]!.count, workBefore,
        "只读历史查询不得创建整理工作");
      assert.equal((await db`SELECT count(*)::int AS count FROM audit_logs
        WHERE action IN ('project_knowledge.source_collected','project_knowledge.source_collection_skipped')`)[0]!.count,
        collectBefore, "只读历史查询不得触发采集或跳过审计");
      // 评审 r5：三类记录必须分开——没有旧回执 / 真写过 no_sources / 重试耗尽。
      const seedHistoryJob = async () => {
        const [row] = await db`INSERT INTO jobs (project_id, canvas_id, type, status, finished_at)
          VALUES (${owner.projectId}, ${owner.canvasId}, 'explore', 'succeeded', now()) RETURNING id`;
        return String(row.id);
      };
      const noReceiptJob = await seedHistoryJob();
      const noSourcesJob = await seedHistoryJob();
      const retryExhaustedJob = await seedHistoryJob();
      const seedSkip = async (target: string, reason: string, result: string) => {
        await db`INSERT INTO audit_logs (project_id, actor_type, actor_id, action, resource_type, resource_id, result, after_json)
          VALUES (${owner.projectId}, 'system', 'scheduler', 'project_knowledge.source_collection_skipped', 'job', ${target},
            ${result}, ${db.json({ reason } as never)})`;
      };
      await seedSkip(noSourcesJob, "no_sources", "ok");
      await seedSkip(retryExhaustedJob, "source_collection_retry_exhausted", "error");
      const threeBody = await app.inject({ url: `${path}/backfill?limit=20` });
      assert.equal(threeBody.statusCode, 200, threeBody.body);
      type HistoryRow = { job_id: string; status: string; reason?: string; history: { collection: string } };
      const threeRows = new Map<string, HistoryRow>(
        threeBody.json<{ items: HistoryRow[] }>().items.map((row) => [row.job_id, row]));
      assert.equal(threeRows.get(noReceiptJob)?.history.collection, "none",
        "没有旧回执不得伪造成 skipped/no_sources");
      assert.equal(threeRows.get(noReceiptJob)?.status, "no_history");
      assert.equal(threeRows.get(noSourcesJob)?.reason, "no_sources", "真的写过 no_sources 才回该原因");
      assert.equal(threeRows.get(retryExhaustedJob)?.reason, "source_collection_retry_exhausted",
        "重试耗尽必须与「没有来源」分开");

      const [{ count }] = await db`SELECT count(*)::int AS count FROM project_knowledge_work`;
      assert.equal(count, 0);
      assert.equal((await db`SELECT id FROM canvas_nodes WHERE node_type='knowledge_closeout'`).length, 0);
      await db`INSERT INTO canvas_nodes(canvas_id,node_type,title,body_json)
        VALUES(${owner.canvasId},'knowledge_closeout','Knowledge',${db.json({ root_node_id: rootId, state: "suggestions_available" })})`;
      const url = `${path}/closeout/${rootId}`;
      const read = await app.inject({ url });
      assert.equal(read.statusCode, 200);
      const [memory, skill] = read.json().items;
      assert.deepEqual(read.json().items.map(({ candidate_ref, ...value }: Record<string, unknown>) => {
        assert.match(String(candidate_ref), /^[a-f0-9]{64}$/);
        return value;
      }), [item, secondItem]);
      assert.equal(read.json().can_evaluate, false);
      const send = (ref: string) => app.inject({ method: "POST", url: `${url}/evaluate`, payload: { candidate_ref: ref } });
      assert.equal((await send(memory.candidate_ref)).statusCode, 403);
      scopes = ["projects:read", "tasks:read", "projects:write"];
      const [first, repeat] = await Promise.all([send(memory.candidate_ref), send(memory.candidate_ref)]);
      assert.equal(first.statusCode, 202, first.body);
      assert.equal(repeat.statusCode, 202, repeat.body);
      assert.deepEqual(first.json(), repeat.json());
      const concurrentAudits = await db`SELECT after_json FROM audit_logs WHERE project_id=${owner.projectId}
        AND action='project_knowledge.closeout_evaluation_requested' AND resource_id=${first.json().work_ref}`;
      assert.deepEqual(concurrentAudits.map(row => row.after_json.reused).sort(), [false, true]);
      actorName = "repeat-reader";
      const reused = await send(memory.candidate_ref);
      assert.equal(reused.statusCode, 202, reused.body);
      assert.deepEqual(reused.json(), first.json());
      const repeatedAudits = await db`SELECT actor_type,actor_id,request_id,result,after_json FROM audit_logs
        WHERE project_id=${owner.projectId} AND action='project_knowledge.closeout_evaluation_requested'
          AND resource_id=${first.json().work_ref}`;
      assert.equal(repeatedAudits.length, 3);
      assert.equal(new Set(repeatedAudits.map(row => row.request_id)).size, 3);
      const repeatActorAudit = repeatedAudits.find(row => row.actor_id === actorName);
      assert.ok(repeatActorAudit);
      assert.equal(repeatActorAudit.actor_type, "api_token");
      assert.equal(repeatActorAudit.result, "ok");
      assert.deepEqual(repeatActorAudit.after_json, { root_id: rootId, candidate_ref: memory.candidate_ref, reused: true });
      assert.ok(!JSON.stringify(repeatedAudits).includes(item.content));
      actorName = "reader";
      const skillWork = await send(skill.candidate_ref);
      assert.equal(skillWork.statusCode, 202, skillWork.body);
      assert.notEqual(skillWork.json().work_ref, first.json().work_ref);
      assert.equal((await db`SELECT id FROM project_knowledge_work WHERE project_id=${owner.projectId}`).length, 2);
      const queued = (await app.inject({ url })).json();
      assert.equal(queued.can_evaluate, true);
      assert.deepEqual(queued.items.map((row: {evaluation: unknown}) => row.evaluation), [
        { work_ref: first.json().work_ref, status: "queued" }, { work_ref: skillWork.json().work_ref, status: "queued" },
      ]);
      await db`UPDATE project_knowledge_work SET state='blocked',reason='closeout_source_unavailable'
        WHERE id=${first.json().work_ref}`;
      await db`UPDATE artifacts SET status='superseded',superseded_at=now() WHERE node_id=${factId}`;
      scopes = ["projects:read"];
      assert.deepEqual((await app.inject({ url })).json(), { status: "restricted", items: [], next_offset: null });
      const activity = await app.inject({ url: `${path}/activity` });
      assert.equal(activity.statusCode, 200, activity.body);
      assert.deepEqual(activity.json().items, []);
      assert.equal(activity.json().summary.blocked_work, 0);
      assert.ok(!activity.body.includes(owner.canvasId));
      scopes = ["projects:read", "tasks:read", "projects:write"];
      assert.deepEqual((await app.inject({ url })).json(), {
        status: "restricted", items: [], next_offset: null, evaluation_source_unavailable: true,
      });
      assert.equal((await send(memory.candidate_ref)).statusCode, 409);
    } finally {
      await app.close();
      setSharedAssetBlobStoreForTests(null);
    }
  });
});
