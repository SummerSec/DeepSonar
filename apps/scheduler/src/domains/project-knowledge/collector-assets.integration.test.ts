import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prepareKnowledgeSource } from "./collector-sources.js";
import { readKnowledgeBlob, registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

for (const owned of [true, false]) test(`collection ${owned ? "freezes" : "denies ungranted"} asset-backed Evidence bytes`, async () => {
  await withKnowledgeDatabase(async db => {
    const origin = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    const assetOwner = owned ? origin : await seedKnowledgeJob(db, origin.projectId);
    const body = await writeKnowledgeBlob(db, { raw_input: "actual source asset content" });
    await registerKnowledgeBlob(db, body.hash, body.bytes);
    const [asset] = await db`INSERT INTO shared_assets(scope_type,project_id,logical_key,origin,created_by_job_id)
      VALUES('project',${origin.projectId},'source.json','system',${assetOwner.jobId}) RETURNING id`;
    const [version] = await db`INSERT INTO shared_asset_versions(asset_id,version,content_sha256,bytes,content_type,origin,created_by_job_id)
      VALUES(${String(asset!.id)},1,${body.hash},${body.bytes},'application/json','system',${assetOwner.jobId}) RETURNING id`;
    const eventId = randomUUID();
    await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
      VALUES(${origin.jobId},${eventId},1,${origin.attemptId},'fact','{"title":"source asset"}'::jsonb)`;
    const [artifact] = await db`INSERT INTO artifacts(project_id,job_id,artifact_key,kind,source_event_id,source_operation)
      VALUES(${origin.projectId},${origin.jobId},'source','observation',${eventId},'emit_fact') RETURNING id`;
    await db`INSERT INTO artifact_evidence(artifact_id,statement,uri,sha256)
      VALUES(${String(artifact!.id)},'source content is in the asset',${`asset:${version!.id}`},${body.hash})`;
    await db`UPDATE jobs SET status='succeeded' WHERE id=${origin.jobId}`;
    await db`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${origin.attemptId}`;
    const prepare = () => prepareKnowledgeSource(db, origin.projectId, origin.jobId, "fixture-registration");
    if (!owned) { await assert.rejects(prepare(), /not frozen|scope/i); return; }
    const prepared = await prepare();
    const input = prepared.manifest.find(entry => entry.input_ref === `asset:${version!.id}`);
    assert.ok(input);
    assert.equal(input.content_hash, body.hash);
    // Collector registers the prepared CAS entries in its atomic work transaction.
    await registerKnowledgeBlob(db, input.blob_hash, input.bytes);
    const frozen = await readKnowledgeBlob(db, input.blob_hash) as {content: string};
    assert.match(Buffer.from(frozen.content, "base64").toString("utf8"), /actual source asset content/);
  });
});
