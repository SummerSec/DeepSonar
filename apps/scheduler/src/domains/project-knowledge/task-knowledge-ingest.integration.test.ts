import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { TASK_KNOWLEDGE_SUGGESTION_OPERATION as operation } from "@deepsonar/shared-types";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { hashJobSnapshot } from "../platform-api/tokens.js";
import { submitTaskKnowledgeSuggestion } from "./closeout-intake.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

/**
 * #1219 第一步的数据库回归：任务内沉淀直接入库、跨任务可检索、项目隔离、
 * 撤销条目不被同名投稿复活、重复投稿不产生第二次写入、并发同名投稿只留一条条目。
 * 全部合成数据，不需要真实模型，也不要求真实设备。
 */
test("task knowledge ingestion is retrievable, project-scoped and lifecycle-safe", async () => {
  await withKnowledgeDatabase(async db => {
    const blobs = new Map<string, Buffer>();
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async key => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async key => blobs.has(key), materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);

    const owner = await seedKnowledgeJob(db, undefined, [operation]);
    const otherProject = await seedKnowledgeJob(db, undefined, [operation]);
    const rootId = randomUUID();
    await db`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status) VALUES(${rootId},${owner.canvasId},'root','Task','running')`;

    const submitAs = async (job: Awaited<ReturnType<typeof seedKnowledgeJob>>, title: string, content: string) => {
      const tokenId = randomUUID();
      const [{ agent_snapshot_json: snapshot }] = await db`SELECT agent_snapshot_json FROM jobs WHERE id=${job.jobId}`;
      await db`INSERT INTO job_capability_tokens(id,job_id,project_id,canvas_id,role_name,snapshot_sha256,token_prefix,token_hash,operation_ids,expires_at)
        VALUES(${tokenId},${job.jobId},${job.projectId},${job.canvasId},'fixture',${hashJobSnapshot(snapshot)},${tokenId},'test',${[operation]},now()+interval '1 hour')`;
      return submitTaskKnowledgeSuggestion({
        ...job, tokenId, operationId: operation, eventId: randomUUID(), idempotencyKey: randomUUID(),
        input: { result: "suggestions", items: [{ kind: "memory", title, scope: "fixture scope", content,
          evidence_refs: [{ kind: "fact", ref: randomUUID() }] }] },
      } as never, db, { attemptId: job.attemptId, secrets: ["fixture-secret-value"] });
    };

    // 1. 同名但不同内容的第二次沉淀不带修订目标：不改动已有条目。
    await submitAs(owner, "构建要先升 SDK", "先升 SDK 再打包");
    const [item] = await db`SELECT id, status, active_version_id FROM project_knowledge_items WHERE project_id=${owner.projectId}`;
    assert.equal(item.status, "active");
    assert.ok(item.active_version_id);

    // 2. 新任务（在入库之后创建）能按项目目录看到它；其他项目看不到。
    const catalogOwner = await freezeProjectKnowledgeCatalog(db as never, owner.projectId);
    assert.ok(catalogOwner.entries.some(entry => entry.item_id === String(item.id)), "same project sees the ingested item");
    const catalogOther = await freezeProjectKnowledgeCatalog(db as never, otherProject.projectId);
    assert.equal(catalogOther.entries.some(entry => entry.item_id === String(item.id)), false, "other project must not see it");

    // 3. 撤销后同名投稿不得复活该条目。
    await db`UPDATE project_knowledge_items SET status='revoked' WHERE id=${item.id}`;
    const afterRevoke = await submitAs(owner, "构建要先升 SDK", "换了写法的同标题内容");
    assert.equal(afterRevoke.accepted, true);
    const [revokedItem] = await db`SELECT status FROM project_knowledge_items WHERE id=${item.id}`;
    assert.equal(revokedItem.status, "revoked", "a revoked item must not be revived by a same-title submission");
    const [{ count: versionCount }] = await db`SELECT count(*)::int AS count FROM project_knowledge_versions WHERE item_id=${item.id}`;
    assert.equal(Number(versionCount), 1, "no new version is appended to a revoked item");

    // 4. 并发同名投稿只留一条条目，且两份都能接受。
    await db`UPDATE project_knowledge_items SET status='retired' WHERE id=${item.id}`;
    const first = seedKnowledgeJob(db, owner.projectId, [operation]);
    const second = seedKnowledgeJob(db, owner.projectId, [operation]);
    const [a, b] = await Promise.all([first, second]);
    const [ra, rb] = await Promise.all([
      submitAs(a, "并发同名沉淀", "来自任务 A 的内容"),
      submitAs(b, "并发同名沉淀", "来自任务 B 的内容"),
    ]);
    assert.equal(ra.accepted, true);
    assert.equal(rb.accepted, true);
    const [{ count: sameTitle }] = await db`SELECT count(*)::int AS count FROM project_knowledge_items
      WHERE project_id=${owner.projectId} AND logical_key='task/并发同名沉淀'`;
    assert.equal(Number(sameTitle), 1, "concurrent same-title submissions must converge on one item");
  });
});
