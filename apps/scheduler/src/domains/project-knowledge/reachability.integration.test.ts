import assert from "node:assert/strict";
import test from "node:test";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";
import { planKnowledgeBlobReachability } from "./reachability.js";

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
