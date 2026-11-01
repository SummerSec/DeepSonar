import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { runMigrations, type MigrationConnection } from "../../migration-runner.js";
import type { Actor } from "../../auth.js";
import { appendQualityRecord } from "./quality-store.js";
import { withQualityHead, advanceQualityHead, persistQualityExposure, loadQualityHistory, type QualityStateDb } from "./quality-state-store.js";
import { qualityDigest, QUALITY_METRIC_VERSION, QUALITY_POPULATION_VERSION, QUALITY_LABEL_MAPPING_VERSION } from "./quality-contract.js";
import { STRONG_RELATION_RULE_VERSION } from "./identity.js";
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
    const name = `quality_state_${randomUUID().replaceAll("-", "")}`;
    assert.match(name, /^quality_state_[a-f0-9]{32}$/);
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
            assert.match(name, /^quality_state_[a-f0-9]{32}$/);
            await admin.unsafe(`DROP DATABASE "${name}"`);
        }
        await admin.end({
            timeout: 5
        });
    }
}
async function fixture(db: Db) {
    const project = randomUUID(), protocol = randomUUID(), digest = qualityDigest("synthetic SQL metadata"), actor: Actor = {
        type: "user", id: randomUUID(), name: "synthetic operator", role: "admin", scopes: ["admin"], projectId: project
    };
    const scope = {
        project_id: project, code_digest: digest, config_digest: digest, selector_digest: digest, normalization_digest: digest, strong_rule_digest: digest, extractor_version: "synthetic/v1", normalization_version: "synthetic/v1", strong_rule_version: STRONG_RELATION_RULE_VERSION, metric_version: QUALITY_METRIC_VERSION, population_version: QUALITY_POPULATION_VERSION, label_mapping_version: QUALITY_LABEL_MAPPING_VERSION, source_digest: digest, corpus_digest: digest, dataset_digest: digest, tuning_digest: digest, split_digest: digest, labelset_digest: digest
    };
    const body = {
        schema_version: 1, scope, thresholds: {
            same_problem: {
                precision: 1, recall: 1
            }, same_root_cause_different_instance: {
                precision: 1, recall: 1
            }
        }, valid_until: "2099-01-01T00:00:00Z"
    };
    const common = {
        protocol_digest: qualityDigest(body), scope_digest: qualityDigest(scope)
    }, stateDb = db as unknown as QualityStateDb;
    await db `INSERT INTO projects(id,name) VALUES(${project},'synthetic quality state fixture')`;
    await db `INSERT INTO project_finding_quality_protocols(id,project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_id,created_by_actor_name) VALUES(${protocol},${project},${common.protocol_digest},${db.json(body)},${actor.type},${actor.id},${actor.name})`;
    const registered = await appendQualityRecord(stateDb, {
        projectId: project, protocolId: protocol, kind: "registered", actor, body: {
            ...common, maker_ids: [actor.id], tuner_ids: [actor.id]
        }
    });
    await db `INSERT INTO project_finding_quality_heads(project_id,protocol_id,phase,latest_record_id) VALUES(${project},${protocol},'registered',${String(registered.id)})`;
    await db `INSERT INTO project_finding_quality_current(project_id) VALUES(${project})`;
    await withQualityHead(project, protocol, "0", async (tx, h) => {
        const record = await appendQualityRecord(tx, {
            projectId: project, protocolId: protocol, kind: "freeze", actor, subjectId: String(registered.id), body: {
                ...common, thresholds_digest: qualityDigest(body.thresholds)
            }
        });
        return advanceQualityHead(tx, h, record, "frozen");
    }, stateDb);
    const declaration = await withQualityHead(project, protocol, "1", async (tx, h) => {
        const record = await appendQualityRecord(tx, {
            projectId: project, protocolId: protocol, kind: "dataset_declaration", actor, subjectId: h.freeze_record_id!, body: {
                ...common, dataset_digest: scope.dataset_digest
            }
        });
        await advanceQualityHead(tx, h, record, "frozen");
        return record;
    }, stateDb);
    return {
        project, protocol, actor, common, stateDb, input: {
            projectId: project, protocolId: protocol, declarationId: String(declaration.id), actor
        }
    };
}
test("genuine PostgreSQL: committed raw access survives later parse/revoke/retry and CAS conflict", options, async () => {
    await isolated(async (db) => {
        const f = await fixture(db), first = await persistQualityExposure({
            ...f.input, requestKey: "first"
        }, f.stateDb);
        assert.throws(() => JSON.parse("{"));
        await withQualityHead(f.project, f.protocol, "3", async (tx, h) => {
            const r = await appendQualityRecord(tx, {
                projectId: f.project, protocolId: f.protocol, kind: "revoke", actor: f.actor, subjectId: h.latest_record_id, body: {
                    ...f.common, reason: "synthetic revoke"
                }
            });
            return advanceQualityHead(tx, h, r, "revoked");
        }, f.stateDb);
        const second = await persistQualityExposure({
            ...f.input, requestKey: "second"
        }, f.stateDb);
        assert.notEqual(first.record.id, second.record.id);
        assert.equal(second.head.first_access_record_id, first.record.id);
        assert.equal(second.head.phase, "revoked");
        await assert.rejects(persistQualityExposure({
            ...f.input, requestKey: "first"
        }, f.stateDb), /QUALITY_EXPOSURE_REQUEST_CONFLICT/);
        const updates = await Promise.allSettled([1, 2].map(n => withQualityHead(f.project, f.protocol, "5", async (tx, h) => {
            const record = await appendQualityRecord(tx, {
                projectId: f.project, protocolId: f.protocol, kind: "rejection", actor: f.actor, subjectId: h.latest_record_id, body: {
                    ...f.common, reason: `synthetic retry ${n}`
                }
            });
            return advanceQualityHead(tx, h, record, "revoked");
        }, f.stateDb)));
        assert.equal(updates.filter(r => r.status === "fulfilled").length, 1);
        const rejected = updates.find(r => r.status === "rejected");
        assert.ok(rejected && rejected.status === "rejected");
        assert.match(String(rejected.reason), /QUALITY_HEAD_VERSION_CONFLICT/);
        const history = await loadQualityHistory(f.stateDb, f.project);
        assert.equal(history.records.filter(r => r.kind === "holdout_access").length, 2);
        assert.ok(history.records.some(r => r.kind === "revoke"));
        const [head] = await db `SELECT first_access_record_id,phase,version::text AS version FROM project_finding_quality_heads WHERE project_id=${f.project} AND protocol_id=${f.protocol}`;
        assert.equal(head!.first_access_record_id, first.record.id);
        assert.equal(head!.phase, "revoked");
        assert.equal(head!.version, "6");
        const [current] = await db `SELECT protocol_id,certificate_record_id,scope_digest,version::text AS version FROM project_finding_quality_current WHERE project_id=${f.project}`;
        assert.equal(current!.protocol_id, null);
        assert.equal(current!.certificate_record_id, null);
        assert.equal(current!.scope_digest, null);
        assert.equal(current!.version, "0");
    });
});
