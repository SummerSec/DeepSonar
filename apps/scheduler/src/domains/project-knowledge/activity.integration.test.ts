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
    const unreported = [];
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      const consumer = await seedKnowledgeJob(db, owner.projectId);
      await db`UPDATE jobs SET status=${status},finished_at=now() WHERE id=${consumer.jobId}`;
      unreported.push(consumer);
    }
    for (const [consumer, ownerProject, version, outcome] of [
      [owner, owner.projectId, versions[0], "success"], [owner, owner.projectId, versions[1], "failure"],
      ...unreported.map(consumer => [consumer, owner.projectId, versions[0], null] as const),
      [owner, other.projectId, versions[3], "success"],
      [other, owner.projectId, versions[0], "success"], [owner, null, null, "success"],
    ] as const) {
      const feedback = outcome ? db.json({ outcome, reason: "private feedback body", next_action: "reevaluate",
        evidence_refs: [{ kind: "fact", ref: randomUUID(), content_hash: hash }] }) : null;
      await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id,feedback_json)
        VALUES(${consumer.projectId},${consumer.jobId},${consumer.attemptId},${randomUUID()},${hash},${ownerProject},${version ?? null},${feedback})`;
    }
    const readFeedback = async () => [...await db`SELECT id,feedback_json FROM project_knowledge_usages ORDER BY id`];
    const originalFeedback = await readFeedback();
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
        usage_count: 5, feedback_count: 2, successful_feedback: 1 });
      assert.equal(res.json().collection.state, "busy");
      assert.equal(res.json().collection.next_collection_at, null);
      assert.equal(res.json().items.length, 1);
      assert.equal(res.json().skipped_sources.length, 2, "recent skips are deduplicated by source Job");
      assert.ok(res.json().skipped_sources.some((row: { job_id: string; reason: string }) => row.job_id === skipped.jobId && row.reason === "source_input_limit"));
      assert.equal(res.json().next_offset, 1);
      const next = await app.inject({ method: "GET", url: `${path}?limit=1&offset=1` });
      assert.equal(next.json().next_offset, null);
      assert.deepEqual(next.json().summary, res.json().summary, "feedback counts are independent of work pagination");
      assert.deepEqual(await readFeedback(), originalFeedback, "repeated reads preserve explicit feedback and leave all missing feedback unknown");
      assert.deepEqual(next.json().collection, res.json().collection, "collection status is project-level, independent of work pagination");
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
      assert.deepEqual(empty.json().collection, { state: "idle", pending_sources: 0, consecutive_failures: 0, next_collection_at: null });
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

test("activity projects retained sources, accumulation, cooldown and halt from project-owned durable history", async () => {
  await withKnowledgeDatabase(async db => {
    const owner = await seedKnowledgeJob(db), halted = await seedKnowledgeJob(db), cooling = await seedKnowledgeJob(db);
    const aged = await seedKnowledgeJob(db);
    await source(db, owner.projectId, owner.jobId, "source_registered", { body: "private source body" });
    await source(db, halted.projectId, halted.jobId, "source_registered");
    await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,at)
      VALUES('system','scheduler','project_knowledge.source_registered',${aged.projectId},'job',${aged.jobId},'ok',now()-interval '25 hours')`;
    for (let index = 0; index < 4; index++) await source(db, cooling.projectId, randomUUID(), "source_registered");
    for (const [project, count] of [[halted.projectId, 2], [cooling.projectId, 1]] as const) {
      for (let index = 0; index < count; index++) {
        const work = randomUUID();
        await db`INSERT INTO project_knowledge_work(id,project_id,state,trigger_key,governance_hash,reason,created_at,updated_at)
          VALUES(${work},${project},${index === 0 ? "completed" : "blocked"},${`knowledge:project:${work}`},${hash},
            'private failure body',now()-interval '1 hour'+${index}*interval '1 minute',now()-interval '1 hour'+${index}*interval '1 minute')`;
      }
    }
    const app = Fastify();
    app.addHook("onRequest", async req => { req.actor = { type: "api_token", id: "global", name: "global",
      projectId: null, scopes: ["projects:read"] }; });
    registerKnowledgeActivityRoutes(app, { db: db as never });
    const request = (project: string, offset = 0) => app.inject({ method: "GET",
      url: `/projects/${project}/knowledge/activity?limit=1&offset=${offset}` });
    try {
      const accumulating = await request(owner.projectId);
      assert.equal(accumulating.statusCode, 200, accumulating.body);
      assert.equal(accumulating.json().collection.state, "accumulating");
      assert.equal(accumulating.json().collection.pending_sources, 1);
      assert.equal(accumulating.json().collection.consecutive_failures, 0, "other projects' failures cannot stop this project");
      const [deadline] = await db`SELECT at+interval '24 hours' AS at FROM audit_logs
        WHERE project_id=${owner.projectId} AND action='project_knowledge.source_registered'`;
      assert.equal(Date.parse(accumulating.json().collection.next_collection_at), new Date(deadline!.at).getTime());
      const stopped = await request(halted.projectId);
      assert.equal(stopped.statusCode, 200, stopped.body);
      assert.deepEqual(stopped.json().collection, { state: "halted", pending_sources: 1, consecutive_failures: 2, next_collection_at: null });
      assert.equal(stopped.json().summary.pending_sources, 1, "halted sources remain registered and unconsumed");
      assert.equal(stopped.json().next_offset, 1);
      const stoppedNext = await request(halted.projectId, 1);
      assert.deepEqual(stoppedNext.json().collection, stopped.json().collection);
      assert.equal(stoppedNext.json().next_offset, null);
      const cooldown = await request(cooling.projectId);
      assert.equal(cooldown.statusCode, 200, cooldown.body);
      assert.equal(cooldown.json().collection.state, "cooldown");
      assert.equal(cooldown.json().collection.pending_sources, 4);
      assert.equal(cooldown.json().collection.consecutive_failures, 1, "completed without an active/retired proposal is not output");
      const [batchDeadline] = await db`SELECT created_at+interval '24 hours' AS at FROM project_knowledge_work WHERE project_id=${cooling.projectId}`;
      assert.equal(Date.parse(cooldown.json().collection.next_collection_at), new Date(batchDeadline!.at).getTime());
      const ready = await request(aged.projectId);
      assert.equal(ready.json().collection.state, "ready", "one source becomes ready after 24 hours");
      assert.equal(ready.json().collection.pending_sources, 1);
      const again = await request(halted.projectId);
      assert.deepEqual(again.json().collection, stopped.json().collection, "reading another project does not reset a halt");
      assert.deepEqual(Object.keys(again.json().collection).sort(), ["consecutive_failures", "next_collection_at", "pending_sources", "state"]);
      assert.doesNotMatch(accumulating.body + stopped.body + cooldown.body, /private|after_json|input_manifest|trigger_key|governance_hash/);
      assert.doesNotMatch(stopped.body, new RegExp(`${owner.projectId}|${owner.jobId}|${cooling.projectId}`));
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
