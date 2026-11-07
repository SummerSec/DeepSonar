import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { freezeJobSkillCatalog } from "../../job-skill-catalog.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";
import { planKnowledgeBlobReachability } from "./reachability.js";

test("pending source manifests are retained roots, not Job grants, until replacement or source removal", async () => {
  await withKnowledgeDatabase(async db => {
    const job = await seedKnowledgeJob(db), sourceId = randomUUID();
    const live = "c".repeat(64), candidate = "d".repeat(64), replacement = "e".repeat(64);
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${live},1,'application/json','live'),(${candidate},1,'application/json','candidate'),
            (${replacement},1,'application/json','replacement')`;
    await db`INSERT INTO skill_sources(id,name,repo_url,enabled,trust_status,catalog_snapshot_hash,candidate_hash)
      VALUES(${sourceId},${`fixture-${sourceId}`},'https://127.0.0.1/skills.git',true,'trusted',${live},${candidate})`;
    const frozen = await freezeJobSkillCatalog(db as never, job.projectId);
    assert.equal(frozen.sources.find(source => source.source_id === sourceId)!.manifest_hash, live);
    assert.equal(frozen.sources.find(source => source.source_id === sourceId)!.source_update_pending, true);
    assert.ok(frozen.sources.every(source => source.manifest_hash !== candidate));
    await db`UPDATE jobs SET agent_snapshot_json=${db.json({ job_skill_catalog: frozen } as never)} WHERE id=${job.jobId}`;
    const before = await planKnowledgeBlobReachability(db);
    assert.equal(before.deletion_enabled, false);
    assert.deepEqual(before.reachable, [
      { hash: live, reasons: ["historic_job_skill_catalog", "skill_source"] },
      { hash: candidate, reasons: ["skill_source"] },
    ]);
    assert.deepEqual(before.retained_unreferenced, [replacement]);
    await db`UPDATE skill_sources SET candidate_hash=${replacement} WHERE id=${sourceId}`;
    const replaced = await planKnowledgeBlobReachability(db);
    assert.ok(replaced.reachable.some(root => root.hash === replacement && root.reasons.includes("skill_source")));
    assert.ok(!replaced.reachable.some(root => root.hash === candidate));
    assert.deepEqual(replaced.retained_unreferenced, [candidate]);
    await db`DELETE FROM skill_sources WHERE id=${sourceId}`;
    const removed = await planKnowledgeBlobReachability(db);
    assert.deepEqual(removed.reachable, [{ hash: live, reasons: ["historic_job_skill_catalog"] }]);
    assert.deepEqual(removed.retained_unreferenced, [candidate, replacement]);
    assert.equal(removed.deletion_enabled, false);
    assert.equal((await db`SELECT count(*)::int AS n FROM shared_asset_blobs`)[0].n, 3);
  });
});

test("offline reachability retains historic snapshot roots and never authorizes deletion", async () => {
  await withKnowledgeDatabase(async (db) => {
    const job = await seedKnowledgeJob(db);
    const old = "a".repeat(64), orphan = "b".repeat(64);
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${old},1,'application/json','old'),(${orphan},1,'application/json','orphan')`;
    await db`UPDATE jobs SET agent_snapshot_json=${db.json({ job_skill_catalog: { sources: [{ manifest_hash: old }] } })},status='orphan' WHERE id=${job.jobId}`;
    const plan = await planKnowledgeBlobReachability(db);
    assert.equal(plan.deletion_enabled, false);
    assert.deepEqual(plan.reachable, [{ hash: old, reasons: ["historic_job_skill_catalog"] }]);
    assert.deepEqual(plan.retained_unreferenced, [orphan]);
    assert.equal((await db`SELECT COUNT(*)::int AS count FROM shared_asset_blobs`)[0].count, 2);
  });
});
