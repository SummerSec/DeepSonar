import test from "node:test";
import assert from "node:assert/strict";
import { qualityDigest, qualityDatasetDigests, QualityContractError, QUALITY_METRIC_VERSION, QUALITY_POPULATION_VERSION, QUALITY_LABEL_MAPPING_VERSION, QUALITY_INPUT_BYTES } from "./quality-contract.js";
import { STRONG_RELATION_RULE_VERSION } from "./identity.js";
import { validateQualityRecord, validateQualityReceiptChain, summarizeQualityHistory, QualityLedgerValidationError } from "./quality-ledger.js";
import type { QualityRecordKind } from "./quality-store.js";
// Synthetic receipts/principals/labels only: never real humans, approved thresholds or quality evidence.
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const d = qualityDigest("synthetic"), at = (n: number) => `2026-11-01T00:00:${n.toString().padStart(2, "0")}Z`;
type Row = Record<string, unknown>;
function sign(r: Row): Row {
    r.record_digest = qualityDigest({
        id: r.id, project_id: r.project_id, protocol_id: r.protocol_id, kind: r.kind, subject_record_id: r.subject_record_id, actor: {
            type: r.actor_type, id: r.actor_id, name: r.actor_name
        }, body: r.body_json
    });
    return r;
}
const body = (r: Row) => r.body_json as Row;
function fixture(pid = 80, offset = 0, codeDigest = d, corpus = d) {
    const dataset = {
        schema_version: 1, kind: "synthetic", sources: [1, 2, 3].map(n => ({
            id: id(n), source_digest: d, identity_digest: d, provenance_digest: d, asset_group_digest: qualityDigest(n), family_group_digest: qualityDigest(n), split: n === 3 ? "tuning" : "holdout"
        })), pairs: [{
                left_id: id(1), right_id: id(2), label: "same_problem", label_evidence_digest: d
            }]
    };
    const scope = {
        project_id: id(99), code_digest: codeDigest, config_digest: d, selector_digest: d, normalization_digest: d, strong_rule_digest: d, extractor_version: "synthetic/v1", normalization_version: "synthetic/v1", strong_rule_version: STRONG_RELATION_RULE_VERSION,
        metric_version: QUALITY_METRIC_VERSION, population_version: QUALITY_POPULATION_VERSION, label_mapping_version: QUALITY_LABEL_MAPPING_VERSION, corpus_digest: corpus, ...qualityDatasetDigests(dataset)
    };
    const protocolBody = {
        schema_version: 1, scope, thresholds: {
            same_problem: {
                precision: 1, recall: 1
            }, same_root_cause_different_instance: {
                precision: 1, recall: 1
            }
        }, valid_until: at(59)
    };
    const pd = qualityDigest(protocolBody), base = {
        protocol_digest: pd, scope_digest: qualityDigest(scope)
    };
    const protocolRow = {
        id: id(pid), project_id: id(99), protocol_digest: pd, body_json: protocolBody, created_by_actor_type: "user", created_by_actor_id: id(60), created_by_actor_name: "synthetic maker", created_at: at(offset)
    };
    const binding = {
        protocol_id: id(pid), run_id: id(pid + 10), dataset_id: id(pid * 100 + 106), protocol_digest: pd, scope, evaluated_at: at(offset + 7)
    };
    const defs: Array<[
        QualityRecordKind,
        Row
    ]> = [["registered", {
                maker_ids: [id(60)], tuner_ids: [id(60)]
            }], ["freeze", {
                thresholds_digest: qualityDigest(protocolBody.thresholds)
            }], ["dataset_declaration", {
                dataset_digest: scope.dataset_digest
            }],
        ["holdout_access", {
                dataset_digest: scope.dataset_digest
            }], ["holdout_payload", {
                dataset
            }], ["dataset_admission", {
                dataset_digest: scope.dataset_digest
            }], ["evaluation", {
                binding, report_digest: d
            }], ["review", {
                run_id: binding.run_id, dataset_id: binding.dataset_id, report_digest: d, evidence_digest: null, expires_at: at(58)
            }]];
    const records = defs.map(([kind, b], i) => sign({
        id: id(pid * 100 + 101 + i), project_id: id(99), protocol_id: id(pid), kind, subject_record_id: i ? id(pid * 100 + 100 + i) : null, request_key: null, actor_type: i === 6 ? "internal" : "user", actor_id: i === 7 ? id(61) : i === 6 ? null : id(60), actor_name: i === 7 ? "synthetic reviewer" : i === 6 ? "synthetic worker" : "synthetic maker", body_json: {
            ...base, ...b
        }, created_at: at(offset + i + 1)
    }));
    return {
        project_id: id(99), protocol_id: id(pid), review_id: records[7]!.id, protocol_rows: [protocolRow], records, current_scope: scope, current_time: at(50)
    };
}
function history(f: ReturnType<typeof fixture>) {
    return {
        project_id: f.project_id, protocol_id: f.protocol_id, protocol_rows: f.protocol_rows, records: f.records
    };
}
function extra(f: ReturnType<typeof fixture>, kind: QualityRecordKind, b: Row, subject = f.records[7]!.id) {
    return sign({
        id: id(900 + f.records.length), project_id: f.project_id, protocol_id: f.protocol_id, kind, subject_record_id: subject, request_key: null, actor_type: "user", actor_id: id(62), actor_name: "synthetic operator", body_json: {
            protocol_digest: f.protocol_rows[0]!.protocol_digest, scope_digest: qualityDigest(f.current_scope), ...b
        }, created_at: at(40)
    });
}
test("valid replay yields structural bindings only, never human or quality approval", () => {
    const f = fixture(), before = JSON.stringify(f), a = validateQualityReceiptChain(f);
    assert.equal(a.quality_status, "not_evaluated");
    assert.equal(a.integrity_status, "structurally_valid");
    assert.equal(a.dataset_id, f.records[5]!.id);
    assert.deepEqual(a, validateQualityReceiptChain(f));
    assert.equal(JSON.stringify(f), before);
    assert.ok(a.external_prerequisites.includes("independent_natural_human_evidence"));
});
test("writer envelope accepts nullable internal actor and independent DB Date timestamps", () => {
    const f = fixture(), r = f.records[6]!;
    assert.equal(validateQualityRecord(r).actor_id, null);
    r.created_at = new Date(String(r.created_at));
    assert.doesNotThrow(() => validateQualityRecord(r));
    r.request_key = "synthetic retry";
    assert.doesNotThrow(() => validateQualityRecord(r));
    const changed = {
        ...r, actor_name: "other"
    };
    assert.throws(() => validateQualityRecord(changed), QualityContractError);
});
test("record canonical identifiers, finite bodies, kind and exact digest fail closed", () => {
    const f = fixture();
    for (const patch of [{
            id: "ABCDEF00-0000-4000-8000-000000000001"
        }, {
            kind: "passed"
        }, {
            project_id: id(98)
        }, {
            subject_record_id: id(77)
        }, {
            record_digest: qualityDigest("wrong")
        }, {
            created_at: "not time"
        }, {
            actor_id: undefined
        }, {
            body_json: {
                bad: NaN
            }
        }, {
            unknown: true
        }])
        assert.throws(() => validateQualityRecord({
            ...f.records[0], ...patch
        }), QualityContractError);
});
const negatives: Array<[
    string,
    (f: ReturnType<typeof fixture>) => void
]> = [
    ["missing freeze", f => {
            f.records.splice(1, 1);
        }],
    ["wrong parent kind", f => {
            f.records[7]!.subject_record_id = f.records[1]!.id;
        }],
    ["cross project", f => {
            f.records[3]!.project_id = id(98);
        }],
    ["wrong scope", f => {
            body(f.records[3]!).scope_digest = qualityDigest("other");
        }],
    ["wrong protocol", f => {
            f.records[3]!.protocol_id = id(79);
        }],
    ["wrong run", f => {
            body(f.records[7]!).run_id = id(700);
        }],
    ["wrong report", f => {
            body(f.records[7]!).report_digest = qualityDigest("other");
        }],
    ["wrong dataset receipt", f => {
            (body(f.records[6]!).binding as Row).dataset_id = id(700);
        }],
    ["threshold mismatch", f => {
            body(f.records[1]!).thresholds_digest = qualityDigest("other");
        }],
    ["current scope stale", f => {
            f.current_scope = {
                ...f.current_scope, config_digest: qualityDigest("other")
            };
        }],
    ["backdated execution", f => {
            (body(f.records[6]!).binding as Row).evaluated_at = at(1);
        }],
    ["out of order", f => {
            f.records[4]!.created_at = at(1);
        }],
    ["expired protocol", f => {
            f.current_time = at(59);
        }],
    ["expired review", f => {
            f.current_time = at(58);
        }],
    ["cyclic subject", f => {
            f.records[3]!.subject_record_id = f.records[3]!.id;
        }],
    ["client flag", f => {
            body(f.records[7]!).passed = true;
        }],
    ["maker reviewer", f => {
            f.records[7]!.actor_id = id(60);
        }],
];
for (const [name, mutate] of negatives)
    test(`chain rejects ${name}`, () => {
        const f = fixture();
        mutate(f);
        f.records.forEach(sign);
        assert.throws(() => validateQualityReceiptChain(f), QualityLedgerValidationError);
    });
test("protocol digest, duplicate replay IDs and unknown flags do not become assurances", () => {
    for (const field of ["passed", "history_complete", "human_authenticated"]) {
        assert.throws(() => validateQualityReceiptChain({
            ...fixture(), [field]: true
        }), QualityLedgerValidationError);
    }
    const f = fixture();
    f.records.push(f.records[0]!);
    assert.throws(() => validateQualityReceiptChain(f), QualityLedgerValidationError);
});
test("malformed and oversized attempted payload preserve earlier durable access", () => {
    for (const invalid of [{
            wrong: true
        }, {
            oversized: "x".repeat(QUALITY_INPUT_BYTES)
        }]) {
        const f = fixture(), first = String(f.records[3]!.id);
        body(f.records[4]!).dataset = invalid;
        sign(f.records[4]!);
        const s = summarizeQualityHistory(history(f));
        assert.equal(s.exposure_status, "unknown");
        assert.equal(s.first_holdout_access_record_id, first);
        assert.throws(() => validateQualityReceiptChain(f), (e: unknown) => e instanceof QualityLedgerValidationError && e.history.first_holdout_access_record_id === first);
    }
});
test("rejected attempts and revocation never reset supplied history", () => {
    const f = fixture(), first = f.records[3]!.id;
    f.records.push(extra(f, "rejection", {
        reason: "synthetic malformed payload"
    }, f.records[3]!.id));
    assert.equal(summarizeQualityHistory(history(f)).first_holdout_access_record_id, first);
    f.records.push(extra(f, "revoke", {
        reason: "synthetic revoke"
    }));
    assert.throws(() => validateQualityReceiptChain(f), (e: unknown) => e instanceof QualityLedgerValidationError && e.history.first_holdout_access_record_id === first);
});
function oldHistory(f: ReturnType<typeof fixture>, corpus = d) {
    const old = fixture(81, 0, qualityDigest("old code"), corpus);
    old.protocol_rows[0]!.body_json.valid_until = at(10);
    old.current_scope.config_digest = qualityDigest("old config");
    const pd = qualityDigest(old.protocol_rows[0]!.body_json);
    old.protocol_rows[0]!.protocol_digest = pd;
    for (const r of old.records) {
        body(r).protocol_digest = pd;
        body(r).scope_digest = qualityDigest(old.current_scope);
        if (r.kind === "evaluation")
            (body(r).binding as Row).protocol_digest = pd;
        if (r.kind === "review")
            body(r).expires_at = at(9);
        sign(r);
    }
    old.records.push(extra(old, "revoke", {
        reason: "synthetic revoked history"
    }));
    f.protocol_rows.push(...old.protocol_rows);
    f.records.push(...old.records);
    return old;
}
test("expired revoked prior protocol and changed code/config cannot reset lifetime", () => {
    const f = fixture(80, 20), old = oldHistory(f), s = summarizeQualityHistory(history(f));
    assert.equal(s.exposure_status, "observed");
    assert.equal(s.first_holdout_access_record_id, old.records[3]!.id);
    assert.throws(() => validateQualityReceiptChain(f), (e: unknown) => e instanceof QualityLedgerValidationError && e.code === "QUALITY_FREEZE_AFTER_EXPOSURE" && e.history.first_holdout_access_record_id === old.records[3]!.id);
});
test("corpus aliases from all histories retain earlier exposure transitively", () => {
    const f = fixture(80, 20), other = qualityDigest("old sealed corpus"), bridge = qualityDigest("corpus alias"), old = oldHistory(f, other);
    f.records.push(extra(f, "alias_resolution", {
        principal_ids: [], corpus_digests: [other, bridge], evidence_digest: null
    }));
    f.records.push(extra(f, "alias_resolution", {
        principal_ids: [], corpus_digests: [bridge, d], evidence_digest: null
    }));
    const s = summarizeQualityHistory(history(f));
    assert.equal(s.first_holdout_access_record_id, old.records[3]!.id);
    assert.throws(() => validateQualityReceiptChain(f), QualityLedgerValidationError);
});
test("principal aliases deny maker overlap without proving human independence", () => {
    const f = fixture();
    f.records.push(extra(f, "alias_resolution", {
        principal_ids: [id(61), id(62)], corpus_digests: [], evidence_digest: null
    }));
    f.records.push(extra(f, "alias_resolution", {
        principal_ids: [id(62), id(60)], corpus_digests: [], evidence_digest: null
    }));
    assert.throws(() => validateQualityReceiptChain(f), (e: unknown) => e instanceof QualityLedgerValidationError && e.code === "QUALITY_REVIEW_PRINCIPAL_CONFLICT");
});
test("unrelated expired revoked corpus does not become a current certificate veto", () => {
    const f = fixture(80, 20);
    oldHistory(f, qualityDigest("different sealed corpus"));
    assert.equal(validateQualityReceiptChain(f).quality_status, "not_evaluated");
});
test("independent principal may freeze thresholds then review, not make/tune/register/custody", () => {
    const f = fixture();
    f.records[1]!.actor_id = id(61);
    sign(f.records[1]!);
    const result = validateQualityReceiptChain(f);
    assert.equal(result.quality_status, "not_evaluated");
    assert.ok(!result.forbidden_principal_ids.includes(id(61)));
    for (const i of [0, 2, 3, 4, 5]) {
        const g = fixture();
        g.records[i]!.actor_id = id(61);
        if (i === 0)
            g.protocol_rows[0]!.created_by_actor_id = id(61);
        sign(g.records[i]!);
        assert.throws(() => validateQualityReceiptChain(g), QualityLedgerValidationError);
    }
});
test("same-ms causal subject lineage permits DB Date timestamp precision loss", () => {
    const f = fixture();
    for (const i of [1, 2, 3])
        f.records[i]!.created_at = new Date(at(2));
    assert.equal(validateQualityReceiptChain(f).quality_status, "not_evaluated");
});
test("unrelated same-ms exposure cannot be hidden behind a causal UUID tie", () => {
    const f = fixture();
    for (const i of [1, 2, 3])
        f.records[i]!.created_at = at(2);
    const freeze = sign({
        ...f.records[1], id: id(90001)
    }), decl = sign({
        ...f.records[2], id: id(90002), subject_record_id: freeze.id
    }), access = sign({
        ...f.records[3], id: id(90003), subject_record_id: decl.id
    });
    f.records.push(freeze, decl, access);
    const s = summarizeQualityHistory(history(f));
    assert.equal(s.first_holdout_access_record_id, f.records[3]!.id);
    assert.throws(() => validateQualityReceiptChain(f), (e: unknown) => e instanceof QualityLedgerValidationError && e.code === "QUALITY_FREEZE_AFTER_EXPOSURE");
});
test("payload bytes, protocol digest and missing historical parents fail closed", () => {
    const f = fixture();
    const packet = body(f.records[4]!).dataset as {
        sources: Array<Row>;
    };
    packet.sources[0]!.source_digest = qualityDigest("changed bytes");
    sign(f.records[4]!);
    assert.throws(() => validateQualityReceiptChain(f), QualityLedgerValidationError);
    const g = fixture();
    g.protocol_rows[0]!.protocol_digest = d;
    assert.throws(() => validateQualityReceiptChain(g), QualityLedgerValidationError);
});
test("incomplete historical subjects are unknown without erasing known exposure", () => {
    const f = fixture();
    f.records[4]!.subject_record_id = id(999);
    sign(f.records[4]!);
    const summary = summarizeQualityHistory(history(f));
    assert.equal(summary.exposure_status, "unknown");
    assert.equal(summary.first_holdout_access_record_id, f.records[3]!.id);
    assert.throws(() => validateQualityReceiptChain(f), QualityLedgerValidationError);
});
test("malformed bindings in prior protocol histories stay unknown and ineligible", () => {
    const f = fixture(), old = oldHistory(f);
    body(old.records[1]!).thresholds_digest = qualityDigest("invalid old freeze");
    sign(old.records[1]!);
    const s = summarizeQualityHistory(history(f));
    assert.equal(s.exposure_status, "unknown");
    assert.equal(s.first_holdout_access_at, at(4));
    assert.throws(() => validateQualityReceiptChain(f), QualityLedgerValidationError);
});
