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
      const reader = await seedKnowledgeJob(db, writer.projectId, ["search_project_knowledge", "read_project_memory", operation]);
      const catalog = await freezeProjectKnowledgeCatalog(db as never, writer.projectId);
      await sql`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["search_project_knowledge", "read_project_memory", operation],
        project_knowledge_catalog: catalog } as never)} WHERE id=${reader.jobId}`;
      const found = await app.invoke({ jobId: reader.jobId, projectId: writer.projectId, canvasId: reader.canvasId,
        operationId: "search_project_knowledge", input: { query: "构建" }, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null });
      assert.equal((found.items as unknown[]).length, 1, JSON.stringify(found));
      const read = await app.invoke({ jobId: reader.jobId, projectId: writer.projectId, canvasId: reader.canvasId,
        operationId: "read_project_memory", input: { item_ref: String(item!.id), version: 1,
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
      const rival = await seedKnowledgeJob(db, writer.projectId, ["read_project_memory", "search_project_knowledge", operation]);
      await sql`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["read_project_memory", "search_project_knowledge", operation],
        project_knowledge_catalog: catalog } as never)} WHERE id=${rival.jobId}`;
      const rivalFact = await seedFact(db as never, rival, 3);
      const stale1 = await app.invoke({ jobId: rival.jobId, projectId: writer.projectId, canvasId: rival.canvasId,
        operationId: "read_project_memory", input: { item_ref: String(item!.id), version: 1,
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
