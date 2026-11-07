import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ensureJobNode } from "./dispatcher.js";
import type { FrozenJobSkillCatalog } from "./job-skill-catalog.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./domains/project-knowledge/test-support.js";

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 };

test("existing Job/Intent nodes receive frozen Skill warnings without duplicates or unrelated body/state changes", options, async () => {
  await withKnowledgeDatabase(async db => {
    const job = await seedKnowledgeJob(db), other = await seedKnowledgeJob(db, job.projectId);
    const jobNode = randomUUID(), intentNode = randomUUID(), factNode = randomUUID(), foreignNode = randomUUID();
    const body = { payload: { keep: "original" }, ui_color: "indigo", unrelated: [1, 2] };
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,status,body_json)
      VALUES(${jobNode},${job.canvasId},${job.jobId},'job','existing Job','failed',${db.json(body)}),
            (${intentNode},${job.canvasId},${job.jobId},'intent','existing Intent','cancelled',${db.json(body)}),
            (${foreignNode},${other.canvasId},${job.jobId},'job','foreign canvas','pending',${db.json(body)})`;
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,status,verification_status,body_json)
      VALUES(${factNode},${job.canvasId},${job.jobId},'fact','fact','pending','unverified',${db.json(body)})`;
    const frozen: FrozenJobSkillCatalog = {
      schema: "deepsonar.job-skill-catalog/v1", project_id: job.projectId, catalog_hash: "0".repeat(64), extensions: [], stale: true,
      sources: [{ source_instance_id: randomUUID(), source_id: randomUUID(), name: "fixture", manifest_hash: null,
        module_count: 0, commit_sha: null, content_hash: null, source_revocation_epoch: "0", project_revocation_epoch: "0",
        source_synced_at: null, age_seconds: null, source_update_pending: true }],
    };
    const input = { canvas_id: job.canvasId, type: "explore", payload_json: { cannot_replace: true },
      agent_snapshot_json: { job_skill_catalog: frozen } };
    await ensureJobNode(job.jobId, input, db as never);
    await ensureJobNode(job.jobId, input, db as never);
    const rows = await db`SELECT id,status,body_json FROM canvas_nodes WHERE job_id=${job.jobId}`;
    assert.equal(rows.length, 4, "existing Job/Intent projection must not create replacement nodes");
    for (const [id, status] of [[jobNode, "failed"], [intentNode, "cancelled"]]) {
      const row = rows.find(value => value.id === id)!;
      assert.equal(row.status, status);
      assert.match(row.body_json.skill_catalog_warning, /从未成功同步/);
      assert.match(row.body_json.skill_catalog_warning, /待审批候选/);
      const { skill_catalog_warning: _warning, ...rest } = row.body_json;
      assert.deepEqual(rest, body);
    }
    for (const id of [factNode, foreignNode]) {
      const row = rows.find(value => value.id === id)!;
      assert.equal(row.status, "pending"); assert.deepEqual(row.body_json, body);
    }
    assert.equal((await db`SELECT count(*)::int AS n FROM canvas_edges WHERE canvas_id=${job.canvasId}`)[0].n, 0);
    // The same field can be cleared without replacing the rest of an existing body.
    await ensureJobNode(job.jobId, { ...input, agent_snapshot_json: { job_skill_catalog: {
      ...frozen, stale: false, sources: frozen.sources.map(source => ({ ...source, source_update_pending: false })),
    } } }, db as never);
    const cleared = await db`SELECT status,body_json FROM canvas_nodes WHERE id = ANY(${[jobNode, intentNode]})`;
    assert.ok(cleared.every(row => !Object.hasOwn(row.body_json, "skill_catalog_warning")));
    assert.deepEqual(cleared.map(row => row.status).sort(), ["cancelled", "failed"]);
    for (const row of cleared) assert.deepEqual(row.body_json, body);
  });
});
