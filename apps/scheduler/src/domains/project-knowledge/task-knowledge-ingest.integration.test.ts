import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { TASK_KNOWLEDGE_SUGGESTION_OPERATION as operation } from "@deepsonar/shared-types";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { hashJobSnapshot } from "../platform-api/tokens.js";
import { submitTaskKnowledgeSuggestion } from "./closeout-intake.js";
import { taskKnowledgeLogicalKey } from "./task-knowledge-ingest.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { createProjectKnowledgeApplication } from "./application.js";
import { readNextKnowledgeWake } from "../../knowledge-wake.js";
import { collectProjectKnowledgeSources } from "./collector.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

const H = "f".repeat(64);

/** 每个 Job 都建真实的 fact 证据：入库前的来源校验要求同 Job、同 Attempt 的节点/产物/事件都在。 */
async function seedFact(db: never, job: { jobId: string; canvasId: string; attemptId: string }, seq: number) {
  const nodeId = randomUUID(), eventId = randomUUID();
  const sql = db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
  await sql`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status) VALUES(${randomUUID()},${job.canvasId},'root','Task','running')`;
  await sql`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,verification_status)
    VALUES(${nodeId},${job.canvasId},${job.jobId},'fact','Measured','unverified')`;
  await sql`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type) VALUES(${job.jobId},${eventId},${seq},${job.attemptId},'fact')`;
  await sql`INSERT INTO artifacts(project_id,canvas_id,job_id,node_id,artifact_key,kind,source_event_id,source_operation)
    SELECT project_id, ${job.canvasId}, ${job.jobId}, ${nodeId}, ${`fact-${seq}`}, 'fact', ${eventId}, 'emit_fact' FROM jobs WHERE id=${job.jobId}`;
  return nodeId;
}

async function submit(
  db: never, job: { jobId: string; projectId: string; canvasId: string; attemptId: string },
  item: { title: string; content: string; factRef: string; scope?: string; target?: { usage_ref: string } }, key = randomUUID(),
) {
  const sql = db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
  const tokenId = randomUUID();
  // 投稿要求 Job 快照自己列出该操作；这里不修改快照（改写会让冻结身份与读到的字节不一致），
  // 由调用方在 seed 时就把需要的 tool 写进去。
  const [row] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${job.jobId}`;
  await sql`INSERT INTO job_capability_tokens(id,job_id,project_id,canvas_id,role_name,snapshot_sha256,token_prefix,token_hash,operation_ids,expires_at)
    VALUES(${tokenId},${job.jobId},${job.projectId},${job.canvasId},'fixture',${hashJobSnapshot(row!.agent_snapshot_json)},${tokenId},'test',${[operation]},now()+interval '1 hour')`;
  return submitTaskKnowledgeSuggestion({
    jobId: job.jobId, projectId: job.projectId, canvasId: job.canvasId, tokenId, operationId: operation,
    eventId: randomUUID(), idempotencyKey: key,
    input: { result: "suggestions", items: [{ kind: "memory", title: item.title, scope: item.scope ?? "fixture scope",
      content: item.content, evidence_refs: [{ kind: "fact", ref: item.factRef }], ...(item.target ? { target: item.target } : {}) }] },
  } as never, db, { attemptId: job.attemptId, secrets: ["fixture-secret-value"] });
}

test("task knowledge ingestion is retrievable across tasks, project-scoped and lifecycle-safe", async () => {
  await withKnowledgeDatabase(async db => {
    const blobs = new Map<string, Buffer>();
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async key => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async key => blobs.has(key), materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    const app = createProjectKnowledgeApplication({ db: db as never, governanceHash: H });
    try {
      const writer = await seedKnowledgeJob(db, undefined, [operation]);
      const frozenBefore = await seedKnowledgeJob(db, writer.projectId, ["search_project_knowledge"]);
      const beforeCatalog = await freezeProjectKnowledgeCatalog(db as never, writer.projectId);
      const sql = db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
      await sql`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["search_project_knowledge"],
        project_knowledge_catalog: beforeCatalog } as never)} WHERE id=${frozenBefore.jobId}`;

      const fact = await seedFact(db as never, writer, 1);
      const receipt = await submit(db as never, writer, { title: "构建要先升 SDK", content: "先升 SDK 再打包", factRef: fact });
      assert.equal(receipt.accepted, true);
      const [item] = await sql`SELECT id, status, active_version_id, logical_key FROM project_knowledge_items
        WHERE project_id=${writer.projectId}`;
      assert.equal(item!.status, "active");
      assert.match(String(item!.logical_key), /^task\/[a-z0-9-]+$/u);

      // 冻结在入库之前的任务看不到；入库之后创建的任务能搜索并读取。
      const stale = await app.invoke({ jobId: frozenBefore.jobId, projectId: writer.projectId, canvasId: frozenBefore.canvasId,
        operationId: "search_project_knowledge", input: { query: "构建" }, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null });
      assert.deepEqual(stale.items, [], "a job frozen before ingestion must not see it");
      const reader = await seedKnowledgeJob(db, writer.projectId, ["search_project_knowledge", "read_project_knowledge", operation]);
      const catalog = await freezeProjectKnowledgeCatalog(db as never, writer.projectId);
      await sql`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["search_project_knowledge", "read_project_knowledge", operation],
        project_knowledge_catalog: catalog } as never)} WHERE id=${reader.jobId}`;
      const found = await app.invoke({ jobId: reader.jobId, projectId: writer.projectId, canvasId: reader.canvasId,
        operationId: "search_project_knowledge", input: { query: "构建" }, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null });
      assert.equal((found.items as unknown[]).length, 1, JSON.stringify(found));
      const read = await app.invoke({ jobId: reader.jobId, projectId: writer.projectId, canvasId: reader.canvasId,
        operationId: "read_project_knowledge", input: { item_ref: String(item!.id), version: 1,
          expected_hash: String((found.items as Array<{ hash: string }>)[0].hash) }, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null });
      assert.equal(read.content, "先升 SDK 再打包");
      assert.equal(typeof read.usage_ref, "string");

      // 显式修订：基线一致时追加版本，标题变化也仍落在同一条目。
      const readerFact = await seedFact(db as never, reader, 2);
      const revised = await submit(db as never, reader, { title: "构建要先升 SDK（修订）", content: "改为先升级工具链",
        factRef: readerFact, target: { usage_ref: String(read.usage_ref) } });
      assert.equal(revised.accepted, true);
      const [{ count: itemCount }] = await sql`SELECT count(*)::int AS count FROM project_knowledge_items WHERE project_id=${writer.projectId}`;
      assert.equal(Number(itemCount), 1, "a revision with a changed title must stay on the same item");
      const [afterRevise] = await sql`SELECT status, active_version_id FROM project_knowledge_items WHERE id=${item!.id}`;
      assert.equal(afterRevise!.status, "active");
      const versions = await sql`SELECT version FROM project_knowledge_versions WHERE item_id=${item!.id} ORDER BY version`;
      assert.deepEqual(versions.map(row => Number(row.version)), [1, 2]);

      // 同一旧基线被另一个任务再次修订：基线已被取代，必须拒绝而不是覆盖当前版本。
      const rival = await seedKnowledgeJob(db, writer.projectId, ["read_project_knowledge", "search_project_knowledge", operation]);
      await sql`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["read_project_knowledge", "search_project_knowledge", operation],
        project_knowledge_catalog: catalog } as never)} WHERE id=${rival.jobId}`;
      const rivalFact = await seedFact(db as never, rival, 3);
      const stale1 = await app.invoke({ jobId: rival.jobId, projectId: writer.projectId, canvasId: rival.canvasId,
        operationId: "read_project_knowledge", input: { item_ref: String(item!.id), version: 1,
          expected_hash: String((found.items as Array<{ hash: string }>)[0].hash) }, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null });
      await assert.rejects(submit(db as never, rival, { title: "构建要先升 SDK", content: "基于旧基线的另一份修订",
        factRef: rivalFact, target: { usage_ref: String(stale1.usage_ref) } }),
      (error: { error_code?: string; message: string }) => {
        assert.match(error.message, /target version is unavailable/u);
        return true;
      }, "a baseline superseded by a newer version must not be revisable");
      const versionsAfterRival = await sql`SELECT version FROM project_knowledge_versions WHERE item_id=${item!.id} ORDER BY version`;
      assert.deepEqual(versionsAfterRival.map(row => Number(row.version)), [1, 2]);

      // 撤销后同名投稿不复活，也不追加版本。
      await sql`UPDATE project_knowledge_items SET status='revoked' WHERE id=${item!.id}`;
      const after = await seedKnowledgeJob(db, writer.projectId, [operation]);
      const afterFact = await seedFact(db as never, after, 4);
      const revived = await submit(db as never, after, { title: "构建要先升 SDK", content: "换了写法的同标题内容", factRef: afterFact });
      assert.equal(revived.accepted, true);
      const [revokedItem] = await sql`SELECT status FROM project_knowledge_items WHERE id=${item!.id}`;
      assert.equal(revokedItem!.status, "revoked");
      const [{ count: versionCount }] = await sql`SELECT count(*)::int AS count FROM project_knowledge_versions WHERE item_id=${item!.id}`;
      assert.equal(Number(versionCount), 2, "no version is appended to a revoked item");

      // 其他项目的目录里看不到这条知识。
      const otherProject = await freezeProjectKnowledgeCatalog(db as never, (await seedKnowledgeJob(db)).projectId);
      assert.equal(otherProject.entries.some(entry => entry.item_id === String(item!.id)), false);

      // 并发同名投稿：各自有真实证据，最终只留一条条目。
      const [first, second] = await Promise.all([seedKnowledgeJob(db, writer.projectId, [operation]),
        seedKnowledgeJob(db, writer.projectId, [operation])]);
      const [firstFact, secondFact] = await Promise.all([seedFact(db as never, first, 5), seedFact(db as never, second, 6)]);
      const [r1, r2] = await Promise.all([
        submit(db as never, first, { title: "并发同名沉淀", content: "来自任务 A", factRef: firstFact }),
        submit(db as never, second, { title: "并发同名沉淀", content: "来自任务 B", factRef: secondFact }),
      ]);
      assert.equal(r1.accepted, true);
      assert.equal(r2.accepted, true);
      const [{ count: sameTitle }] = await sql`SELECT count(*)::int AS count FROM project_knowledge_items
        WHERE project_id=${writer.projectId} AND logical_key=${taskKnowledgeLogicalKey("并发同名沉淀")}`;
      assert.equal(Number(sameTitle), 1, "concurrent same-title submissions converge on one item");
    } finally {
      setSharedAssetBlobStoreForTests(null);
    }
  });
});

test("restricted closeout versions stay hidden in the same project and queued work still wakes", async () => {
  await withKnowledgeDatabase(async db => {
    const blobs = new Map<string, Buffer>();
    setSharedAssetBlobStoreForTests({ kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async key => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async key => blobs.has(key), materializeLocal: async () => { throw new Error("unused"); } });
    const app = createProjectKnowledgeApplication({ db: db as never, governanceHash: H });
    const sql = db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
    const writer = await seedKnowledgeJob(db, undefined, [operation]);
    const fact = await seedFact(db as never, writer, 1);
    const receipt = await submit(db as never, writer, { title: "受控来源样例", content: "只应给有权者看", factRef: fact });
    assert.equal(receipt.accepted, true);
    const [item] = await sql`SELECT id, active_version_id FROM project_knowledge_items WHERE project_id=${writer.projectId}`;
    // 把这条已入库的版本标成「任务沉淀送评的私有版本」。
    const [work] = await sql`INSERT INTO project_knowledge_work(project_id,origin_job_id,trigger_key,governance_hash,state)
      VALUES(${writer.projectId},${writer.jobId},${"knowledge:closeout-evaluation:fixture-1"},${H},'running') RETURNING id`;
    await sql`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,candidate_version_id,
      maker_job_id,idempotency_key,request_digest,input_digest,reason)
      VALUES(${writer.projectId},${work!.id},'create','candidate',1,${item!.active_version_id},${writer.jobId},
      ${randomUUID()},${H},${H},'fixture')`;
    const reader = await seedKnowledgeJob(db, writer.projectId, ["search_project_knowledge", "read_project_knowledge"]);
    const catalog = await freezeProjectKnowledgeCatalog(db as never, writer.projectId);
    await sql`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["search_project_knowledge", "read_project_knowledge"],
      project_knowledge_catalog: catalog } as never)} WHERE id=${reader.jobId}`;
    const found = await app.invoke({ jobId: reader.jobId, projectId: writer.projectId, canvasId: reader.canvasId,
      operationId: "search_project_knowledge", input: { query: "受控" }, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null });
    assert.deepEqual(found.items, [], "受限来源不能出现在同项目的检索结果里");
    // 切换前登记的来源：走真实 collector 入口处理一次，证明旧路径仍能把积压收尾。
    // 先把上面那条 running 的私有 work 收尾：同一项目只允许一条 running。
    await sql`UPDATE project_knowledge_work SET state='completed' WHERE id=${work!.id}`;
    await sql`UPDATE jobs SET status='succeeded',
      agent_snapshot_json=${db.json({ platform_tools: ["request_project_knowledge"] } as never)} WHERE id=${writer.jobId}`;
    await sql`UPDATE job_attempts SET status='succeeded', phase='terminal' WHERE job_id=${writer.jobId}`;
    await sql`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,at)
      VALUES('system','scheduler','project_knowledge.source_registered',${writer.projectId},'job',${writer.jobId},'ok',now()-interval '30 days')`;
    const created = await collectProjectKnowledgeSources(db as never, H);
    assert.equal(typeof created, "number", "collector 入口返回处理数");
    const [collected] = await sql`SELECT id FROM audit_logs WHERE project_id=${writer.projectId}
      AND resource_id=${writer.jobId} AND action IN ('project_knowledge.source_collected','project_knowledge.source_collection_skipped')`;
    assert.ok(collected, "切换前登记的来源必须被 collector 收尾（纳入整理或明确跳过）");
    const [stillRegistered] = await sql`SELECT id FROM audit_logs WHERE project_id=${writer.projectId}
      AND resource_id=${writer.jobId} AND action='project_knowledge.source_registered'`;
    assert.ok(stillRegistered, "历史登记审计必须保持可查");
    // 切换后排队的工作仍有唤醒时间。
    await sql`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state,next_attempt_at)
      VALUES(${writer.projectId},${"knowledge:collect:fixture-2"},${H},'pending',now())`;
    const wake = await readNextKnowledgeWake(db as never);
    assert.ok(wake instanceof Date && Number.isFinite(wake.getTime()), "在途/排队的知识工作仍应有唤醒时间");
  });
});

test("published versions resolve source authorization from the original governance manifest", async () => {
  await withKnowledgeDatabase(async db => {
    const sql = db as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
    const app = createProjectKnowledgeApplication({ db: db as never, governanceHash: H });
    const owner = await seedKnowledgeJob(db, undefined, [operation]);
    // 真实的 artifact_evidence 形状：artifacts(job) + artifact_evidence(row)，引用就是这个 row 的 id。
    const governance = await seedKnowledgeJob(db, owner.projectId, [operation]);
    const [artifact] = await sql`INSERT INTO artifacts (id, project_id, job_id, artifact_key, kind, source_operation)
      VALUES (gen_random_uuid(), ${owner.projectId}, ${governance.jobId}, 'governed-evidence', 'fact', 'emit_fact') RETURNING id`;
    const [evidence] = await sql`INSERT INTO artifact_evidence (id, artifact_id, statement, kind)
      VALUES (gen_random_uuid(), ${String(artifact?.id)}, '治理资料里的观测', 'observation') RETURNING id`;
    const evidenceId = String(evidence?.id), sourceHash = "a".repeat(64);
    await sql`INSERT INTO shared_asset_blobs (content_sha256, bytes, content_type, blob_uri)
      VALUES (${"c".repeat(64)}, 64, 'application/json', ${"test://cc"})`;
    const [item] = await sql`INSERT INTO project_knowledge_items (id, project_id, kind, logical_key, title)
      VALUES (gen_random_uuid(), ${owner.projectId}, 'memory', 'governed-source', '治理来源知识') RETURNING id`;
    const [version] = await sql`INSERT INTO project_knowledge_versions (id, project_id, item_id, version, content_sha256,
      creator_job_id, creator_attempt_id, sources_json, governance_hash)
      VALUES (gen_random_uuid(), ${owner.projectId}, ${String(item?.id)}, 1, ${"c".repeat(64)}, ${governance.jobId},
        ${governance.attemptId}, ${db.json([{ kind: "evidence", ref: evidenceId, content_hash: sourceHash }] as never)},
        ${"c".repeat(64)}) RETURNING id`;
    await sql`UPDATE project_knowledge_items SET active_version_id=${String(version?.id)}, status='active'
      WHERE id=${String(item?.id)}`;
    const [work] = await sql`INSERT INTO project_knowledge_work (project_id, trigger_key, state, stage, governance_hash)
      VALUES (${owner.projectId}, ${"knowledge:collect:" + governance.jobId}, 'completed', 'settle', ${"d".repeat(64)})
      RETURNING id`;
    await sql`INSERT INTO project_knowledge_job_assignments (job_id, project_id, work_id, stage)
      VALUES (${governance.jobId}, ${owner.projectId}, ${String(work?.id)}, 'maker')`;
    const catalog = await freezeProjectKnowledgeCatalog(db as never, owner.projectId);
    const search = async (job: { jobId: string; canvasId: string }) => {
      await sql`UPDATE jobs SET agent_snapshot_json=${db.json({
        platform_tools: ["search_project_knowledge"], project_knowledge_catalog: catalog } as never)} WHERE id=${job.jobId}`;
      return app.invoke({ jobId: job.jobId, projectId: owner.projectId, canvasId: job.canvasId,
        operationId: "search_project_knowledge", input: { query: "治理" }, eventId: randomUUID(),
        tokenId: randomUUID(), idempotencyKey: null });
    };
    const ordinary = await seedKnowledgeJob(db, owner.projectId, ["search_project_knowledge"]);
    assert.deepEqual(((await search(ordinary)).items as unknown[]).length, 0, "无权的同项目任务看不到治理来源条目");
    const assign = async (stage: string, manifest: unknown[]) => {
      const reader = await seedKnowledgeJob(db, owner.projectId, ["search_project_knowledge"]);
      const [readerWork] = await sql`INSERT INTO project_knowledge_work (project_id, trigger_key, state, stage, governance_hash)
        VALUES (${owner.projectId}, ${"knowledge:collect:" + reader.jobId}, 'completed', 'settle', ${"e".repeat(64)}) RETURNING id`;
      await sql`INSERT INTO project_knowledge_job_assignments (job_id, project_id, work_id, stage, input_manifest_json)
        VALUES (${reader.jobId}, ${owner.projectId}, ${String(readerWork?.id)}, ${stage}, ${db.json(manifest as never)})`;
      return search(reader);
    };
    const audienceOk = await assign("maker", [{ input_ref: evidenceId, content_hash: sourceHash, audience: ["maker"] }]);
    assert.equal((audienceOk.items as unknown[]).length, 1, "冻结清单逐字命中且阶段在受众内时必须可见");
    const wrongStage = await assign("reviewer", [{ input_ref: evidenceId, content_hash: sourceHash, audience: ["maker"] }]);
    assert.equal((wrongStage.items as unknown[]).length, 0, "同一批次但不在受众里的任务不放行");
    const wrongHash = await assign("maker", [{ input_ref: evidenceId, content_hash: "f".repeat(64), audience: ["maker"] }]);
    assert.equal((wrongHash.items as unknown[]).length, 0, "哈希不一致不能当成同一来源");
  });
});
