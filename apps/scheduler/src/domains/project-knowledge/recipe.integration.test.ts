import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withKnowledgeDatabase, seedKnowledgeJob } from "./test-support.js";
import { writeKnowledgeBlob, registerKnowledgeBlob } from "./blobs.js";
import { frozenGovernorRecipe, GOVERNOR_LOGICAL_KEY } from "./recipe.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { readManifestInput } from "./inputs.js";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";

test("project governor revision applies to the next frozen work and revoked old recipe is denied", async () => {
  const bytes = new Map<string, Buffer>();
  setSharedAssetBlobStoreForTests({
    kind: "fs", get: async (key) => bytes.get(key)!, exists: async (key) => bytes.has(key),
    put: async (key, body) => { bytes.set(key, Buffer.from(body)); },
    materializeLocal: async () => { throw new Error("unused"); },
  } satisfies BlobStore);
  try {
    await withKnowledgeDatabase(async (db) => {
      const origin = await seedKnowledgeJob(db), item = randomUUID(), first = randomUUID(), second = randomUUID();
      const initial = await writeKnowledgeBlob(db, { kind: "skill", logical_key: GOVERNOR_LOGICAL_KEY,
        title: "Project governor", keywords: [], files: { "SKILL.md": "Prefer reuse. Version one." } });
      const revised = await writeKnowledgeBlob(db, { kind: "skill", logical_key: GOVERNOR_LOGICAL_KEY,
        title: "Project governor", keywords: [], files: { "SKILL.md": "Prefer reuse and merge. Version two." } });
      for (const blob of [initial, revised]) await registerKnowledgeBlob(db, blob.hash, blob.bytes);
      await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
        VALUES(${item},${origin.projectId},'skill',${GOVERNOR_LOGICAL_KEY},'Project governor')`;
      for (const [id, version, hash] of [[first, 1, initial.hash], [second, 2, revised.hash]] as const)
        await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
          VALUES(${id},${origin.projectId},${item},${version},${hash},${origin.jobId},${origin.attemptId},'[]',${initial.hash})`;
      await db`UPDATE project_knowledge_items SET status='active',active_version_id=${first} WHERE id=${item}`;
      const actor = { jobId: origin.jobId, projectId: origin.projectId, canvasId: origin.canvasId, attemptId: origin.attemptId,
        snapshot: { project_knowledge_catalog: await freezeProjectKnowledgeCatalog(db, origin.projectId) } };
      const frozen = await frozenGovernorRecipe(db, actor);
      assert.equal(frozen!.input_ref, `governor:${first}`);
      await db`UPDATE project_knowledge_items SET active_version_id=${second},generation=generation+1 WHERE id=${item}`;
      assert.deepEqual(await frozenGovernorRecipe(db, actor), frozen);
      const next = await frozenGovernorRecipe(db, { ...actor,
        snapshot: { project_knowledge_catalog: await freezeProjectKnowledgeCatalog(db, origin.projectId) } });
      assert.equal(next!.input_ref, `governor:${second}`);
      const maker = await seedKnowledgeJob(db, origin.projectId);
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,input_manifest_json)
        VALUES(${origin.projectId},${randomUUID()},${initial.hash},${db.json([frozen] as never)}) RETURNING id`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage,input_manifest_json)
        VALUES(${maker.jobId},${origin.projectId},${work.id},'maker',${db.json([frozen] as never)})`;
      const makerActor = { ...actor, jobId: maker.jobId, canvasId: maker.canvasId, attemptId: maker.attemptId };
      const payload = { work_ref: String(work.id), input_ref: frozen!.input_ref, expected_hash: frozen!.content_hash };
      const read = await readManifestInput(db, makerActor, payload);
      assert.match(read.content_fragment, /Version one/);
      await db`UPDATE project_knowledge_versions SET revoked_at=now(),revoked_reason='fixture' WHERE id=${first}`;
      await assert.rejects(readManifestInput(db, makerActor, payload), /revoked/i);
    });
  } finally { setSharedAssetBlobStoreForTests(null); }
});
