import { z } from "zod";
import { assertQualityBudget, qualityDigest, qualityDatasetDigests, QualityContractError, QualityDatasetBodySchema, QualityDigestSchema, QualityProtocolBodySchema, QualityRunBindingSchema, QualityScopeSchema, QualityTimestampSchema, QualityUuidSchema, QUALITY_TRACE_LIMIT } from "./quality-contract.js";
import type { QualityRecordKind } from "./quality-store.js";
/** Pure structural checks; SQL provenance, loaded assets and human truth are external gates. */
export const QUALITY_LEDGER_MODULE_URL = import.meta.url;
const principal = z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const ids = z.array(principal).max(QUALITY_TRACE_LIMIT).refine(v => new Set(v).size === v.length);
const actor = {
    actor_type: z.enum(["bootstrap_admin", "api_token", "user", "internal"]), actor_id: principal.nullable(), actor_name: z.string().min(1).max(200)
};
const time = z.union([QualityTimestampSchema, z.date()]).transform(v => v instanceof Date ? v.toISOString() : v).refine(v => Number.isFinite(Date.parse(v)));
const common = {
    protocol_digest: QualityDigestSchema, scope_digest: QualityDigestSchema
};
const bodies = {
    registered: z.object({
        ...common, maker_ids: ids.refine(v => v.length > 0), tuner_ids: ids
    }).strict(),
    freeze: z.object({
        ...common, thresholds_digest: QualityDigestSchema
    }).strict(),
    dataset_declaration: z.object({
        ...common, dataset_digest: QualityDigestSchema
    }).strict(),
    holdout_access: z.object({
        ...common, dataset_digest: QualityDigestSchema
    }).strict(),
    holdout_payload: z.object({
        ...common, dataset: QualityDatasetBodySchema
    }).strict(),
    dataset_admission: z.object({
        ...common, dataset_digest: QualityDigestSchema
    }).strict(),
    evaluation: z.object({
        ...common, binding: QualityRunBindingSchema, report_digest: QualityDigestSchema
    }).strict(),
    review: z.object({
        ...common, run_id: QualityUuidSchema, dataset_id: QualityUuidSchema, report_digest: QualityDigestSchema, evidence_digest: QualityDigestSchema.nullable(), expires_at: QualityTimestampSchema
    }).strict(),
    revoke: z.object({
        ...common, reason: z.string().min(1).max(200)
    }).strict(),
    rejection: z.object({
        ...common, reason: z.string().min(1).max(200)
    }).strict(),
    alias_resolution: z.object({
        ...common, principal_ids: ids, corpus_digests: z.array(QualityDigestSchema).max(QUALITY_TRACE_LIMIT), evidence_digest: QualityDigestSchema.nullable()
    }).strict().refine(v => v.principal_ids.length > 1 || new Set(v.corpus_digests).size > 1)
} satisfies Record<QualityRecordKind, z.ZodTypeAny>;
const rowSchema = z.object({
    id: QualityUuidSchema, project_id: QualityUuidSchema, protocol_id: QualityUuidSchema,
    kind: z.enum(["registered", "freeze", "dataset_declaration", "holdout_access", "holdout_payload", "dataset_admission", "evaluation", "review", "revoke", "rejection", "alias_resolution"]),
    record_digest: QualityDigestSchema, subject_record_id: QualityUuidSchema.nullable(), request_key: z.string().min(1).max(200).nullable(), ...actor, body_json: z.unknown(), created_at: time
}).strict();
type Base = z.infer<typeof rowSchema>;
type Bodies = {
    [K in QualityRecordKind]: z.infer<typeof bodies[K]>;
};
export type QualityReceipt<K extends QualityRecordKind = QualityRecordKind> = Omit<Base, "kind" | "body_json"> & {
    kind: K;
    body: Bodies[K];
};
const protocolSchema = z.object({
    id: QualityUuidSchema, project_id: QualityUuidSchema, protocol_digest: QualityDigestSchema, created_by_actor_type: actor.actor_type, created_by_actor_id: actor.actor_id, created_by_actor_name: actor.actor_name, body_json: z.unknown(), created_at: time
}).strict();
function equal(a: unknown, b: unknown, code = "QUALITY_RECEIPT_BINDING_MISMATCH"): void {
    if (a !== b)
        throw new QualityContractError(code);
}
function object(v: unknown): Record<string, unknown> {
    assertQualityBudget(v);
    const x: unknown = typeof v === "string" ? JSON.parse(v) : v;
    if (!x || typeof x !== "object" || Array.isArray(x))
        throw new QualityContractError("QUALITY_RECORD_INVALID");
    assertQualityBudget(x);
    return x as Record<string, unknown>;
}
/** Exact writer envelope: created_at/request_key are shape/order checks, NOT hashed. */
function decode(value: unknown) {
    const row = rowSchema.parse(value), body = object(row.body_json);
    equal(row.record_digest, qualityDigest({
        id: row.id, project_id: row.project_id, protocol_id: row.protocol_id, kind: row.kind, subject_record_id: row.subject_record_id, actor: {
            type: row.actor_type, id: row.actor_id, name: row.actor_name
        }, body
    }), "QUALITY_RECORD_INTEGRITY_INVALID");
    return {
        row, body
    };
}
export function validateQualityRecord(value: unknown): QualityReceipt {
    try {
        const { row, body } = decode(value), typed = bodies[row.kind].parse(body);
        equal(qualityDigest(body), qualityDigest(typed), "QUALITY_RECORD_NONCANONICAL");
        const { body_json: _body, ...rest } = row;
        return {
            ...rest, body: typed
        } as QualityReceipt;
    }
    catch (e) {
        if (e instanceof QualityContractError)
            throw e;
        throw new QualityContractError("QUALITY_RECORD_INVALID");
    }
}
function protocol(value: unknown) {
    const row = protocolSchema.parse(value), raw = object(row.body_json), body = QualityProtocolBodySchema.parse(raw);
    equal(qualityDigest(raw), qualityDigest(body), "QUALITY_PROTOCOL_NONCANONICAL");
    equal(row.protocol_digest, qualityDigest(body), "QUALITY_PROTOCOL_INTEGRITY_INVALID");
    equal(row.project_id, body.scope.project_id, "QUALITY_PROJECT_MISMATCH");
    return {
        row, body
    };
}
const historySchema = z.object({
    project_id: QualityUuidSchema, protocol_id: QualityUuidSchema, protocol_rows: z.array(z.unknown()).min(1).max(QUALITY_TRACE_LIMIT), records: z.array(z.unknown()).min(1).max(QUALITY_TRACE_LIMIT)
}).strict();
const inputSchema = historySchema.extend({
    review_id: QualityUuidSchema, current_scope: QualityScopeSchema, current_time: QualityTimestampSchema
}).strict();
function closure(graph: Map<string, Set<string>>, values: readonly string[]) {
    const seen = new Set(values), queue = [...values];
    for (const id of queue)
        for (const next of graph.get(id) ?? [])
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
    return [...seen].sort();
}
function connect(graph: Map<string, Set<string>>, values: readonly string[]) {
    for (const id of values) {
        const next = graph.get(id) ?? new Set<string>();
        values.forEach(v => next.add(v));
        graph.set(id, next);
    }
}
/** Summary precedes quality checks; expired/revoked history never loses exposure.
 * Host must append access before raw decoding/size checks and load complete SQL
 * history plus authentic corpus aliases. Pure arrays cannot detect omitted rows. */
function collect(value: unknown) {
    const input = historySchema.parse(value), protocols = new Map<string, ReturnType<typeof protocol>>(), records = new Map<string, QualityReceipt>();
    const errors: string[] = [], exposures: Array<{
        id: string;
        at: string;
        corpus: string;
    }> = [];
    const corpusAliases = new Map<string, Set<string>>(), principalAliases = new Map<string, Set<string>>();
    for (const raw of input.protocol_rows)
        try {
            const p = protocol(raw);
            equal(p.row.project_id, input.project_id, "QUALITY_PROJECT_MISMATCH");
            if (protocols.has(p.row.id))
                throw new QualityContractError("QUALITY_DUPLICATE_PROTOCOL");
            protocols.set(p.row.id, p);
        }
        catch (e) {
            errors.push(e instanceof QualityContractError ? e.code : "QUALITY_PROTOCOL_INVALID");
        }
    for (const raw of input.records)
        try {
            const base = rowSchema.parse(raw), p = protocols.get(base.protocol_id);
            equal(base.project_id, input.project_id, "QUALITY_PROJECT_MISMATCH");
            if (!p)
                throw new QualityContractError("QUALITY_HISTORY_PROTOCOL_MISSING");
            if (base.kind === "holdout_access" || base.kind === "holdout_payload")
                exposures.push({
                    id: base.id, at: base.created_at, corpus: p.body.scope.corpus_digest
                });
            const r = validateQualityRecord(raw);
            equal(r.body.protocol_digest, p.row.protocol_digest);
            equal(r.body.scope_digest, qualityDigest(p.body.scope));
            if (records.has(r.id))
                throw new QualityContractError("QUALITY_DUPLICATE_RECORD");
            records.set(r.id, r);
            if (r.kind === "alias_resolution") {
                const b = (r as QualityReceipt<"alias_resolution">).body;
                connect(corpusAliases, b.corpus_digests);
                connect(principalAliases, b.principal_ids);
            }
        }
        catch (e) {
            errors.push(e instanceof QualityContractError ? e.code : "QUALITY_RECORD_INVALID");
        }
    const parents: Partial<Record<QualityRecordKind, QualityRecordKind>> = {
        freeze: "registered", dataset_declaration: "freeze", holdout_access: "dataset_declaration", holdout_payload: "holdout_access", dataset_admission: "holdout_payload", evaluation: "dataset_admission", review: "evaluation"
    };
    for (const r of records.values())
        try {
            const q = protocols.get(r.protocol_id)!;
            if (r.kind === "freeze")
                equal((r as QualityReceipt<"freeze">).body.thresholds_digest, qualityDigest(q.body.thresholds));
            if (r.kind === "dataset_declaration" || r.kind === "holdout_access" || r.kind === "dataset_admission")
                equal((r as QualityReceipt<"dataset_declaration">).body.dataset_digest, q.body.scope.dataset_digest);
            if (r.kind === "holdout_payload") {
                const values = qualityDatasetDigests((r as QualityReceipt<"holdout_payload">).body.dataset);
                for (const key of Object.keys(values) as Array<keyof typeof values>)
                    equal(values[key], q.body.scope[key]);
            }
            if (r.kind === "evaluation") {
                const b = (r as QualityReceipt<"evaluation">).body.binding;
                equal(b.protocol_id, r.protocol_id);
                equal(b.protocol_digest, q.row.protocol_digest);
                equal(qualityDigest(b.scope), qualityDigest(q.body.scope));
                equal(b.dataset_id, r.subject_record_id);
            }
            if (Date.parse(r.created_at) < Date.parse(q.row.created_at))
                throw new QualityContractError("QUALITY_RECEIPT_ORDER_INVALID");
            if (r.kind === "registered")
                equal(r.subject_record_id, null, "QUALITY_SUBJECT_INVALID");
            else {
                const parent = records.get(r.subject_record_id ?? "");
                if (!parent)
                    throw new QualityContractError("QUALITY_SUBJECT_MISSING");
                equal(parent.protocol_id, r.protocol_id, "QUALITY_SUBJECT_SCOPE_MISMATCH");
                if (parents[r.kind])
                    equal(parent.kind, parents[r.kind], "QUALITY_RECEIPT_KIND_MISMATCH");
                if (r.kind === "review") {
                    const b = (r as QualityReceipt<"review">).body, e = (parent as QualityReceipt<"evaluation">).body;
                    equal(b.run_id, e.binding.run_id);
                    equal(b.dataset_id, e.binding.dataset_id);
                    equal(b.report_digest, e.report_digest);
                }
                if (Date.parse(parent.created_at) > Date.parse(r.created_at))
                    throw new QualityContractError("QUALITY_RECEIPT_ORDER_INVALID");
                const seen = new Set([r.id]);
                let next: QualityReceipt | undefined = parent;
                while (next) {
                    if (seen.has(next.id))
                        throw new QualityContractError("QUALITY_SUBJECT_CYCLE");
                    seen.add(next.id);
                    next = next.subject_record_id === null ? undefined : records.get(next.subject_record_id);
                }
            }
        }
        catch (e) {
            errors.push(e instanceof QualityContractError ? e.code : "QUALITY_HISTORY_INVALID");
        }
    const target = protocols.get(input.protocol_id);
    if (!target)
        errors.push("QUALITY_PROTOCOL_NOT_FOUND");
    const corpusIds = target ? closure(corpusAliases, [target.body.scope.corpus_digest]) : [];
    const candidates = exposures.filter(r => corpusIds.includes(r.corpus)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    const summary = {
        exposure_status: errors.length ? "unknown" as const : candidates.length ? "observed" as const : "none_observed_in_supplied_history" as const, first_holdout_access_record_id: candidates[0]?.id ?? null, first_holdout_access_at: candidates[0]?.at ?? null, first_holdout_access_record_ids: candidates.filter(r => Date.parse(r.at) === Date.parse(candidates[0]?.at ?? "invalid")).map(r => r.id), corpus_digests: corpusIds, history_errors: [...errors]
    };
    return {
        input, protocols, records, principalAliases, summary
    };
}
export type QualityHistorySummary = ReturnType<typeof collect>["summary"];
export function summarizeQualityHistory(value: unknown): QualityHistorySummary {
    return collect(value).summary;
}
export class QualityLedgerValidationError extends QualityContractError {
    constructor(code: string, readonly history: QualityHistorySummary) {
        super(code);
    }
}
/** Structural result is never a quality pass or an authenticated human receipt. */
export function validateQualityReceiptChain(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new QualityContractError("QUALITY_CHAIN_INVALID");
    const raw = value as Record<string, unknown>;
    const h = collect({
        project_id: raw.project_id, protocol_id: raw.protocol_id, protocol_rows: raw.protocol_rows, records: raw.records
    });
    try {
        if (h.summary.history_errors.length)
            throw new QualityContractError("QUALITY_HISTORY_INVALID");
        const input = inputSchema.parse(value), p = h.protocols.get(input.protocol_id)!, now = Date.parse(input.current_time), scopeDigest = qualityDigest(p.body.scope);
        equal(qualityDigest(raw.current_scope), qualityDigest(input.current_scope), "QUALITY_CURRENT_SCOPE_NONCANONICAL");
        equal(scopeDigest, qualityDigest(input.current_scope), "QUALITY_CURRENT_SCOPE_MISMATCH");
        equal(input.current_scope.project_id, input.project_id, "QUALITY_PROJECT_MISMATCH");
        if (!Number.isFinite(now) || now >= Date.parse(p.body.valid_until))
            throw new QualityContractError("QUALITY_PROTOCOL_EXPIRED");
        for (const r of h.records.values()) {
            if (Date.parse(r.created_at) > now)
                throw new QualityContractError("QUALITY_RECEIPT_ORDER_INVALID");
            if (r.kind === "revoke" && r.protocol_id === input.protocol_id)
                throw new QualityContractError("QUALITY_PROTOCOL_REVOKED");
        }
        const get = <K extends QualityRecordKind>(id: string | null, kind: K): QualityReceipt<K> => {
            const r = h.records.get(id ?? "");
            if (!r)
                throw new QualityContractError("QUALITY_CHAIN_RECORD_MISSING");
            equal(r.kind, kind, "QUALITY_RECEIPT_KIND_MISMATCH");
            equal(r.protocol_id, input.protocol_id, "QUALITY_RECEIPT_SCOPE_MISMATCH");
            return r as QualityReceipt<K>;
        };
        const review = get(input.review_id, "review"), evaluation = get(review.subject_record_id, "evaluation"), admission = get(evaluation.subject_record_id, "dataset_admission"), payload = get(admission.subject_record_id, "holdout_payload"), access = get(payload.subject_record_id, "holdout_access"), declaration = get(access.subject_record_id, "dataset_declaration"), freeze = get(declaration.subject_record_id, "freeze"), registered = get(freeze.subject_record_id, "registered");
        equal(registered.actor_type, p.row.created_by_actor_type);
        equal(registered.actor_id, p.row.created_by_actor_id);
        equal(registered.actor_name, p.row.created_by_actor_name);
        equal(freeze.body.thresholds_digest, qualityDigest(p.body.thresholds));
        for (const r of [declaration, access, admission])
            equal(r.body.dataset_digest, p.body.scope.dataset_digest);
        const components = qualityDatasetDigests(payload.body.dataset);
        for (const name of Object.keys(components) as Array<keyof typeof components>)
            equal(components[name], p.body.scope[name]);
        const binding = evaluation.body.binding;
        equal(binding.protocol_id, input.protocol_id);
        equal(binding.protocol_digest, p.row.protocol_digest);
        equal(qualityDigest(binding.scope), scopeDigest);
        equal(binding.dataset_id, admission.id);
        const evaluated = Date.parse(binding.evaluated_at);
        if (!(Date.parse(admission.created_at) <= evaluated && evaluated <= Date.parse(evaluation.created_at)))
            throw new QualityContractError("QUALITY_RECEIPT_ORDER_INVALID");
        equal(review.body.run_id, binding.run_id);
        equal(review.body.dataset_id, admission.id);
        equal(review.body.report_digest, evaluation.body.report_digest);
        if (now >= Date.parse(review.body.expires_at) || Date.parse(review.body.expires_at) > Date.parse(p.body.valid_until))
            throw new QualityContractError("QUALITY_REVIEW_EXPIRED");
        const causalTie = h.summary.first_holdout_access_record_ids.every(id => {
            let r = h.records.get(id);
            while (r && r.id !== freeze.id)
                r = h.records.get(r.subject_record_id ?? "");
            return r?.id === freeze.id;
        });
        if (h.summary.first_holdout_access_at === null || !(Date.parse(freeze.created_at) < Date.parse(h.summary.first_holdout_access_at) || (Date.parse(freeze.created_at) === Date.parse(h.summary.first_holdout_access_at) && causalTie)))
            throw new QualityContractError("QUALITY_FREEZE_AFTER_EXPOSURE");
        const forbidden = new Set<string>();
        for (const r of h.records.values())
            if (h.summary.corpus_digests.includes(h.protocols.get(r.protocol_id)!.body.scope.corpus_digest)) {
                if (r.kind === "registered") {
                    const b = (r as QualityReceipt<"registered">).body;
                    [...b.maker_ids, ...b.tuner_ids].forEach(id => forbidden.add(id));
                }
                if (["registered", "dataset_declaration", "holdout_access", "holdout_payload", "dataset_admission"].includes(r.kind) && r.actor_id !== null)
                    forbidden.add(r.actor_id);
            }
        if (review.actor_type !== "user" || review.actor_id === null)
            throw new QualityContractError("QUALITY_REVIEW_PRINCIPAL_REQUIRED");
        const reviewerIds = closure(h.principalAliases, [review.actor_id]), forbiddenIds = closure(h.principalAliases, [...forbidden]);
        if (reviewerIds.some(id => forbiddenIds.includes(id)))
            throw new QualityContractError("QUALITY_REVIEW_PRINCIPAL_CONFLICT");
        return {
            integrity_status: "structurally_valid" as const, quality_status: "not_evaluated" as const, protocol_id: input.protocol_id, protocol_digest: p.row.protocol_digest, scope_digest: scopeDigest, review_id: review.id, review_record_digest: review.record_digest, run_id: binding.run_id, dataset_id: admission.id, report_digest: review.body.report_digest, history: h.summary, reviewer_principal_ids: reviewerIds, forbidden_principal_ids: forbiddenIds, external_prerequisites: ["trusted_complete_sql_history", "authenticated_corpus_aliases", "current_loaded_assets_and_sources", "independent_natural_human_evidence", "approved_thresholds_and_actual_report"] as const
        };
    }
    catch (e) {
        throw new QualityLedgerValidationError(e instanceof QualityContractError ? e.code : "QUALITY_CHAIN_INVALID", h.summary);
    }
}
