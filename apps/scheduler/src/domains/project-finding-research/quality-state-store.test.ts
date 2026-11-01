import test from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../../auth.js";
import { withQualityHead, advanceQualityHead, persistQualityExposure, loadQualityHistory, type QualityStateDb, type QualityHead } from "./quality-state-store.js";
import { qualityDigest, qualityDatasetDigests, QualityContractError, assertQualityBudget, QUALITY_INPUT_BYTES, QUALITY_TRACE_LIMIT, QUALITY_METRIC_VERSION, QUALITY_POPULATION_VERSION, QUALITY_LABEL_MAPPING_VERSION } from "./quality-contract.js";
import { STRONG_RELATION_RULE_VERSION } from "./identity.js";
// Synthetic SQL query/bind/rollback behavior only; mocks are not PostgreSQL or human/quality evidence.
type Row = Record<string, unknown>;
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const d = qualityDigest("synthetic"), p = id(99), proto = id(80);
const actor: Actor = {
    type: "user", id: id(60), name: "synthetic operator", role: "admin", scopes: ["admin"], projectId: p
};
function fixture(frozen = true) {
    const dataset = {
        schema_version: 1, kind: "synthetic", sources: [1, 2, 3].map(n => ({
            id: id(n), source_digest: d, identity_digest: d, provenance_digest: d, asset_group_digest: qualityDigest(n), family_group_digest: qualityDigest(n), split: n === 3 ? "tuning" : "holdout"
        })), pairs: [{
                left_id: id(1), right_id: id(2), label: "same_problem", label_evidence_digest: d
            }]
    };
    const scope = {
        project_id: p, code_digest: d, config_digest: d, selector_digest: d, normalization_digest: d, strong_rule_digest: d, extractor_version: "synthetic/v1", normalization_version: "synthetic/v1", strong_rule_version: STRONG_RELATION_RULE_VERSION, metric_version: QUALITY_METRIC_VERSION, population_version: QUALITY_POPULATION_VERSION, label_mapping_version: QUALITY_LABEL_MAPPING_VERSION, corpus_digest: d, ...qualityDatasetDigests(dataset)
    };
    const body = {
        schema_version: 1, scope, thresholds: {
            same_problem: {
                precision: 1, recall: 1
            }, same_root_cause_different_instance: {
                precision: 1, recall: 1
            }
        }, valid_until: "2099-01-01T00:00:00Z"
    }, pd = qualityDigest(body), common = {
        protocol_digest: pd, scope_digest: qualityDigest(scope)
    };
    const row = (kind: string, b: Row, subject: string | null, n: number) => sign({
        id: id(n), project_id: p, protocol_id: proto, kind, subject_record_id: subject, request_key: null, actor_type: "user", actor_id: actor.id, actor_name: actor.name, body_json: {
            ...common, ...b
        }, created_at: new Date("2026-11-01T00:00:00Z")
    });
    const registered = row("registered", {
        maker_ids: [actor.id], tuner_ids: [actor.id]
    }, null, 10), freeze = row("freeze", {
        thresholds_digest: qualityDigest(body.thresholds)
    }, id(10), 11), declaration = row("dataset_declaration", {
        dataset_digest: scope.dataset_digest
    }, id(11), 12);
    const head: Row = {
        project_id: p, protocol_id: proto, version: frozen ? "2" : "0", phase: frozen ? "frozen" : "registered", latest_record_id: frozen ? id(12) : id(10), freeze_record_id: frozen ? id(11) : null, declaration_record_id: frozen ? id(12) : null, first_access_record_id: null, dataset_record_id: null, evaluation_record_id: null, review_record_id: null, revocation_record_id: null, updated_at: new Date("2026-11-01T00:00:00Z")
    };
    return {
        head, records: frozen ? [registered, freeze, declaration] : [registered], protocols: [{
                id: proto, project_id: p, protocol_digest: pd, body_json: body
            }], row, dataset, scope, common, freeze, declaration
    };
}
function sign(r: Row) {
    r.record_digest = qualityDigest({
        id: r.id, project_id: r.project_id, protocol_id: r.protocol_id, kind: r.kind, subject_record_id: r.subject_record_id, actor: {
            type: r.actor_type, id: r.actor_id ?? null, name: r.actor_name
        }, body: r.body_json
    });
    return r;
}
function mock(f = fixture()) {
    const calls: Array<{
        text: string;
        values: unknown[];
    }> = [], events: string[] = [];
    let failCas = false;
    const tag = async (strings: TemplateStringsArray, ...v: unknown[]) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        calls.push({
            text, values: v
        });
        if (text.startsWith("WITH protocols"))
            return [{
                    history_overflow: false, protocol_rows: structuredClone(f.protocols.slice(0, Number(v[1]))), records: structuredClone(f.records.slice(0, Number(v[3])))
                }];
        if (text.includes("FROM project_finding_quality_current"))
            return [{
                    project_id: p, version: "0"
                }];
        if (text.includes("FROM project_finding_quality_heads"))
            return v[0] === p && v[1] === proto ? [structuredClone(f.head)] : [];
        if (text.includes("FROM project_finding_quality_protocols"))
            return f.protocols.filter(r => r.project_id === v[0] && r.id === v[1]).map(r => structuredClone(r));
        if (text.includes("FROM project_finding_quality_records"))
            return f.records.filter(r => r.project_id === v[0] && r.protocol_id === v[1] && (text.includes("request_key") ? r.kind === "holdout_access" && r.request_key === v[2] : r.id === v[2])).map(r => structuredClone(r));
        if (text.startsWith("INSERT INTO project_finding_quality_records")) {
            const r = {
                id: v[0], project_id: v[1], protocol_id: v[2], kind: v[3], record_digest: v[4], subject_record_id: v[5], request_key: v[6], actor_type: v[7], actor_id: v[8], actor_name: v[9], body_json: v[10], created_at: new Date("2026-11-01T00:00:01Z")
            };
            f.records.push(r);
            return [structuredClone(r)];
        }
        if (text.startsWith("UPDATE project_finding_quality_heads")) {
            if (failCas || v[9] !== p || v[10] !== proto || v[11] !== f.head.version)
                return [];
            f.head = {
                ...f.head, version: (BigInt(String(f.head.version)) + 1n).toString(), phase: v[0], latest_record_id: v[1], freeze_record_id: v[2], declaration_record_id: v[3], first_access_record_id: f.head.first_access_record_id ?? v[4], dataset_record_id: v[5], evaluation_record_id: v[6], review_record_id: v[7], revocation_record_id: v[8]
            };
            return [structuredClone(f.head)];
        }
        throw new Error(`unexpected SQL ${text}`);
    };
    const db = Object.assign(tag, {
        json: (v: unknown) => v, begin: async (run: (tx: QualityStateDb) => Promise<unknown>) => {
            const before = structuredClone({
                head: f.head, records: f.records
            });
            events.push("begin");
            try {
                const result = await run(db as unknown as QualityStateDb);
                events.push("commit");
                return result;
            }
            catch (e) {
                f.head = before.head;
                f.records = before.records;
                events.push("rollback");
                throw e;
            }
        }
    }) as unknown as QualityStateDb;
    return {
        f, db, calls, events, fail: () => {
            failCas = true;
        }
    };
}
function seedMetadata(f: ReturnType<typeof fixture>) {
    const binding = {
        protocol_id: proto, run_id: id(70), dataset_id: id(51), protocol_digest: f.common.protocol_digest, scope: f.scope, evaluated_at: "2026-11-01T00:00:00Z"
    };
    f.records.push(f.row("holdout_access", {
        dataset_digest: f.scope.dataset_digest
    }, id(12), 50), f.row("holdout_payload", {
        dataset: f.dataset
    }, id(50), 49), f.row("dataset_admission", {
        dataset_digest: f.scope.dataset_digest
    }, id(49), 51), f.row("evaluation", {
        binding, report_digest: d
    }, id(51), 52), f.row("review", {
        run_id: id(70), dataset_id: id(51), report_digest: d, evidence_digest: null, expires_at: "2098-01-01T00:00:00Z"
    }, id(52), 53), f.row("revoke", {
        reason: "synthetic"
    }, id(53), 54));
}
const expose = (requestKey?: string) => ({
    projectId: p, protocolId: proto, declarationId: id(12), actor, requestKey
});
const codeIs = (code: string) => (e: unknown) => e instanceof QualityContractError && e.code === code;
test("project current lock precedes exact bigint head CAS and no certificate write", async () => {
    const m = mock();
    const head = await withQualityHead(p, proto, "2", async (_tx, h) => h, m.db);
    assert.equal(head.version, "2");
    assert.ok(Object.isFrozen(head));
    assert.match(m.calls[0]!.text, /quality_current.*FOR UPDATE/);
    assert.match(m.calls[1]!.text, /quality_heads.*FOR UPDATE/);
    assert.deepEqual(m.calls[1]!.values, [p, proto]);
    assert.deepEqual(m.events, ["begin", "commit"]);
    assert.ok(!m.calls.some(c => /^UPDATE.*quality_current/.test(c.text)));
});
for (const value of [2, "02", " 2", "-1", "9223372036854775808"]) {
    test(`noncanonical bigint ${JSON.stringify(value)} never opens transaction`, async () => {
        const m = mock();
        await assert.rejects(withQualityHead(p, proto, value as string, async () => null, m.db), codeIs("QUALITY_VERSION_INVALID"));
        assert.equal(m.calls.length, 0);
    });
}
test("stale version never invokes callback", async () => {
    const m = mock();
    let called = false;
    await assert.rejects(withQualityHead(p, proto, "1", async () => {
        called = true;
    }, m.db), codeIs("QUALITY_HEAD_VERSION_CONFLICT"));
    assert.equal(called, false);
    assert.deepEqual(m.events, ["begin", "rollback"]);
});
test("freeze derives only its pointer and CAS uses exact string", async () => {
    const m = mock(fixture(false));
    m.f.records.push(m.f.freeze);
    const h = await withQualityHead(p, proto, "0", (tx, head) => advanceQualityHead(tx, head, m.f.freeze, "frozen", {
        freeze_record_id: id(11)
    }), m.db);
    assert.equal(h.version, "1");
    assert.equal(h.freeze_record_id, id(11));
    const q = m.calls.find(c => c.text.startsWith("UPDATE"))!;
    assert.match(q.text, /version=version\+1/);
    assert.deepEqual(q.values.slice(9), [p, proto, "0"]);
    assert.match(q.text, /first_access_record_id=COALESCE/);
});
test("exposure commits before malformed or oversized raw payload can fail", async () => {
    const m = mock();
    const result = await persistQualityExposure(expose("first"), m.db);
    assert.deepEqual(m.events, ["begin", "commit"]);
    assert.throws(() => JSON.parse("{"));
    assert.throws(() => assertQualityBudget({
        raw: "x".repeat(QUALITY_INPUT_BYTES + 1)
    }), codeIs("QUALITY_INPUT_LIMIT"));
    assert.equal(m.f.head.first_access_record_id, result.record.id);
    assert.equal(m.f.head.phase, "frozen");
    assert.deepEqual(Object.keys(result.record.body_json as Row).sort(), ["dataset_digest", "protocol_digest", "scope_digest"]);
});
test("new keys and unkeyed retries create distinct rows without replacing first access", async () => {
    const m = mock(), a = await persistQualityExposure(expose("a"), m.db), b = await persistQualityExposure(expose("b"), m.db), c = await persistQualityExposure(expose(), m.db);
    assert.equal(new Set([a.record.id, b.record.id, c.record.id]).size, 3);
    assert.equal(m.f.head.first_access_record_id, a.record.id);
    assert.equal(m.f.head.version, "5");
});
test("unknown raw identity rejects every reused key including changed actor/declaration", async () => {
    const m = mock(), a = await persistQualityExposure(expose("same"), m.db);
    m.f.records.push({
        ...m.f.declaration, id: id(13)
    });
    sign(m.f.records.at(-1)!);
    for (const input of [expose("same"), {
            ...expose("same"), actor: {
                ...actor, id: id(61)
            }
        }, {
            ...expose("same"), declarationId: id(13)
        }])
        await assert.rejects(persistQualityExposure(input, m.db), codeIs("QUALITY_EXPOSURE_REQUEST_CONFLICT"));
    assert.equal(m.f.head.first_access_record_id, a.record.id);
    assert.equal(m.f.records.filter(r => r.kind === "holdout_access").length, 1);
});
for (const phase of ["revoked", "blocked", "admitted", "evaluated", "reviewed"]) {
    test(`exposure never downgrades ${phase} or erases pointers`, async () => {
        const m = mock();
        seedMetadata(m.f);
        Object.assign(m.f.head, {
            phase, first_access_record_id: id(50), dataset_record_id: id(51), evaluation_record_id: id(52), review_record_id: id(53), revocation_record_id: id(54)
        });
        await persistQualityExposure(expose("new"), m.db);
        assert.equal(m.f.head.phase, phase);
        for (const [k, n] of [["first_access_record_id", 50], ["dataset_record_id", 51], ["evaluation_record_id", 52], ["review_record_id", 53], ["revocation_record_id", 54]] as const)
            assert.equal(m.f.head[k], id(n));
    });
}
test("SQL CAS failure rolls back only its new attempt, not known first access", async () => {
    const m = mock(), a = await persistQualityExposure(expose("a"), m.db);
    m.fail();
    await assert.rejects(persistQualityExposure(expose("b"), m.db), codeIs("QUALITY_HEAD_VERSION_CONFLICT"));
    assert.equal(m.f.head.first_access_record_id, a.record.id);
    assert.equal(m.f.records.filter(r => r.kind === "holdout_access").length, 1);
});
for (const change of ["kind", "scope", "digest", "subject", "project", "protocol", "dataset"]) {
    test(`exposure fails closed on declaration ${change}`, async () => {
        const m = mock(), r = m.f.records[2]!;
        if (change === "kind") {
            r.kind = "rejection";
            r.body_json = {
                ...m.f.common, reason: "synthetic"
            };
        }
        if (change === "scope")
            (r.body_json as Row).scope_digest = qualityDigest("wrong");
        if (change === "subject")
            r.id = id(18);
        if (change === "project")
            r.project_id = id(999);
        if (change === "protocol")
            r.protocol_id = id(888);
        if (change === "dataset")
            (r.body_json as Row).dataset_digest = qualityDigest("wrong");
        sign(r);
        if (change === "digest")
            r.record_digest = qualityDigest("wrong");
        await assert.rejects(persistQualityExposure(expose("bad"), m.db));
        assert.equal(m.f.head.first_access_record_id, null);
        assert.equal(m.f.records.filter(x => x.kind === "holdout_access").length, 0);
    });
}
test("undefined/non-authority actor and unknown client fields cannot open write transaction", async () => {
    const m = mock();
    for (const input of [{
            ...expose(), actor: {
                ...actor, type: "internal"
            }
        }, {
            ...expose(), approved: true
        }, {
            ...expose(), actor: undefined
        }])
        await assert.rejects(persistQualityExposure(input as never, m.db));
    assert.equal(m.events.length, 0);
});
test("fake, cross-transaction and expired callback head handles cannot write", async () => {
    const m = mock();
    await assert.rejects(advanceQualityHead(m.db, m.f.head as QualityHead, m.f.freeze, "frozen"), codeIs("QUALITY_HEAD_NOT_LOCKED"));
    let saved: QualityHead | undefined;
    await withQualityHead(p, proto, "2", async (tx, h) => {
        saved = h;
        await assert.rejects(advanceQualityHead(mock().db, h, m.f.freeze, "frozen"), codeIs("QUALITY_HEAD_NOT_LOCKED"));
    }, m.db);
    await assert.rejects(advanceQualityHead(m.db, saved!, m.f.freeze, "frozen"), codeIs("QUALITY_HEAD_NOT_LOCKED"));
});
for (const bad of ["phase", "threshold", "undurable", "update", "null"]) {
    test(`freeze rejects ${bad} before SQL head write`, async () => {
        const m = mock(fixture(false));
        let r = m.f.freeze;
        if (bad === "threshold") {
            (r.body_json as Row).thresholds_digest = qualityDigest("wrong");
            sign(r);
        }
        if (bad !== "undurable")
            m.f.records.push(r);
        await assert.rejects(withQualityHead(p, proto, "0", (tx, h) => advanceQualityHead(tx, h, r, bad === "phase" ? "reviewed" : "frozen", bad === "update" ? {
            dataset_record_id: id(77)
        } : bad === "null" ? {
            first_access_record_id: null
        } : {}), m.db));
        assert.equal(m.f.head.version, "0");
        assert.ok(!m.calls.some(c => c.text.startsWith("UPDATE")));
    });
}
test("max exact bigint locks but refuses increment before overflow", async () => {
    const m = mock(fixture(false));
    m.f.head.version = "9223372036854775807";
    m.f.records.push(m.f.freeze);
    await assert.rejects(withQualityHead(p, proto, String(m.f.head.version), (tx, h) => advanceQualityHead(tx, h, m.f.freeze, "frozen"), m.db), codeIs("QUALITY_VERSION_EXHAUSTED"));
});
test("history reads one project snapshot including old protocols/revocations with no active filter", async () => {
    const m = mock();
    m.f.protocols.push({
        ...m.f.protocols[0]!, id: id(81)
    });
    m.f.records.push(m.f.row("revoke", {
        reason: "synthetic old revoke"
    }, id(12), 17));
    const history = await loadQualityHistory(m.db, p);
    assert.equal(history.protocol_rows.length, 2);
    assert.equal(history.records.length, 4);
    assert.equal(m.calls.length, 1);
    assert.deepEqual(m.calls[0]!.values, [p, QUALITY_TRACE_LIMIT + 1, p, QUALITY_TRACE_LIMIT + 1, QUALITY_INPUT_BYTES]);
    assert.doesNotMatch(m.calls[0]!.text, /valid_until|phase|quality_current|DELETE/);
});
for (const key of ["records", "protocols"] as const)
    test(`history ${key} overflow is not false completeness`, async () => {
        const m = mock();
        if (key === "records")
            m.f.records = Array.from({
                length: QUALITY_TRACE_LIMIT + 1
            }, () => m.f.records[0]!);
        else
            m.f.protocols = Array.from({
                length: QUALITY_TRACE_LIMIT + 1
            }, () => m.f.protocols[0]!);
        await assert.rejects(loadQualityHistory(m.db, p), codeIs("QUALITY_HISTORY_LIMIT"));
    });
test("payload/admission/evaluation/review metadata bind exact durable dataset/run/report", async () => {
    const m = mock();
    const access = await persistQualityExposure(expose("run"), m.db);
    const time = "2026-11-01T00:00:01Z";
    const rows = [m.f.row("holdout_payload", {
            dataset: m.f.dataset
        }, String(access.record.id), 20), m.f.row("dataset_admission", {
            dataset_digest: m.f.scope.dataset_digest
        }, id(20), 21), m.f.row("evaluation", {
            binding: {
                protocol_id: proto, run_id: id(30), dataset_id: id(21), protocol_digest: m.f.common.protocol_digest, scope: m.f.scope, evaluated_at: time
            }, report_digest: d
        }, id(21), 22), m.f.row("review", {
            run_id: id(30), dataset_id: id(21), report_digest: d, evidence_digest: null, expires_at: "2098-01-01T00:00:00Z"
        }, id(22), 23)];
    for (const [i, phase] of ["frozen", "admitted", "evaluated", "reviewed"].entries()) {
        const r = rows[i]!;
        r.created_at = new Date(time);
        m.f.records.push(r);
        await withQualityHead(p, proto, String(m.f.head.version), (tx, h) => advanceQualityHead(tx, h, r, phase as never), m.db);
    }
    assert.equal(m.f.head.phase, "reviewed");
    assert.equal(m.f.head.dataset_record_id, id(21));
    assert.equal(m.f.head.review_record_id, id(23));
    assert.ok(!m.calls.some(c => c.text.startsWith("UPDATE project_finding_quality_current")));
});
for (const field of ["run_id", "dataset_id", "report_digest"] as const)
    test(`review rejects wrong actual ${field} binding`, async () => {
        const m = mock();
        seedMetadata(m.f);
        Object.assign(m.f.head, {
            phase: "evaluated", dataset_record_id: id(51), evaluation_record_id: id(52)
        });
        const r = m.f.records.find(r => r.id === id(53))!;
        (r.body_json as Row)[field] = field === "report_digest" ? qualityDigest("wrong") : id(71);
        sign(r);
        await assert.rejects(withQualityHead(p, proto, "2", (tx, h) => advanceQualityHead(tx, h, r, "reviewed"), m.db), codeIs("QUALITY_STATE_SCOPE_MISMATCH"));
        assert.equal(m.f.head.phase, "evaluated");
    });
