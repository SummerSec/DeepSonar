import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runMigrations, type MigrationConnection } from "../../migration-runner.js";
import type { Actor } from "../../auth.js";
import { appendQualityRecord } from "./quality-store.js";
import { bootFindingQualityAssets } from "./quality-assets.js";
import { qualityDatasetDigests, qualityDigest } from "./quality-contract.js";
import { processFindingQualityWork } from "./quality-worker.js";
import type { QualityStateDb } from "./quality-state-store.js";
// Genuine PostgreSQL behavior when explicitly configured; synthetic metadata is never quality/human proof.
const url = process.env.TEST_DATABASE_URL?.trim();
const options = {
  skip: url ? false : "TEST_DATABASE_URL is not set; no default/production DB is used"
};
type Db = ReturnType<typeof postgres>;
async function isolated(run: (db: Db) => Promise<void>) {
  assert.ok(url);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const name = `quality_worker_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^quality_worker_[a-f0-9]{32}$/);
  const target = new URL(url);
  target.pathname = `/${name}`;
  target.search = "";
  const admin = postgres(adminUrl.toString(), {
    max: 1
  });
  let db: Db | undefined, created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    db = postgres(target.toString(), {
      max: 2
    });
    const tx = await db.reserve();
    try {
      await runMigrations(tx as unknown as MigrationConnection);
    }
    finally {
      tx.release();
    }
    await run(db);
  }
  finally {
    await db?.end({
      timeout: 5
    });
    if (created) {
      assert.equal(target.pathname, `/${name}`);
      assert.match(name, /^quality_worker_[a-f0-9]{32}$/);
      await admin.unsafe(`DROP DATABASE "${name}"`);
    }
    await admin.end({
      timeout: 5
    });
  }
}
/** Actual PostgreSQL-only failure/rollback/terminal-state evidence; no mocks or quality proof. */
test("genuine PostgreSQL: empty holdout becomes stable failed work without evaluation/certificate", options, async () => {
  await isolated(async (db) => {
    const project = randomUUID(), protocol = randomUUID(), runId = randomUUID(), digest = qualityDigest("synthetic worker SQL fixture"), loaded = bootFindingQualityAssets();
    const actor: Actor = { type: "user", id: randomUUID(), name: "synthetic operator", projectId: project, scopes: ["admin"], role: "admin" };
    const dataset = { schema_version: 1, kind: "synthetic", sources: [], pairs: [] };
    const scope = { project_id: project, corpus_digest: digest, code_digest: loaded.code_digest, config_digest: loaded.config_digest, selector_digest: loaded.selector_digest, normalization_digest: loaded.normalization_digest, strong_rule_digest: loaded.strong_rule_digest, extractor_version: loaded.extractor_version, normalization_version: loaded.normalization_version, strong_rule_version: loaded.strong_rule_version, metric_version: loaded.metric_version, population_version: loaded.population_version, label_mapping_version: loaded.label_mapping_version, ...qualityDatasetDigests(dataset) };
    const body = { schema_version: 1, scope, thresholds: { same_problem: { precision: 1, recall: 1 }, same_root_cause_different_instance: { precision: 1, recall: 1 } }, valid_until: "2099-01-01T00:00:00Z" };
    const common = { protocol_digest: qualityDigest(body), scope_digest: qualityDigest(scope) }, stateDb = db as unknown as QualityStateDb;
    await db `INSERT INTO projects(id,name) VALUES(${project},'synthetic quality worker fixture')`;
    await db `INSERT INTO project_finding_quality_protocols(id,project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_id,created_by_actor_name) VALUES(${protocol},${project},${common.protocol_digest},${db.json(body)},${actor.type},${actor.id},${actor.name})`;
    const registered = await appendQualityRecord(stateDb, { projectId: project, protocolId: protocol, kind: "registered", actor, body: { ...common, maker_ids: [actor.id], tuner_ids: [] } });
    const freeze = await appendQualityRecord(stateDb, { projectId: project, protocolId: protocol, kind: "freeze", actor, subjectId: String(registered.id), body: { ...common, thresholds_digest: qualityDigest(body.thresholds) } });
    const declaration = await appendQualityRecord(stateDb, { projectId: project, protocolId: protocol, kind: "dataset_declaration", actor, subjectId: String(freeze.id), body: { ...common, dataset_digest: scope.dataset_digest } });
    const access = await appendQualityRecord(stateDb, { projectId: project, protocolId: protocol, kind: "holdout_access", actor, subjectId: String(declaration.id), body: { ...common, dataset_digest: scope.dataset_digest } });
    const payload = await appendQualityRecord(stateDb, { projectId: project, protocolId: protocol, kind: "holdout_payload", actor, subjectId: String(access.id), body: { ...common, dataset } });
    const admission = await appendQualityRecord(stateDb, { projectId: project, protocolId: protocol, kind: "dataset_admission", actor, subjectId: String(payload.id), body: { ...common, dataset_digest: scope.dataset_digest } });
    await db `INSERT INTO project_finding_quality_heads(project_id,protocol_id,version,phase,latest_record_id,freeze_record_id,declaration_record_id,first_access_record_id,dataset_record_id) VALUES(${project},${protocol},7,'admitted',${String(admission.id)},${String(freeze.id)},${String(declaration.id)},${String(access.id)},${String(admission.id)})`;
    await db `INSERT INTO project_finding_quality_current(project_id) VALUES(${project})`;
    await db `INSERT INTO project_finding_quality_work(project_id,protocol_id,dataset_record_id,state_json) VALUES(${project},${protocol},${String(admission.id)},${db.json({ run_id: runId, next_ordinal: 0 })})`;
    assert.equal(await processFindingQualityWork(stateDb), true);
    const [work] = await db `SELECT status,last_error_code,generation::text AS generation,processed_generation::text AS processed_generation,state_json,evaluation_record_id FROM project_finding_quality_work WHERE project_id=${project} AND protocol_id=${protocol}`;
    assert.equal(work!.status, "failed");
    assert.equal(work!.last_error_code, "QUALITY_EMPTY_HOLDOUT");
    assert.equal(work!.generation, "1");
    assert.equal(work!.processed_generation, "0");
    assert.equal(work!.evaluation_record_id, null);
    assert.deepEqual(work!.state_json, { run_id: runId, next_ordinal: 0 });
    assert.equal(await processFindingQualityWork(stateDb), false);
    const [count] = await db `SELECT count(*)::int AS count FROM project_finding_quality_observations WHERE project_id=${project}`;
    assert.equal(count!.count, 0);
    const [current] = await db `SELECT protocol_id,certificate_record_id,scope_digest,version::text AS version FROM project_finding_quality_current WHERE project_id=${project}`;
    assert.deepEqual({ ...current }, { protocol_id: null, certificate_record_id: null, scope_digest: null, version: "0" });
    const [head] = await db `SELECT phase,first_access_record_id,evaluation_record_id FROM project_finding_quality_heads WHERE project_id=${project} AND protocol_id=${protocol}`;
    assert.equal(head!.phase, "admitted");
    assert.equal(head!.first_access_record_id, access.id);
    assert.equal(head!.evaluation_record_id, null);
  });
});
