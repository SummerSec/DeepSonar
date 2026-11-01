import { z } from "zod";
import { sql } from "../../db.js";
import type { Actor } from "../../auth.js";
import { appendQualityRecord, loadQualityRecord, loadQualityProtocol, assertQualityAuthority, qualityVersion } from "./quality-store.js";
import { validateQualityRecord, type QualityReceipt } from "./quality-ledger.js";
import { QualityContractError, QualityUuidSchema, QualityTimestampSchema, qualityDigest, assertQualityBudget, qualityDatasetDigests, QUALITY_TRACE_LIMIT, QUALITY_INPUT_BYTES } from "./quality-contract.js";
/** Internal SQL receipts/CAS only: no publication, human verification or quality pass. */
export const QUALITY_STATE_STORE_MODULE_URL = import.meta.url;
export type QualityStateDb = typeof sql;
const phaseSchema = z.enum(["registered", "frozen", "admitted", "evaluated", "reviewed", "revoked", "blocked"]);
export type QualityPhase = z.infer<typeof phaseSchema>;
const pointers = {
    freeze_record_id: QualityUuidSchema.nullable(), declaration_record_id: QualityUuidSchema.nullable(), first_access_record_id: QualityUuidSchema.nullable(), dataset_record_id: QualityUuidSchema.nullable(), evaluation_record_id: QualityUuidSchema.nullable(), review_record_id: QualityUuidSchema.nullable(), revocation_record_id: QualityUuidSchema.nullable()
};
const headSchema = z.object({
    project_id: QualityUuidSchema, protocol_id: QualityUuidSchema, version: z.string().transform(qualityVersion), phase: phaseSchema, latest_record_id: QualityUuidSchema, ...pointers, updated_at: z.union([QualityTimestampSchema, z.date()])
}).strict();
export type QualityHead = Readonly<z.infer<typeof headSchema>>;
type Pointer = keyof typeof pointers;
const updatesSchema = z.object({
    freeze_record_id: QualityUuidSchema.optional(), declaration_record_id: QualityUuidSchema.optional(), first_access_record_id: QualityUuidSchema.optional(), dataset_record_id: QualityUuidSchema.optional(), evaluation_record_id: QualityUuidSchema.optional(), review_record_id: QualityUuidSchema.optional(), revocation_record_id: QualityUuidSchema.optional()
}).strict();
type Lock = {
    tx: QualityStateDb;
    live: boolean;
};
const locks = new WeakMap<QualityHead, Lock>();
function equal(a: unknown, b: unknown, code = "QUALITY_STATE_SCOPE_MISMATCH") {
    if (a !== b)
        throw new QualityContractError(code);
}
function requireLock(tx: QualityStateDb, head: QualityHead) {
    const lock = locks.get(head);
    if (!lock || !lock.live || lock.tx !== tx)
        throw new QualityContractError("QUALITY_HEAD_NOT_LOCKED");
    return lock;
}
async function locked(tx: QualityStateDb, projectId: string, protocolId: string, lock: Lock) {
    const [current] = await tx `SELECT project_id,version::text AS version FROM project_finding_quality_current WHERE project_id=${projectId} FOR UPDATE`;
    if (!current)
        throw new QualityContractError("QUALITY_CURRENT_NOT_FOUND");
    equal(current.project_id, projectId);
    qualityVersion(current.version);
    const [row] = await tx `SELECT *,version::text AS version FROM project_finding_quality_heads WHERE project_id=${projectId} AND protocol_id=${protocolId} FOR UPDATE`;
    if (!row)
        throw new QualityContractError("QUALITY_HEAD_NOT_FOUND");
    const head = Object.freeze(headSchema.parse(row));
    equal(head.project_id, projectId);
    equal(head.protocol_id, protocolId);
    locks.set(head, lock);
    return head;
}
export async function withQualityHead<T>(projectId: string, protocolId: string, expectedVersion: string, callback: (tx: QualityStateDb, head: QualityHead) => Promise<T>, db: QualityStateDb = sql, options?: { isolationLevel: "repeatable_read" }): Promise<T> {
    QualityUuidSchema.parse(projectId);
    QualityUuidSchema.parse(protocolId);
    qualityVersion(expectedVersion);
    if (options !== undefined && options.isolationLevel !== "repeatable_read")
        throw new QualityContractError("QUALITY_TX_ISOLATION_INVALID");
    const run = async (raw: unknown) => {
        const tx = raw as unknown as QualityStateDb, lock = {
            tx, live: true
        };
        try {
            const head = await locked(tx, projectId, protocolId, lock);
            equal(head.version, expectedVersion, "QUALITY_HEAD_VERSION_CONFLICT");
            return await callback(tx, head);
        }
        finally {
            lock.live = false;
        }
    };
    return (options ? db.begin("isolation level repeatable read", run) : db.begin(run)) as Promise<T>;
}
/** A single SQL snapshot includes revoked/expired/retried histories. No client completeness flag. */
export async function loadQualityHistory(tx: QualityStateDb, projectId: string) {
    QualityUuidSchema.parse(projectId);
    const limit = QUALITY_TRACE_LIMIT + 1;
    const [row] = await tx`WITH protocols AS MATERIALIZED (
        SELECT * FROM project_finding_quality_protocols WHERE project_id=${projectId} ORDER BY created_at,id LIMIT ${limit}
      ), receipts AS MATERIALIZED (
        SELECT * FROM project_finding_quality_records WHERE project_id=${projectId} ORDER BY created_at,id LIMIT ${limit}
      ), budget AS (SELECT COALESCE((SELECT sum(octet_length(to_jsonb(protocols)::text)) FROM protocols),0)
        + COALESCE((SELECT sum(octet_length(to_jsonb(receipts)::text)) FROM receipts),0) > ${QUALITY_INPUT_BYTES} AS history_overflow)
      SELECT CASE WHEN history_overflow THEN '[]'::jsonb ELSE (SELECT COALESCE(jsonb_agg(to_jsonb(protocols)),'[]'::jsonb) FROM protocols) END AS protocol_rows,
        CASE WHEN history_overflow THEN '[]'::jsonb ELSE (SELECT COALESCE(jsonb_agg(to_jsonb(receipts)),'[]'::jsonb) FROM receipts) END AS records, history_overflow FROM budget`;
    if (row?.history_overflow === true) throw new QualityContractError("QUALITY_HISTORY_LIMIT");
    if (!row || row.history_overflow !== false || !Array.isArray(row.protocol_rows) || !Array.isArray(row.records))
        throw new QualityContractError("QUALITY_HISTORY_INVALID");
    if (row.protocol_rows.length > QUALITY_TRACE_LIMIT || row.records.length > QUALITY_TRACE_LIMIT)
        throw new QualityContractError("QUALITY_HISTORY_LIMIT");
    for (const item of [...row.protocol_rows, ...row.records]) {
        if (!item || typeof item !== "object" || (item as Record<string, unknown>).project_id !== projectId)
            throw new QualityContractError("QUALITY_STATE_SCOPE_MISMATCH");
    }
    assertQualityBudget(row);
    return {
        protocol_rows: row.protocol_rows as Record<string, unknown>[], records: row.records as Record<string, unknown>[]
    };
}
async function checkedRecord(tx: QualityStateDb, head: QualityHead, input: unknown) {
    const supplied = validateQualityRecord(input);
    equal(supplied.project_id, head.project_id);
    equal(supplied.protocol_id, head.protocol_id);
    const loaded = await loadQualityRecord(head.project_id, head.protocol_id, supplied.id, tx), record = validateQualityRecord(loaded.row);
    equal(record.record_digest, supplied.record_digest, "QUALITY_RECORD_INTEGRITY_INVALID");
    const protocol = await loadQualityProtocol(head.project_id, head.protocol_id, tx);
    equal(record.body.protocol_digest, protocol.row.protocol_digest);
    equal(record.body.scope_digest, qualityDigest(protocol.body.scope));
    if (!record.subject_record_id)
        throw new QualityContractError("QUALITY_SUBJECT_REQUIRED");
    const subject = validateQualityRecord((await loadQualityRecord(head.project_id, head.protocol_id, record.subject_record_id, tx)).row);
    equal(subject.body.protocol_digest, protocol.row.protocol_digest);
    equal(subject.body.scope_digest, qualityDigest(protocol.body.scope));
    if (subject.id === record.id || Date.parse(subject.created_at) > Date.parse(record.created_at))
        throw new QualityContractError("QUALITY_SUBJECT_ORDER_INVALID");
    const kinds: Partial<Record<QualityReceipt["kind"], QualityReceipt["kind"]>> = {
        freeze: "registered", dataset_declaration: "freeze", holdout_access: "dataset_declaration", holdout_payload: "holdout_access", dataset_admission: "holdout_payload", evaluation: "dataset_admission", review: "evaluation"
    };
    if (kinds[record.kind])
        equal(subject.kind, kinds[record.kind], "QUALITY_SUBJECT_KIND_MISMATCH");
    const expected: Partial<Record<QualityReceipt["kind"], string | null>> = {
        freeze: head.latest_record_id, dataset_declaration: head.freeze_record_id, holdout_payload: head.latest_record_id, dataset_admission: head.latest_record_id, evaluation: head.dataset_record_id, review: head.evaluation_record_id
    };
    if (Object.hasOwn(expected, record.kind))
        equal(subject.id, expected[record.kind], "QUALITY_HEAD_SUBJECT_MISMATCH");
    for (const r of [record, subject]) {
        if (r.kind === "freeze")
            equal((r as QualityReceipt<"freeze">).body.thresholds_digest, qualityDigest(protocol.body.thresholds), "QUALITY_THRESHOLD_BINDING_MISMATCH");
        if (["dataset_declaration", "holdout_access", "dataset_admission"].includes(r.kind))
            equal((r as QualityReceipt<"dataset_declaration">).body.dataset_digest, protocol.body.scope.dataset_digest, "QUALITY_DATASET_BINDING_MISMATCH");
        if (r.kind === "holdout_payload") {
            const values = qualityDatasetDigests((r as QualityReceipt<"holdout_payload">).body.dataset);
            for (const key of Object.keys(values) as Array<keyof typeof values>)
                equal(values[key], protocol.body.scope[key], "QUALITY_DATASET_BINDING_MISMATCH");
        }
        if (r.kind === "evaluation") {
            const b = (r as QualityReceipt<"evaluation">).body.binding;
            equal(b.protocol_id, head.protocol_id);
            equal(b.protocol_digest, protocol.row.protocol_digest);
            equal(qualityDigest(b.scope), qualityDigest(protocol.body.scope));
            equal(b.dataset_id, r.subject_record_id, "QUALITY_DATASET_BINDING_MISMATCH");
        }
    }
    if (record.kind === "evaluation") {
        const at = Date.parse((record as QualityReceipt<"evaluation">).body.binding.evaluated_at);
        if (!(Date.parse(subject.created_at) <= at && at <= Date.parse(record.created_at)))
            throw new QualityContractError("QUALITY_EVALUATION_TIME_INVALID");
    }
    if (record.kind === "review") {
        const b = (record as QualityReceipt<"review">).body, e = (subject as QualityReceipt<"evaluation">).body;
        equal(b.run_id, e.binding.run_id);
        equal(b.dataset_id, e.binding.dataset_id);
        equal(b.report_digest, e.report_digest);
        if (Date.parse(b.expires_at) > Date.parse(protocol.body.valid_until))
            throw new QualityContractError("QUALITY_REVIEW_EXPIRY_INVALID");
    }
    return record;
}
function transition(head: QualityHead, r: QualityReceipt, phase: QualityPhase): Partial<Record<Pointer, string>> {
    const patch: Partial<Record<Pointer, string>> = {};
    let legal = false;
    switch (r.kind) {
        case "freeze":
            legal = head.phase === "registered" && phase === "frozen" && head.first_access_record_id === null && head.freeze_record_id === null;
            patch.freeze_record_id = r.id;
            break;
        case "dataset_declaration":
            legal = head.phase === "frozen" && phase === "frozen" && head.first_access_record_id === null;
            patch.declaration_record_id = r.id;
            break;
        case "holdout_access":
            legal = phase === head.phase;
            patch.first_access_record_id = head.first_access_record_id ?? r.id;
            break;
        case "holdout_payload":
            legal = head.phase === "frozen" && phase === "frozen";
            break;
        case "dataset_admission":
            legal = head.phase === "frozen" && phase === "admitted" && head.first_access_record_id !== null && head.freeze_record_id !== null;
            patch.dataset_record_id = r.id;
            break;
        case "evaluation":
            legal = head.phase === "admitted" && phase === "evaluated";
            patch.evaluation_record_id = r.id;
            break;
        case "review":
            legal = head.phase === "evaluated" && phase === "reviewed";
            patch.review_record_id = r.id;
            break;
        case "revoke":
            legal = phase === "revoked";
            patch.revocation_record_id = r.id;
            break;
        case "rejection":
            legal = phase === head.phase || (phase === "blocked" && head.phase !== "revoked");
            break;
        case "alias_resolution":
            legal = phase === head.phase;
            break;
        default: break;
    }
    if (!legal)
        throw new QualityContractError("QUALITY_HEAD_TRANSITION_INVALID");
    return patch;
}
/** Input is the raw SQL row, reloaded here; hashes never substitute for durable existence. */
export async function advanceQualityHead(tx: QualityStateDb, head: QualityHead, input: unknown, phase: QualityPhase, updates: unknown = {}) {
    const lock = requireLock(tx, head);
    phaseSchema.parse(phase);
    const explicit = updatesSchema.parse(updates);
    if (head.version === "9223372036854775807")
        throw new QualityContractError("QUALITY_VERSION_EXHAUSTED");
    const record = await checkedRecord(tx, head, input), patch = transition(head, record, phase);
    for (const [key, value] of Object.entries(explicit))
        equal(value, patch[key as Pointer], "QUALITY_HEAD_UPDATE_INVALID");
    const next = {
        ...head, ...patch, phase, latest_record_id: record.id
    };
    const [row] = await tx `UPDATE project_finding_quality_heads SET version=version+1,phase=${phase},latest_record_id=${record.id},freeze_record_id=${next.freeze_record_id},declaration_record_id=${next.declaration_record_id},first_access_record_id=COALESCE(first_access_record_id,${next.first_access_record_id}),dataset_record_id=${next.dataset_record_id},evaluation_record_id=${next.evaluation_record_id},review_record_id=${next.review_record_id},revocation_record_id=${next.revocation_record_id},updated_at=clock_timestamp()
 WHERE project_id=${head.project_id} AND protocol_id=${head.protocol_id} AND version=${head.version}::bigint RETURNING *,version::text AS version`;
    if (!row)
        throw new QualityContractError("QUALITY_HEAD_VERSION_CONFLICT");
    const advanced = Object.freeze(headSchema.parse(row));
    equal(advanced.project_id, head.project_id);
    equal(advanced.protocol_id, head.protocol_id);
    equal(advanced.version, (BigInt(head.version) + 1n).toString(), "QUALITY_HEAD_VERSION_CONFLICT");
    equal(advanced.phase, phase);
    equal(advanced.latest_record_id, record.id);
    for (const key of Object.keys(pointers) as Pointer[])
        equal(advanced[key], next[key], "QUALITY_HEAD_UPDATE_INVALID");
    locks.delete(head);
    locks.set(advanced, lock);
    return advanced;
}
const exposureSchema = z.object({
    projectId: QualityUuidSchema, protocolId: QualityUuidSchema, declarationId: QualityUuidSchema, actor: z.unknown(), requestKey: z.string().min(1).max(200).optional()
}).strict();
export type QualityExposureInput = {
    projectId: string;
    protocolId: string;
    declarationId: string;
    actor: Actor;
    requestKey?: string;
};
/** Commit before consuming raw bytes/JSON. Unknown raw identity makes every reused key a conflict. */
export async function persistQualityExposure(value: QualityExposureInput, db: QualityStateDb = sql) {
    const input = exposureSchema.parse(value);
    assertQualityAuthority(input.actor as Actor, input.projectId);
    const actor = input.actor as Actor;
    return db.begin(async (raw) => {
        const tx = raw as unknown as QualityStateDb, lock = {
            tx, live: true
        };
        try {
            const head = await locked(tx, input.projectId, input.protocolId, lock), protocol = await loadQualityProtocol(input.projectId, input.protocolId, tx);
            const declaration = validateQualityRecord((await loadQualityRecord(input.projectId, input.protocolId, input.declarationId, tx)).row);
            equal(declaration.kind, "dataset_declaration", "QUALITY_SUBJECT_KIND_MISMATCH");
            equal(declaration.body.protocol_digest, protocol.row.protocol_digest);
            equal(declaration.body.scope_digest, qualityDigest(protocol.body.scope));
            equal((declaration as QualityReceipt<"dataset_declaration">).body.dataset_digest, protocol.body.scope.dataset_digest, "QUALITY_DATASET_BINDING_MISMATCH");
            if (input.requestKey !== undefined) {
                const [existing] = await tx `SELECT id FROM project_finding_quality_records WHERE project_id=${input.projectId} AND protocol_id=${input.protocolId} AND kind='holdout_access' AND request_key=${input.requestKey}`;
                if (existing)
                    throw new QualityContractError("QUALITY_EXPOSURE_REQUEST_CONFLICT");
            }
            const record = await appendQualityRecord(tx, {
                projectId: input.projectId, protocolId: input.protocolId, kind: "holdout_access", actor, subjectId: input.declarationId, requestKey: input.requestKey, body: {
                    protocol_digest: protocol.row.protocol_digest, scope_digest: qualityDigest(protocol.body.scope), dataset_digest: protocol.body.scope.dataset_digest
                }
            });
            const advanced = await advanceQualityHead(tx, head, record, head.phase);
            return {
                record, head: advanced
            };
        }
        finally {
            lock.live = false;
        }
    });
}
