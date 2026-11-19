import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runMigrations, type MigrationConnection } from "./migration-runner.js";
import { planSchemaRebuild } from "./schema-rebuild.js";

export async function runHumanMaintenanceFixture(databaseUrl: string) {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `human_maintenance_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  const db = postgres(url.toString(), { max: 1 });
  try {
    await runMigrations(db as unknown as MigrationConnection);
    const projectId = randomUUID(), canvasId = randomUUID(), jobId = randomUUID();
    const attemptId = randomUUID(), requestId = randomUUID();
    await db`INSERT INTO projects(id,name) VALUES(${projectId},'human maintenance fixture')`;
    await db`INSERT INTO canvases(id,project_id,title) VALUES(${canvasId},${projectId},'waiting task')`;
    await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES(${jobId},${projectId},${canvasId},'audit','waiting_human','{}')`;
    await db`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase)
      VALUES(${attemptId},${jobId},1,'interrupted','interrupted')`;
    await db`INSERT INTO events(job_id,event_id,job_seq,type,attempt_id)
      VALUES(${jobId},${requestId},1,'human',${attemptId})`;
    const manifest = { v: 1, job_id: jobId, attempt_id: attemptId, request_id: requestId,
      snapshot_sha256: "a".repeat(64), mode: "structured", files: [] };
    await db`INSERT INTO human_requests(id,source_event_id,project_id,canvas_id,job_id,attempt_id,payload_json,
      checkpoint_status,manifest_json,process_exited_at,resources_released_at)
      VALUES(${requestId},${requestId},${projectId},${canvasId},${jobId},${attemptId},'{}',
        'ready',${db.json(manifest)},now(),now())`;

    const assertBlocked = async (expected: boolean, reason: string) => {
      const plan = await planSchemaRebuild(db as unknown as MigrationConnection);
      assert.equal(plan.activeJobs.some(job => job.id === jobId), expected, reason);
    };
    await assertBlocked(false, "a sealed, released wait can survive maintenance");
    await db`UPDATE human_requests SET checkpoint_expires_at=now()-interval '1 second' WHERE id=${requestId}`;
    await assertBlocked(true, "expiry blocks maintenance even before the cleanup pump observes it");
    await db`UPDATE human_requests SET checkpoint_expires_at=now()+interval '1 day' WHERE id=${requestId}`;
    await assertBlocked(false, "a valid checkpoint remains eligible");

    await db`UPDATE human_requests SET checkpoint_status='preparing',process_exited_at=NULL WHERE id=${requestId}`;
    await assertBlocked(true, "a requested stop is not trusted exit evidence");
    await db`UPDATE human_requests SET checkpoint_status='ready',process_exited_at=now() WHERE id=${requestId}`;
    await db`UPDATE jobs SET sandbox_id='still-owned-sandbox' WHERE id=${jobId}`;
    await assertBlocked(true, "an attached sandbox still blocks maintenance");
    await db`UPDATE jobs SET sandbox_id=NULL WHERE id=${jobId}`;

    const effectId = randomUUID();
    await db`INSERT INTO job_attempt_effects(id,attempt_id,job_id,effect_id,effect_kind,status)
      VALUES(${effectId},${attemptId},${jobId},'request:fixture','gateway_model_request','effect_pending')`;
    for (const status of ["effect_pending", "unknown", "planned"]) {
      await db`UPDATE job_attempt_effects SET status=${status} WHERE id=${effectId}`;
      await assertBlocked(true, `${status} effects require reconciliation before maintenance`);
    }
    await db`UPDATE job_attempt_effects SET status='settled' WHERE id=${effectId}`;
    await assertBlocked(false, "settled effects do not hold an otherwise released wait");

    const tokenId = randomUUID();
    await db`INSERT INTO job_capability_tokens(id,job_id,project_id,canvas_id,role_name,snapshot_sha256,
      token_prefix,token_hash,operation_ids,expires_at)
      VALUES(${tokenId},${jobId},${projectId},${canvasId},'audit',${"a".repeat(64)},
        ${tokenId},'fixture-hash',ARRAY['emit_progress'],now()+interval '1 hour')`;
    await assertBlocked(true, "unrevoked Control access blocks maintenance");
    await db`UPDATE job_capability_tokens SET revoked_at=now() WHERE id=${tokenId}`;
    await assertBlocked(false, "revoked access is retained history");

    const successorId = randomUUID();
    await db`INSERT INTO job_attempts(id,job_id,attempt_no,status) VALUES(${successorId},${jobId},2,'active')`;
    await assertBlocked(true, "a previous checkpoint cannot authorize a newer owner");
    await db`DELETE FROM job_attempts WHERE id=${successorId}`;
    await assertBlocked(false, "only the current released owner is exempt");
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
}
