import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import { registerKnowledgeActivityRoutes } from "./activity-routes.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for knowledge activity integration");
const hash = "a".repeat(64);

async function source(db: TestSql, project: string, id: string, action: string, after: Record<string, unknown> = {},
  actorType = "system", actorId = "scheduler", result = "ok") {
  await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,after_json)
    VALUES(${actorType},${actorId},${`project_knowledge.${action}`},${project},'job',${id},${result},${db.json(after as never)})`;
}

test("activity separates registered sources, queued collection, active products and project-owned model feedback", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db), other = await seedKnowledgeJob(db);
    const pending = await seedKnowledgeJob(db, owner.projectId), skipped = await seedKnowledgeJob(db, owner.projectId);
    const batched = await seedKnowledgeJob(db, owner.projectId);
    const queued = randomUUID(), explicit = randomUUID(), foreign = randomUUID();
    for (const [id, project, origin, state] of [
      [queued, owner.projectId, null, "pending"], [explicit, owner.projectId, owner.jobId, "blocked"],
      [foreign, other.projectId, other.jobId, "completed"],
    ] as const) {
      await db`INSERT INTO project_knowledge_work(id,project_id,origin_job_id,state,trigger_key,governance_hash,reason,created_at)
        VALUES(${id},${project},${origin},${state},${id},${hash},'job_budget_exhausted','2026-01-01')`;
    }
    // Even a historical cross-project Canvas reference must not become a navigation leak.
    await db`UPDATE project_knowledge_work SET canvas_id=${other.canvasId} WHERE id=${explicit}`;
    await db`UPDATE project_knowledge_work SET active_job_id=${owner.jobId},reason=${`private input ${other.jobId}`} WHERE id=${explicit}`;
    await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason)
      VALUES(${owner.projectId},${explicit},'reuse','blocked',1,${owner.jobId},${randomUUID()},${hash},${hash},'private proposal body')`;
    for (const id of [owner.jobId, pending.jobId, skipped.jobId, batched.jobId]) await source(db, owner.projectId, id, "source_registered", { body: "source body must stay private" });
    for (let index = 0; index < 2; index++) {
      await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,error_code,after_json)
        VALUES('system','scheduler','project_knowledge.source_collection_skipped',${owner.projectId},'job',${skipped.jobId},
          'error','source_input_limit','{"reason":"source_input_limit","body":"private skipped input"}')`;
    }
    // An overlapping historical skip must not subtract this already-collected source twice.
    await source(db, owner.projectId, owner.jobId, "source_collection_skipped", { reason: "unsettled_effects" }, "system", "scheduler", "error");
    await source(db, other.projectId, other.jobId, "source_collection_skipped", { reason: "private foreign reason" }, "system", "scheduler", "error");
    await source(db, owner.projectId, owner.jobId, "source_registered"); // duplicate registration
    await source(db, other.projectId, other.jobId, "source_registered");
    await source(db, owner.projectId, "forged", "source_registered", {}, "job", owner.jobId);
    await source(db, owner.projectId, "wrong-system", "source_registered", {}, "system", "other");
    await source(db, owner.projectId, "failed", "source_registered", {}, "system", "scheduler", "denied");
    await source(db, owner.projectId, owner.jobId, "source_collected", { work_ref: queued, body: "private input" });
    await source(db, owner.projectId, owner.jobId, "source_collected", { work_ref: queued });
    await source(db, owner.projectId, batched.jobId, "source_collected", { work_ref: queued });
    // Malformed, foreign and failed collection records must not clear pending sources.
    await source(db, owner.projectId, pending.jobId, "source_collected", { work_ref: foreign });
    await source(db, owner.projectId, pending.jobId, "source_collected", { work_ref: "not-a-uuid" });
    await source(db, owner.projectId, pending.jobId, "source_collected", { work_ref: queued }, "system", "scheduler", "denied");

    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri) VALUES(${hash},1,'application/json','fixture')`;
    const versions: string[] = [];
    for (const [project, job, attempt, kind, state] of [
      [owner.projectId, owner.jobId, owner.attemptId, "memory", "active"],
      [owner.projectId, owner.jobId, owner.attemptId, "skill", "active"],
      [owner.projectId, owner.jobId, owner.attemptId, "skill", "draft"],
      [other.projectId, other.jobId, other.attemptId, "skill", "active"],
    ] as const) {
      const item = randomUUID(), version = randomUUID();
      await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
        VALUES(${item},${project},${kind},${item},'private title')`;
      await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,
        creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${version},${project},${item},1,${hash},${job},${attempt},'[]',${hash})`;
      await db`UPDATE project_knowledge_items SET status=${state},active_version_id=${state === "active" ? version : null} WHERE id=${item}`;
      versions.push(version);
    }
    for (const [consumer, ownerProject, version, outcome] of [
      [owner, owner.projectId, versions[0], "success"], [owner, owner.projectId, versions[1], "failure"],
      [owner, owner.projectId, versions[0], null], [owner, other.projectId, versions[3], "success"],
      [other, owner.projectId, versions[0], "success"], [owner, null, null, "success"],
    ] as const) {
      await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id,feedback_json)
        VALUES(${consumer.projectId},${consumer.jobId},${consumer.attemptId},${randomUUID()},${hash},${ownerProject},${version ?? null},
          ${outcome ? db.json({ outcome, reason: "private feedback body" }) : null})`;
    }
    const app = Fastify();
    app.addHook("onRequest", async req => { req.actor = { type: "api_token", id: "fixture", name: "fixture",
      projectId: owner.projectId, scopes: ["projects:read"] }; });
    registerKnowledgeActivityRoutes(app, { db: db as never });
    try {
      const path = `/projects/${owner.projectId}/knowledge/activity`;
      const res = await app.inject({ method: "GET", url: `${path}?limit=1&offset=0` });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json().summary, { registered_sources: 4, collected_sources: 2, skipped_sources: 2, pending_sources: 1,
        active_memory: 1, active_skills: 1, draft_items: 1, completed_work: 0, blocked_work: 1,
        usage_count: 3, feedback_count: 2, successful_feedback: 1 });
      assert.equal(res.json().items.length, 1);
      assert.equal(res.json().skipped_sources.length, 2, "recent skips are deduplicated by source Job");
      assert.ok(res.json().skipped_sources.some((row: { job_id: string; reason: string }) => row.job_id === skipped.jobId && row.reason === "source_input_limit"));
      assert.equal(res.json().next_offset, 1);
      const next = await app.inject({ method: "GET", url: `${path}?limit=1&offset=1` });
      assert.equal(next.json().next_offset, null);
      const items = [...res.json().items, ...next.json().items];
      assert.equal(items.find(row => row.id === queued).state, "pending", "collection queues work; it does not activate knowledge");
      assert.equal(items.find(row => row.id === queued).source_count, 2, "batch counts source Jobs, not input records or origin fallback");
      assert.equal(items.find(row => row.id === explicit).source_count, 1, "explicit origin is a one-source fallback");
      assert.equal(items.find(row => row.id === explicit).canvas_id, null);
      assert.equal(items.find(row => row.id === explicit).active_job_id, owner.jobId);
      assert.equal(items.find(row => row.id === explicit).reason, "details_unavailable");
      assert.equal(items.find(row => row.id === explicit).latest_proposal_state, "blocked");
      assert.doesNotMatch(res.body + next.body, /private|source body|after_json|input_manifest|origin_job_id/);
      assert.doesNotMatch(res.body + next.body, new RegExp(other.projectId + "|" + other.canvasId + "|" + other.jobId));
    } finally { await app.close(); }
  });
});

test("activity rejects unknown pagination, enforces read scope and returns 404 only for authorized missing projects", async () => {
  await withKnowledgeDatabase(async db => {
    const owner = await seedKnowledgeJob(db), other = await seedKnowledgeJob(db);
    let actor: Actor | undefined = { type: "api_token", id: "fixture", name: "fixture", projectId: owner.projectId, scopes: ["projects:read"] };
    const app = Fastify();
    app.addHook("onRequest", async req => { req.actor = actor; });
    registerKnowledgeActivityRoutes(app, { db: db as never });
    const request = (project: string, query = "") => app.inject({ method: "GET", url: `/projects/${project}/knowledge/activity${query}` });
    try {
      const empty = await request(owner.projectId);
      assert.equal(empty.statusCode, 200);
      assert.deepEqual(empty.json().items, []);
      assert.ok(Object.values(empty.json().summary).every(value => value === 0));
      for (const query of ["?extra=1", "?limit=0", "?limit=51", "?limit=1.5", "?offset=-1", "?offset=bad", "?limit=1&limit=2"]) {
        assert.equal((await request(owner.projectId, query)).statusCode, 400, query);
      }
      assert.equal((await request(other.projectId)).statusCode, 403);
      actor = { ...actor!, scopes: ["projects:write"] };
      assert.equal((await request(owner.projectId)).statusCode, 403);
      actor = undefined;
      assert.equal((await request(owner.projectId)).statusCode, 403);
      actor = { type: "api_token", id: "global", name: "global", projectId: null, scopes: ["projects:read"] };
      assert.equal((await request(randomUUID())).statusCode, 404);
    } finally { await app.close(); }
  });
});

test("skipped metadata is bounded to ten distinct sources, preserves missing-job skips and redacts arbitrary reasons", async () => {
  await withKnowledgeDatabase(async db => {
    const owner = await seedKnowledgeJob(db);
    const ids: string[] = [];
    for (let index = 0; index < 12; index++) {
      const id = randomUUID();
      ids.push(id);
      await source(db, owner.projectId, id, "source_registered");
      await source(db, owner.projectId, id, "source_collection_skipped",
        { reason: index === 11 ? "private source body" : "job_not_found" }, "system", "scheduler", "error");
    }
    const pending = randomUUID();
    await source(db, owner.projectId, pending, "source_registered");
    await source(db, owner.projectId, pending, "source_collection_skipped", { reason: "no_sources" }, "job", owner.jobId, "error");
    await source(db, owner.projectId, pending, "source_collection_skipped", { reason: "no_sources" }, "system", "scheduler", "ok");
    const workId = randomUUID();
    await db`INSERT INTO project_knowledge_work(id,project_id,state,trigger_key,governance_hash,reason)
      VALUES(${workId},${owner.projectId},'completed',${workId},${hash},'scheduler_admission_retry:3:private error body')`;
    const app = Fastify();
    app.addHook("onRequest", async req => { req.actor = { type: "api_token", id: "fixture", name: "fixture",
      projectId: owner.projectId, scopes: ["projects:read"] }; });
    registerKnowledgeActivityRoutes(app, { db: db as never });
    try {
      const response = await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/activity` });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.summary.registered_sources, 13);
      assert.equal(body.summary.skipped_sources, 12);
      assert.equal(body.summary.pending_sources, 1);
      assert.equal(body.summary.completed_work, 1);
      assert.equal(body.items[0].source_count, 0);
      assert.equal(body.items[0].reason, "scheduler_admission_failed");
      assert.equal(body.skipped_sources.length, 10);
      assert.equal(body.skipped_sources[0].job_id, ids[11]);
      assert.equal(body.skipped_sources[0].reason, "details_unavailable");
      assert.equal(new Set(body.skipped_sources.map((row: { job_id: string }) => row.job_id)).size, 10);
      assert.doesNotMatch(response.body, /private/);
    } finally { await app.close(); }
  });
});
