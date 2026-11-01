import { createHash } from "node:crypto";
import { z } from "zod";
import { STRONG_RELATION_RULE_VERSION } from "./identity.js";

/** Internal origin captured as Node load-returned source under a trusted
 * preload, before evaluation. Node/loader trust, signed deployment integrity
 * and human evidence remain separate; TSX and compiled JS bind different bytes. */
export const QUALITY_CONTRACT_MODULE_URL = import.meta.url;

// Implementation technical budgets, baseline 2026-11-01; NOT quality/sample minima or quorum.
export const QUALITY_SOURCE_LIMIT = 1000;
export const QUALITY_LABEL_LIMIT = 10000;
export const QUALITY_TRACE_LIMIT = 1000;
export const QUALITY_DECISION_LIMIT = 256000;
export const QUALITY_INPUT_BYTES = 16 * 1024 * 1024;
export const QUALITY_METRIC_VERSION = "project-finding-sql-quality-metrics/v1";
export const QUALITY_POPULATION_VERSION = "admitted-holdout-canonical-pairs/v1";
export const QUALITY_LABEL_MAPPING_VERSION = "exclusive-strong-classes-and-distinct/v1";
export const QUALITY_STRONG_CLASSES = ["same_problem", "same_root_cause_different_instance"] as const;
export const QUALITY_TRUTH_LABELS = [...QUALITY_STRONG_CLASSES, "distinct", "insufficient_information"] as const;
export class QualityContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = "QualityContractError"; }
}
export const QualityDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const QualityUuidSchema = z.string().uuid().refine((v) => v === v.toLowerCase(), "UUID must be canonical lowercase");
export const QualityTimestampSchema = z.string().datetime({ offset: true });
const version = z.string().trim().min(1).max(128);
const digest = QualityDigestSchema;
export const QualityScopeSchema = z.object({
  project_id: QualityUuidSchema, code_digest: digest, config_digest: digest, selector_digest: digest,
  normalization_digest: digest, strong_rule_digest: digest,
  extractor_version: version, normalization_version: version,
  strong_rule_version: z.literal(STRONG_RELATION_RULE_VERSION),
  metric_version: z.literal(QUALITY_METRIC_VERSION),
  population_version: z.literal(QUALITY_POPULATION_VERSION),
  label_mapping_version: z.literal(QUALITY_LABEL_MAPPING_VERSION),
  source_digest: digest, corpus_digest: digest, dataset_digest: digest,
  tuning_digest: digest, split_digest: digest, labelset_digest: digest,
}).strict();
export type QualityScope = z.infer<typeof QualityScopeSchema>;
const threshold = z.object({ precision: z.number().finite().min(0).max(1), recall: z.number().finite().min(0).max(1) }).strict();
/** Metadata only: commit before raw holdout admission/access. No client actor,
 * freeze/access time, pass flags, raw labels, or future report digest. */
export const QualityProtocolBodySchema = z.object({
  schema_version: z.literal(1), scope: QualityScopeSchema,
  thresholds: z.object({ same_problem: threshold, same_root_cause_different_instance: threshold }).strict(),
  valid_until: QualityTimestampSchema,
}).strict();
export type QualityProtocolBody = z.infer<typeof QualityProtocolBodySchema>;
const source = z.object({
  // Actual Finding UUID, NEVER identity-source UUID.
  id: QualityUuidSchema, source_digest: digest, identity_digest: digest,
  provenance_digest: digest.nullable(), asset_group_digest: digest.nullable(),
  family_group_digest: digest.nullable(), split: z.enum(["tuning", "holdout"]),
}).strict();
const pair = z.object({
  left_id: QualityUuidSchema, right_id: QualityUuidSchema,
  label: z.enum(QUALITY_TRUTH_LABELS).nullable(), label_evidence_digest: digest.nullable(),
}).strict();
/** Single holdout label packet plus sealed tuning/split metadata. Declarations
 * do not authenticate human truth. No tuning labels enter this evaluator. */
export const QualityDatasetBodySchema = z.object({
  schema_version: z.literal(1), kind: z.enum(["synthetic", "human_labeled"]),
  sources: z.array(source).max(QUALITY_SOURCE_LIMIT), pairs: z.array(pair).max(QUALITY_LABEL_LIMIT),
}).strict().superRefine((value, ctx) => {
  const byId = new Map<string, typeof value.sources[number]>();
  for (const [i, row] of value.sources.entries()) {
    if (byId.has(row.id)) ctx.addIssue({ code: "custom", path: ["sources", i], message: "duplicate finding" });
    byId.set(row.id, row);
  }
  const seen = new Set<string>();
  for (const [i, row] of value.pairs.entries()) {
    const left = byId.get(row.left_id), right = byId.get(row.right_id);
    if (row.left_id >= row.right_id) ctx.addIssue({ code: "custom", path: ["pairs", i], message: "noncanonical pair" });
    if (!left || !right || left.split !== "holdout" || right.split !== "holdout") {
      ctx.addIssue({ code: "custom", path: ["pairs", i], message: "both endpoints must be admitted holdout" });
    }
    const key = `${row.left_id}:${row.right_id}`;
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["pairs", i], message: "duplicate pair" });
    seen.add(key);
  }
}).transform((v) => ({ ...v, sources: [...v.sources].sort((a,b) => a.id < b.id ? -1 : 1),
  pairs: [...v.pairs].sort((a,b) => `${a.left_id}:${a.right_id}` < `${b.left_id}:${b.right_id}` ? -1 : 1) }));
export type QualityDatasetBody = z.infer<typeof QualityDatasetBodySchema>;
/** Actual execution receipt, never a historical SQL freshness override. */
export const QualityRunBindingSchema = z.object({
  protocol_id: QualityUuidSchema, run_id: QualityUuidSchema, dataset_id: QualityUuidSchema,
  protocol_digest: digest, scope: QualityScopeSchema, evaluated_at: QualityTimestampSchema,
}).strict();
export type QualityRunBinding = z.infer<typeof QualityRunBindingSchema>;
function canonical(v: unknown): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) {
    if (Object.keys(v).length !== v.length || Object.keys(v).some((k,i) => k !== String(i))) throw new QualityContractError("INVALID_QUALITY_DIGEST_INPUT");
    return v.map(canonical);
  }
  if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
    return Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,x]) => [k,canonical(x)]));
  }
  throw new QualityContractError("INVALID_QUALITY_DIGEST_INPUT");
}
export function qualityDigest(v: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(v)), "utf8").digest("hex")}`;
}
/** Hash normalized declarations, not independent external truth. */
export function qualityDatasetDigests(v: unknown) {
  assertQualityBudget(v);
  const d = QualityDatasetBodySchema.parse(v);
  return { dataset_digest: qualityDigest(d),
    source_digest: qualityDigest(d.sources.map(({id,source_digest,identity_digest,provenance_digest}) => ({id,source_digest,identity_digest,provenance_digest}))),
    tuning_digest: qualityDigest(d.sources.filter((r) => r.split === "tuning")),
    split_digest: qualityDigest(d.sources.map(({id,split,asset_group_digest,family_group_digest}) => ({id,split,asset_group_digest,family_group_digest}))),
    labelset_digest: qualityDigest(d.pairs),
  };
}
/** Preflight before schema cloning; host also enforces raw body bytes. */
export function assertQualityBudget(v: unknown): void {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const r = v as Record<string,unknown>;
    const d = r.dataset && typeof r.dataset === "object" ? r.dataset as Record<string,unknown> : r;
    for (const [items,limit] of [[d.sources,QUALITY_SOURCE_LIMIT],[d.pairs,QUALITY_LABEL_LIMIT],
      [r.selections,QUALITY_TRACE_LIMIT],[r.decisions,QUALITY_DECISION_LIMIT]] as const) {
      if (Array.isArray(items) && items.length > limit) throw new QualityContractError("QUALITY_INPUT_LIMIT");
    }
  }
  let text: string | undefined;
  try { text = JSON.stringify(v); } catch { throw new QualityContractError("INVALID_QUALITY_INPUT"); }
  if (text === undefined) throw new QualityContractError("INVALID_QUALITY_INPUT");
  if (Buffer.byteLength(text,"utf8") > QUALITY_INPUT_BYTES) throw new QualityContractError("QUALITY_INPUT_LIMIT");
}
export type QualityVerification = "verified" | "unknown" | "rejected";
/** INTERNAL only: never accept from client declarations. Facts are derived
 * from checked immutable authenticated records. IDs/hashes alone are not truth. */
export interface QualityGateHostContext {
  current_scope: QualityScope; current_time: string;
  // Original SQL row, not a derived-facts hash or a client declaration.
  review_row: unknown;
  record: {
    review_id: string; review_digest: string; evaluation_id: string; protocol_id: string; run_id: string; dataset_id: string;
    protocol_digest: string; report_digest: string; scope: QualityScope; evidence_digest: string | null;
    reviewer_id: string; maker_ids: string[]; tuner_ids: string[]; registrar_ids: string[]; custodian_ids: string[];
    reviewer_alias_ids: string[]; forbidden_alias_ids: string[]; reviewer_authenticated: boolean;
    aliases_resolved: QualityVerification; conflicts_cleared: QualityVerification;
    independent_reviewer: QualityVerification; independent_human_labels: QualityVerification;
    source_provenance: QualityVerification; split_isolation: QualityVerification;
    denominator_complete: QualityVerification; observations_complete: QualityVerification;
    thresholds_adopted: QualityVerification; current_sources: QualityVerification;
    frozen_at: string; thresholds_adopted_at: string | null; dataset_admitted_at: string;
    first_holdout_access_at: string | null; reviewed_at: string; expires_at: string; revoked_at: string | null;
  };
}
