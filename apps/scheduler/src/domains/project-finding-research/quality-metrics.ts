import { z } from "zod";
import { RELATION_PAIR_LIMIT } from "./strong-candidate-selector.js";
import { validateQualityRecord, type QualityReceipt } from "./quality-ledger.js";
import { assertQualityBudget, qualityDigest, qualityDatasetDigests, QualityContractError,
  QualityDatasetBodySchema, QualityProtocolBodySchema, QualityRunBindingSchema, QualityScopeSchema,
  QualityUuidSchema, QualityDigestSchema, QualityTimestampSchema, QUALITY_TRUTH_LABELS, QUALITY_STRONG_CLASSES,
  QUALITY_TRACE_LIMIT, QUALITY_DECISION_LIMIT, QUALITY_SOURCE_LIMIT, type QualityGateHostContext } from "./quality-contract.js";

/** Internal origin captured as Node load-returned source under a trusted
 * preload, before evaluation. Node/loader trust, signed deployment integrity
 * and human evidence remain separate; TSX and compiled JS bind different bytes. */
export const QUALITY_METRICS_MODULE_URL = import.meta.url;

const selection = z.object({
  finding_id: QualityUuidSchema, peerIds: z.array(QualityUuidSchema).max(RELATION_PAIR_LIMIT),
  observedCount: z.number().int().min(0).max(RELATION_PAIR_LIMIT + 1),
  truncated: z.boolean(), countKind: z.enum(["exact", "lower_bound"]),
}).strict().superRefine((v,ctx) => {
  const sentinel = v.observedCount === RELATION_PAIR_LIMIT + 1;
  if (v.truncated !== sentinel || v.countKind !== (sentinel ? "lower_bound" : "exact")
    || v.peerIds.length !== (sentinel ? RELATION_PAIR_LIMIT : v.observedCount)
    || v.peerIds.some((id,i) => id <= v.finding_id || (i > 0 && id <= v.peerIds[i-1]!))) {
    ctx.addIssue({ code: "custom", message: "invalid bounded raw SQL trace" });
  }
});
const decision = z.object({ left_id: QualityUuidSchema, right_id: QualityUuidSchema,
  prediction: z.enum(QUALITY_TRUTH_LABELS),
}).strict().refine((v) => v.left_id < v.right_id, "noncanonical decision");
const inputSchema = z.object({ binding: QualityRunBindingSchema, dataset: QualityDatasetBodySchema,
  selections: z.array(selection).max(QUALITY_TRACE_LIMIT), decisions: z.array(decision).max(QUALITY_DECISION_LIMIT),
}).strict();
const key = (v: {left_id: string;right_id: string}) => `${v.left_id}:${v.right_id}`;
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
function immutable<T>(v: T): T {
  if (v && typeof v === "object") { Object.values(v).forEach(immutable); Object.freeze(v); }
  return v;
}
/** Receives actual worker observations, NEVER performs lexical/replayed SQL.
 * Whole admitted holdout truth is the denominator, including window misses. */
export function computeQualityMetrics(value: unknown) {
  assertQualityBudget(value);
  const input = inputSchema.parse(value);
  input.selections.sort((a,b) => a.finding_id < b.finding_id ? -1 : 1);
  input.decisions.sort((a,b) => key(a) < key(b) ? -1 : 1);
  const components = qualityDatasetDigests(input.dataset);
  for (const name of Object.keys(components) as Array<keyof typeof components>) {
    if (input.binding.scope[name] !== components[name]) throw new QualityContractError("QUALITY_DATASET_BINDING_MISMATCH");
  }
  const holdout = new Set(input.dataset.sources.filter((r) => r.split === "holdout").map((r) => r.id));
  const subjects = new Set<string>(), selected = new Set<string>();
  for (const row of input.selections) {
    if (!holdout.has(row.finding_id)) throw new QualityContractError("INVALID_QUALITY_SUBJECT");
    if (subjects.has(row.finding_id)) throw new QualityContractError("DUPLICATE_QUALITY_SUBJECT");
    subjects.add(row.finding_id);
    for (const id of row.peerIds) selected.add(`${row.finding_id}:${id}`);
  }
  const decisions = new Map<string, typeof input.decisions[number]>();
  for (const row of input.decisions) {
    if (!selected.has(key(row)) || decisions.has(key(row))) throw new QualityContractError("INVALID_QUALITY_DECISION");
    decisions.set(key(row),row);
  }
  const universe = new Map(input.dataset.pairs.map((row) => [key(row),row]));
  const known = input.dataset.pairs.filter((r) => r.label !== null && r.label !== "insufficient_information");
  const positives = known.filter((r) => r.label !== "distinct");
  const per_class = Object.fromEntries(QUALITY_STRONG_CLASSES.map((kind) => {
    const actual = known.filter((r) => r.label === kind).length;
    const tp = known.filter((r) => r.label === kind && decisions.get(key(r))?.prediction === kind).length;
    const fp = known.filter((r) => r.label !== kind && decisions.get(key(r))?.prediction === kind).length;
    return [kind,{ true_positive: tp, false_positive: fp, false_negative: actual - tp,
      precision: ratio(tp,tp+fp), recall: ratio(tp,actual) }];
  }));
  const missing_traces = input.dataset.sources.filter((r) => r.split === "holdout" && !subjects.has(r.id)).length;
  const missing_decisions = [...selected].filter((k) => !decisions.has(k)).length;

  const unknown_truth = input.dataset.pairs.length - known.length;
  const unknown_selected = [...selected].filter((k) => { const truth = universe.get(k)?.label; return truth == null || truth === "insufficient_information"; }).length;
  const blockers: string[] = [];
  if (input.dataset.kind === "synthetic") blockers.push("SYNTHETIC_DATA");
  if (unknown_truth || unknown_selected) blockers.push("UNKNOWN_TRUTH");
  if (missing_traces || missing_decisions) blockers.push("INCOMPLETE_OBSERVATIONS");
  if (input.dataset.sources.some((r) => r.provenance_digest === null) || input.dataset.pairs.some((r) => r.label_evidence_digest === null)) blockers.push("INCOMPLETE_PROVENANCE");
  for (const field of ["asset_group_digest","family_group_digest"] as const) {
    const tuning = new Set(input.dataset.sources.filter((r) => r.split === "tuning").map((r) => r[field]));
    if (input.dataset.sources.some((r) => r[field] === null)) blockers.push("INCOMPLETE_SPLIT");
    if (input.dataset.sources.some((r) => r.split === "holdout" && tuning.has(r[field]))) blockers.push("SPLIT_LEAKAGE");
  }
  const body = { schema_version: 1 as const, binding: input.binding, dataset_kind: input.dataset.kind,
    input_digest: qualityDigest(input), observations_digest: qualityDigest({ selections: input.selections, decisions: input.decisions }),
    per_class, candidate_recall: ratio(positives.filter((r) => selected.has(key(r))).length,positives.length),
    labeled_pairs: input.dataset.pairs.length, known_labeled_pairs: known.length,
    unknown_labeled_pairs: unknown_truth, unknown_selected_pairs: unknown_selected,
    selected_pairs: selected.size, compared_pairs: decisions.size,
    missing_subject_traces: missing_traces, missing_decisions,
    not_selected_positive: positives.filter((r) => !selected.has(key(r))).length,
    not_compared_positive: positives.filter((r) => !decisions.has(key(r))).length,
    predicted_insufficient: input.decisions.filter((r) => r.prediction === "insufficient_information").length,
    truncated_subjects: input.selections.filter((r) => r.truncated).length,
    // Bounded observed row sum incl. sentinels, NOT global corpus total or rank.
    observed_rows_including_sentinels: input.selections.reduce((n,r) => n + r.observedCount,0),
    blockers: [...new Set(blockers)].sort(), input,
  };
  const report = { ...body, report_digest: qualityDigest(body) };
  assertQualityBudget(report);
  return immutable(report);
}
export type QualityMetricReport = ReturnType<typeof computeQualityMetrics>;
export interface QualityGateAssessment {
  status: "passed" | "failed" | "not_evaluated"; reasons: readonly string[];
}
/** No publication authority: host must authenticate/admit/review real evidence
 * and lock/CAS its current gate. This primitive cannot certify human truth. */
export function assessQualityGate(protocolValue: unknown, report: QualityMetricReport, context: QualityGateHostContext): QualityGateAssessment {
  const result = (status: QualityGateAssessment["status"], reasons: string[]) => immutable({status,reasons: [...new Set(reasons)].sort()});
  try {
    assertQualityBudget(protocolValue); assertQualityBudget(context);
    const protocol = QualityProtocolBodySchema.parse(protocolValue);
    const current = QualityScopeSchema.parse(context.current_scope);
    const record = context.record;
    const {report_digest,...body} = report;
    const recomputed = computeQualityMetrics(report.input);
    const reasons = [...recomputed.blockers];
    if (qualityDigest(body) !== report_digest || recomputed.report_digest !== report_digest) reasons.push("REPORT_MISMATCH");
    const pd = qualityDigest(protocol), scopeDigest = qualityDigest(protocol.scope);
    if (pd !== report.binding.protocol_digest || scopeDigest !== qualityDigest(report.binding.scope)
      || scopeDigest !== qualityDigest(current)) reasons.push("SCOPE_DRIFT");
    const review = validateQualityRecord(context.review_row);
    if (review.kind !== "review") throw new QualityContractError("QUALITY_REVIEW_KIND_MISMATCH");
    const reviewBody = (review as QualityReceipt<"review">).body;
    if (review.record_digest !== record.review_digest || review.id !== record.review_id
      || review.project_id !== protocol.scope.project_id || review.protocol_id !== record.protocol_id
      || review.subject_record_id !== record.evaluation_id
      || review.body.protocol_digest !== record.protocol_digest || review.body.scope_digest !== scopeDigest
      || reviewBody.run_id !== record.run_id || reviewBody.dataset_id !== record.dataset_id
      || reviewBody.report_digest !== record.report_digest || reviewBody.evidence_digest !== record.evidence_digest
      || review.actor_type !== "user" || review.actor_id !== record.reviewer_id
      || !QualityDigestSchema.safeParse(record.evidence_digest).success
      || record.protocol_digest !== pd || record.report_digest !== report_digest
      || record.protocol_id !== report.binding.protocol_id || record.run_id !== report.binding.run_id
      || record.dataset_id !== report.binding.dataset_id || qualityDigest(record.scope) !== scopeDigest) reasons.push("UNBOUND_EVIDENCE");
    for (const id of [record.review_id,record.evaluation_id,record.protocol_id,record.run_id,record.dataset_id]) {
      const parsed = QualityUuidSchema.safeParse(id);
      if (!parsed.success || parsed.data !== id) reasons.push("UNBOUND_EVIDENCE");
    }
    const actor = (v: unknown) => typeof v === "string" && /^[^\s\u0000-\u001f\u007f]{1,128}$/u.test(v);
    const lists = [record.maker_ids,record.tuner_ids,record.registrar_ids,record.custodian_ids,record.reviewer_alias_ids,record.forbidden_alias_ids];
    const valid = lists.every((ids) => Array.isArray(ids) && ids.length <= QUALITY_SOURCE_LIMIT && ids.every(actor));
    const forbidden = valid ? new Set([...record.maker_ids,...record.tuner_ids,...record.registrar_ids,...record.custodian_ids,...record.forbidden_alias_ids]) : new Set<string>();
    const reviewing = valid ? [record.reviewer_id,...record.reviewer_alias_ids] : [];
    if (!actor(record.reviewer_id) || !valid || record.maker_ids.length === 0
      || record.reviewer_authenticated !== true || reviewing.some((id) => forbidden.has(id))) reasons.push("REVIEWER_NOT_INDEPENDENT");
    for (const field of ["independent_reviewer","independent_human_labels","source_provenance",
      "split_isolation","denominator_complete","observations_complete","thresholds_adopted","current_sources","aliases_resolved","conflicts_cleared"] as const) {
      if (record[field] !== "verified") reasons.push("UNVERIFIED_EVIDENCE");
    }
    const timestamp = (v: unknown) => {
      if (!QualityTimestampSchema.safeParse(v).success) throw new QualityContractError("INVALID_GATE_TIME");
      const ms = Date.parse(v as string);
      if (!Number.isFinite(ms)) throw new QualityContractError("INVALID_GATE_TIME");
      return ms;
    };
    const now = timestamp(context.current_time), frozen = timestamp(record.frozen_at);
    const access = timestamp(record.first_holdout_access_at), adoption = timestamp(record.thresholds_adopted_at);
    const admitted = timestamp(record.dataset_admitted_at), evaluated = timestamp(report.binding.evaluated_at);
    const reviewed = timestamp(record.reviewed_at), expires = timestamp(record.expires_at);
    if (timestamp(review.created_at) !== reviewed || timestamp(reviewBody.expires_at) !== expires) reasons.push("UNBOUND_EVIDENCE");
    if (!(frozen < access && adoption < access
      && access <= admitted && admitted <= evaluated && evaluated <= reviewed && reviewed <= now)) reasons.push("LATE_OR_INVALID_FREEZE");
    if (record.revoked_at !== null || now >= expires
      || now >= timestamp(protocol.valid_until)) reasons.push("REVOKED_OR_EXPIRED");
    for (const kind of QUALITY_STRONG_CLASSES) {
      const score = recomputed.per_class[kind]!;
      if (score.precision.value === null || score.recall.value === null) reasons.push("ZERO_DENOMINATOR");
    }
    if (reasons.length) return result("not_evaluated",reasons);
    const failed = QUALITY_STRONG_CLASSES.some((kind) => {
      const score = recomputed.per_class[kind]!, threshold = protocol.thresholds[kind];
      return score.precision.value! < threshold.precision || score.recall.value! < threshold.recall;
    });
    return result(failed ? "failed" : "passed",failed ? ["THRESHOLD_NOT_MET"] : []);
  } catch { return result("not_evaluated",["INVALID_GATE_EVIDENCE"]); }
}
