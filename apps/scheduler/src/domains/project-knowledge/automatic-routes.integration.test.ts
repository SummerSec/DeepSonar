import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import type { AuditEntry } from "../../audit.js";
import { registerAutomaticKnowledgeRoutes } from "./automatic-routes.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

test("backfill previews are read-only; exact successful Jobs enqueue once without reviving execution", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    const foreign = await seedKnowledgeJob(db);
    const second = await seedKnowledgeJob(db, source.projectId, ["request_project_knowledge"]);
    await db`UPDATE jobs SET status='succeeded',finished_at=now(),lease_expires_at=NULL WHERE id=${source.jobId}`;
    await db`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE id=${source.attemptId}`;
    await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${second.jobId}`;
    await db`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE id=${second.attemptId}`;
    await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json)
      VALUES(${second.canvasId},${second.jobId},'fact','Second observed prerequisite','succeeded','{"observation":"fixture"}')`;
    await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json)
      VALUES(${source.canvasId},${source.jobId},'fact','Observed prerequisite','succeeded','{"observation":"fixture"}')`;
    const app = Fastify();
    let actor: Actor = { type: "api_token", id: randomUUID(), name: "fixture",
      projectId: source.projectId, scopes: ["projects:read", "projects:write"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    const audits: AuditEntry[] = [];
    registerAutomaticKnowledgeRoutes(app, { db: db as never,
      recordAudit: async (_request, entry) => { audits.push(entry); } });
    const path = `/projects/${source.projectId}/knowledge/backfill`;
    try {
      let result = await app.inject({ method: "GET", url: path });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().items[0].status, "eligible");
      assert.equal((await db`SELECT count(*)::int n FROM project_knowledge_work`)[0]!.n, 0);
      const payload = { job_ids: [source.jobId], reason: "User requested historical knowledge extraction" };
      result = await app.inject({ method: "POST", url: path, payload });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().items[0].status, "queued");
      const workRef = result.json().items[0].work_ref;
      result = await app.inject({ method: "POST", url: path, payload });
      assert.equal(result.json().items[0].status, "existing");
      assert.equal(result.json().items[0].work_ref, workRef);
      const preview = await app.inject({ method: "GET", url: path });
      const sourcePreview = preview.json().items.find((item: { job_id: string }) => item.job_id === source.jobId);
      assert.equal(sourcePreview.work.id, workRef);
      assert.equal(sourcePreview.work.state, "pending");
      assert.equal((await db`SELECT count(*)::int n FROM project_knowledge_work`)[0]!.n, 1);
      assert.equal((await db`SELECT status FROM jobs WHERE id=${source.jobId}`)[0]!.status, "succeeded");
      assert.equal((await db`SELECT status FROM job_attempts WHERE id=${source.attemptId}`)[0]!.status, "succeeded");
      result = await app.inject({ method: "POST", url: path,
        payload: { ...payload, job_ids: [second.jobId, foreign.jobId] } });
      assert.equal(result.statusCode, 404, "foreign and missing Jobs are indistinguishable and rejected before writes");
      assert.equal((await db`SELECT count(*)::int n FROM project_knowledge_work`)[0]!.n, 1,
        "the valid unqueued member must not acquire work before a mixed batch is rejected");
      assert.equal(audits.at(-1)!.result, "denied");
      assert.equal(audits.at(-1)!.errorCode, "KNOWLEDGE_SOURCE_NOT_FOUND");
      result = await app.inject({ method: "POST", url: path, payload: { ...payload, enabled: true } });
      assert.equal(result.statusCode, 400);
      result = await app.inject({ method: "POST", url: path,
        payload: { ...payload, job_ids: [source.jobId, source.jobId] } });
      assert.equal(result.statusCode, 400);
      result = await app.inject({ method: "POST", url: path,
        payload: { ...payload, job_ids: Array.from({ length: 6 }, () => randomUUID()) } });
      assert.equal(result.statusCode, 400);
      actor = { ...actor, scopes: ["projects:read"] };
      result = await app.inject({ method: "POST", url: path, payload });
      assert.equal(result.statusCode, 403);
      actor = { ...actor, projectId: foreign.projectId };
      result = await app.inject({ method: "GET", url: path });
      assert.equal(result.statusCode, 403);
    } finally { await app.close(); }
  });
});
