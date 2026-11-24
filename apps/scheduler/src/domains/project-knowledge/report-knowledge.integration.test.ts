import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildReportInput, renderKnowledgeRefsSection } from "../../report.js";
import { CLOSEOUT_EVALUATION_PREFIX } from "./closeout-evaluation-key.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

// 知识表有 append-only 触发器，清理必须靠一次性数据库；这里用知识域的 withKnowledgeDatabase。
test("#1256 报告只取可见版本的知识引用，且正文不带可识别元数据", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const hashes = ["1", "2", "3"].map((seed) => seed.repeat(64));
    const activeItem = randomUUID(), activeVersion = randomUUID();
    const revokedItem = randomUUID(), revokedVersion = randomUUID();
    const privateItem = randomUUID(), privateVersion = randomUUID();
    const workId = randomUUID(), proposalId = randomUUID();
    for (const [index, hash] of hashes.entries()) {
      const payload = Buffer.from(JSON.stringify({ kind: "memory", content: `c${index}` }), "utf8");
      await db`INSERT INTO shared_asset_blobs (content_sha256, bytes, content_type, blob_uri)
        VALUES (${hash}, ${payload.length}, 'application/json', ${`test://${hash}`})`;
    }
    for (const [item, version, hash, title] of [
      [activeItem, activeVersion, hashes[0], "可见知识标题"],
      [revokedItem, revokedVersion, hashes[1], "已撤权知识标题"],
      [privateItem, privateVersion, hashes[2], "私有评测知识标题"],
    ] as const) {
      await db`INSERT INTO project_knowledge_items (id, project_id, kind, logical_key, title)
        VALUES (${item}, ${owner.projectId}, 'memory', ${`k-${item}`}, ${title})`;
      await db`INSERT INTO project_knowledge_versions (id, project_id, item_id, version, content_sha256,
        creator_job_id, creator_attempt_id, sources_json, governance_hash)
        VALUES (${version}, ${owner.projectId}, ${item}, 1, ${hash}, ${owner.jobId}, ${owner.attemptId}, '[]', ${hash})`;
      await db`UPDATE project_knowledge_items SET active_version_id=${version}, status='active' WHERE id=${item}`;
      await db`INSERT INTO project_knowledge_usages (project_id, job_id, attempt_id, selector, content_sha256,
        owner_project_id, version_id, feedback_json)
        VALUES (${owner.projectId}, ${owner.jobId}, ${owner.attemptId}, ${`sel-${item}`}, ${hash},
          ${owner.projectId}, ${version}, ${db.json({ outcome: "success" })})`;
    }
    await db`UPDATE project_knowledge_versions SET revoked_at=now(), revoked_reason='security' WHERE id=${revokedVersion}`;
    await db`INSERT INTO project_knowledge_work (id, project_id, trigger_key, governance_hash)
      VALUES (${workId}, ${owner.projectId}, ${`${CLOSEOUT_EVALUATION_PREFIX}root:fp`}, ${"a".repeat(64)})`;
    await db`INSERT INTO project_knowledge_proposals (id, project_id, work_id, action, revision, candidate_version_id,
      maker_job_id, idempotency_key, request_digest, input_digest, reason)
      VALUES (${proposalId}, ${owner.projectId}, ${workId}, 'create', 1, ${privateVersion}, ${owner.jobId},
        ${randomUUID()}, ${"b".repeat(64)}, ${"c".repeat(64)}, 'test')`;

    const input = await buildReportInput(owner.canvasId, db as never);
    // 撤销与评测私有版本不计入摘要。
    assert.deepEqual(input.knowledge_summary, { versions: 1, reads: 1, rated: 1 });
    const section = renderKnowledgeRefsSection(input.knowledge_summary);
    assert.match(section, /共读取 1 个知识版本，累计 1 次/u);
    assert.match(section, /其中 1 个版本有显式反馈/u);
    // 报告 Job 输入（会写进 report_input_json 并随通用产物外流）不得含可识别元数据。
    const frozen = JSON.stringify(input);
    for (const needle of ["可见知识标题", "已撤权知识标题", "私有评测知识标题", hashes[0]!.slice(0, 12), activeItem, activeVersion]) {
      assert.ok(!frozen.includes(needle), `报告输入不得包含可识别元数据：${needle}`);
      assert.ok(!section.includes(needle), `正文不得包含可识别元数据：${needle}`);
    }
  });
});
