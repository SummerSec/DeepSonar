import { createHash } from "node:crypto";

export const EXTRACTOR_VERSION = "project-finding-features/v1";
export const NORMALIZATION_VERSION = "unicode-nfkc-lower/v1";
export const RELATION_RULE_VERSION = "project-finding-lexical/v1";
const TEXT_BUDGET = 16_000;
const TOKEN_BUDGET = 2_000;

export interface FindingFeatureSource {
  id: string;
  project_id: string;
  job_id: string;
  canvas_id: string;
  artifact_id: string | null;
  artifact_revision: number | null;
  title: string;
  location: string | null;
  summary: string | null;
  profile: string;
  category: string | null;
  source_digest: string | null;
  updated_at: string;
  evidence_refs_json?: unknown;
  artifact_evidence?: unknown;
}

export const IDENTITY_FIELDS = [
  "asset", "service", "tenant", "environment", "version", "parameter", "permission_boundary", "root_cause",
] as const;
export type IdentityField = typeof IDENTITY_FIELDS[number];

/** Reserved for a separately reviewed mapping from a real frozen target/evidence field.
 * Neither text extraction nor a free-form task target establishes this authority. */
export interface AuthoritativeFeature {
  value: string;
  source: { kind: "frozen_target" | "evidence"; ref: string; revision: string };
}

export interface FindingFeatures {
  finding_id: string;
  project_id: string;
  job_id: string;
  canvas_id: string;
  artifact_id: string | null;
  artifact_revision: number | null;
  source_digest: string;
  source_updated_at: string;
  extractor_version: string;
  normalization_version: string;
  declared: { profile: string; category: string | null; location: string | null };
  lexical: { title: string; location: string; summary: string; tokens: string[]; truncated: boolean };
  identity: Record<IdentityField, AuthoritativeFeature | null>;
  provenance: Array<{ field: string; kind: "declared" | "extracted" | "authoritative"; source_ref: string }>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Includes supplied evidence state without exposing evidence content in features. */
export function sourceInputDigest(source: FindingFeatureSource): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(source))).digest("hex")}`;
}

export function normalizeLexicalText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function lexicalTokens(value: string): string[] {
  const tokens = new Set<string>();
  for (const word of value.match(/[\p{L}\p{N}]+/gu) ?? []) {
    tokens.add(word);
    // Chinese text remains useful without whitespace; these are only lexical clues.
    if (/\p{Script=Han}/u.test(word)) {
      const points = Array.from(word);
      for (let index = 0; index + 1 < points.length && tokens.size <= TOKEN_BUDGET; index += 1) tokens.add(points[index] + points[index + 1]);
    }
    if (tokens.size > TOKEN_BUDGET) break;
  }
  return [...tokens].sort();
}

export function extractFindingFeatures(source: FindingFeatureSource): FindingFeatures {
  const fields = [source.title, source.location ?? "", source.summary ?? ""];
  let remaining = TEXT_BUDGET;
  const normalized = fields.map((text) => {
    const clipped = text.slice(0, remaining);
    remaining -= clipped.length;
    return normalizeLexicalText(clipped);
  });
  const allTokens = lexicalTokens(normalized.join(" "));
  return {
    finding_id: source.id,
    project_id: source.project_id,
    job_id: source.job_id,
    canvas_id: source.canvas_id,
    artifact_id: source.artifact_id,
    artifact_revision: source.artifact_revision,
    source_digest: sourceInputDigest(source),
    source_updated_at: source.updated_at,
    extractor_version: EXTRACTOR_VERSION,
    normalization_version: NORMALIZATION_VERSION,
    declared: { profile: source.profile, category: source.category, location: source.location },
    lexical: {
      title: normalized[0], location: normalized[1], summary: normalized[2],
      tokens: allTokens.slice(0, TOKEN_BUDGET),
      truncated: fields.reduce((sum, field) => sum + field.length, 0) > TEXT_BUDGET || allTokens.length > TOKEN_BUDGET,
    },
    identity: Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, null])) as FindingFeatures["identity"],
    provenance: [
      ...["profile", "category", "location"].map((field) => ({ field: `declared.${field}`, kind: "declared" as const, source_ref: `finding:${source.id}:${field}` })),
      ...["title", "location", "summary"].map((field) => ({ field: `lexical.${field}`, kind: "extracted" as const, source_ref: `finding:${source.id}:${field}` })),
    ],
  };
}

export type RelationKind = "suspected_same_issue" | "same_root_cause_different_instance" | "similar" | "distinct" | "insufficient_information";
export interface FindingRelationDecision {
  kind: RelationKind;
  matched_fields: string[];
  conflicts: IdentityField[];
  missing_fields: IdentityField[];
  rule_version: string;
  source_digests: [string, string];
  reason: "project_scope_mismatch" | "identity_conflict" | "version_continuity_unknown" | "lexical_overlap_only" | "identity_evidence_missing";
}

function known(feature: AuthoritativeFeature | null): feature is AuthoritativeFeature {
  return Boolean(feature?.value.trim() && feature.source?.ref.trim() && feature.source.revision.trim()
    && ["frozen_target", "evidence"].includes(feature.source.kind));
}

/** Jaccard is a ranking signal, not a probability or root-cause assertion. */
export function lexicalSimilarity(left: FindingFeatures, right: FindingFeatures): number {
  const a = new Set(left.lexical.tokens);
  const b = new Set(right.lexical.tokens);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

/** v1 deliberately cannot emit a strong relation: its quality/authority gate is unmet.
 * This is pairwise only; the result of A/B is never an input to B/C or A/C. */
export function compareFindingFeatures(left: FindingFeatures, right: FindingFeatures): FindingRelationDecision {
  const conflicts = IDENTITY_FIELDS.filter((field) => known(left.identity[field]) && known(right.identity[field])
    && left.identity[field]!.value !== right.identity[field]!.value);
  const missing = IDENTITY_FIELDS.filter((field) => !known(left.identity[field]) || !known(right.identity[field]));
  const result: FindingRelationDecision = {
    kind: "insufficient_information", matched_fields: [], conflicts, missing_fields: missing,
    rule_version: RELATION_RULE_VERSION, source_digests: [left.source_digest, right.source_digest], reason: "identity_evidence_missing",
  };
  if (left.project_id !== right.project_id) return { ...result, reason: "project_scope_mismatch" };
  if (conflicts.some((field) => field !== "version")) return { ...result, kind: "distinct", reason: "identity_conflict" };
  if (conflicts.includes("version")) return { ...result, reason: "version_continuity_unknown" };
  if (left.declared.category && left.declared.category === right.declared.category) result.matched_fields.push("declared.category");
  if (left.lexical.location && left.lexical.location === right.lexical.location) result.matched_fields.push("lexical.location");
  if (lexicalSimilarity(left, right) >= 0.25) {
    result.matched_fields.push("lexical.tokens");
    return { ...result, kind: "similar", reason: "lexical_overlap_only" };
  }
  return result;
}

export function rankLexicalCandidates(
  subject: FindingFeatures,
  candidates: readonly FindingFeatures[],
  options: { limit: number; scanBudget: number },
): { candidates: Array<{ finding_id: string; score: number }>; truncated: boolean; examined: number } {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50
    || !Number.isInteger(options.scanBudget) || options.scanBudget < 1 || options.scanBudget > 1_000) {
    throw new Error("invalid candidate budget");
  }
  const scanned = candidates.slice(0, options.scanBudget);
  const ranked = scanned.filter((candidate) => candidate.project_id === subject.project_id && candidate.finding_id !== subject.finding_id)
    .map((candidate) => ({ finding_id: candidate.finding_id, score: lexicalSimilarity(subject, candidate) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || (left.finding_id < right.finding_id ? -1 : left.finding_id > right.finding_id ? 1 : 0));
  return { candidates: ranked.slice(0, options.limit), truncated: candidates.length > scanned.length || ranked.length > options.limit, examined: scanned.length };
}
