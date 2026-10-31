import { createHash } from "node:crypto";
import type { Actor } from "../../auth.js";
import {
  normalizeProgramEligibilityReview,
  normalizeProgramMaterialRegistration,
  type ProgramEligibilityMaterialBinding,
  type ProgramEligibilityReviewRecord,
  type ProgramEligibilityReviewRequest,
  type ProgramEligibilityStatus,
  type ProgramMaterialRegistrationRequest,
} from "@deepsonar/shared-types";

export const PROGRAM_ELIGIBILITY_ACTIONS = {
  materialRegister: "program_material.register",
  materialRevoke: "program_material.revoke",
  materialSupersede: "program_material.supersede",
  review: "program_eligibility.review",
} as const;

export type ProgramMaterialStatus = "active" | "revoked" | "superseded";

export interface StoredProgramMaterial {
  schema_version: 1;
  material_id: string;
  request: ProgramMaterialRegistrationRequest;
  registered_at: string;
  registered_by: {
    actor_type: "bootstrap_admin" | "api_token" | "user";
    actor_id: string;
    actor_name: string;
    permission: "admin" | "projects:write";
  };
  registration_digest: string;
}

export interface ProgramMaterialView extends StoredProgramMaterial {
  status: ProgramMaterialStatus;
  superseded_by: string | null;
  revoked_at: string | null;
}

export interface CurrentFindingBinding {
  finding_id: string;
  project_id: string;
  canvas_id: string | null;
  source_job_id: string;
  source_job_status: string;
  source_attempt_id: string | null;
  source_attempt_status: string | null;
  source_latest_attempt_id: string | null;
  artifact_id: string | null;
  artifact_revision: number | null;
  artifact_status: string | null;
  artifact_superseded_at: string | null;
  source_digest: string | null;
  target_reference: string | null;
  baseline: string | null;
  verify_status: string;
  verification_round_id: string | null;
  verification_attempt: number | null;
  verification_round_status: string | null;
  verification_round_outcome: string | null;
  technical_confirmation_digest: string | null;
  /** Scheduler/audit-derived creator identities used to forbid maker self-approval. */
  source_maker_actor_ids?: string[];
  reasons: string[];
}

export interface CurrentEvidenceBinding {
  ref: string;
  kind: "fact" | "artifact_evidence";
  artifact_id: string;
  artifact_revision: number;
  fingerprint: string;
}

export interface EligibilityProjectionInput {
  findingId: string;
  technicalStatus: string;
  technicalBinding: CurrentFindingBinding | null;
  technicalGaps: string[];
  material: ProgramMaterialView | null;
  materialGaps: string[];
  currentEvidenceDigest: string | null;
  currentEvidenceDigests?: ReadonlyMap<string, string | null>;
  reviews: ProgramEligibilityReviewRecord[];
  /** Any malformed/truncated append-only history is a fail-closed input. */
  historyInvalid?: boolean;
}

export interface EligibilityProjection {
  status: ProgramEligibilityStatus;
  finding_id: string;
  technical_status: string;
  current_review_id: string | null;
  current_material_id: string | null;
  gaps: string[];
  historical_review_ids: string[];
}

function canonicalDigestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDigestValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalDigestValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function jsonDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalDigestValue(value)) ?? "null", "utf8").digest("hex")}`;
}

export function normalizeMaterial(input: unknown): ProgramMaterialRegistrationRequest {
  return normalizeProgramMaterialRegistration(input);
}

export function normalizeReview(input: unknown): ProgramEligibilityReviewRequest {
  return normalizeProgramEligibilityReview(input);
}

export function requestDigest(input: unknown): string {
  return jsonDigest(normalizeReview(input));
}

export function materialRequestDigest(input: unknown): string {
  return jsonDigest(normalizeMaterial(input));
}

export function actorId(actor: Actor): string {
  return actor.id ?? actor.name;
}

export function reviewerFromActor(actor: Actor): ProgramEligibilityReviewRecord["reviewer"] {
  if (!canReviewEligibility(actor) || actor.type === "internal") throw new Error("actor is not authorized to approve program eligibility");
  const permission = actor.scopes.includes("admin") ? "admin" : "findings:write";
  return {
    actor_type: actor.type,
    actor_id: actorId(actor),
    actor_name: actor.name,
    ...(actor.role === "admin" || actor.role === "operator" ? { role: actor.role } : {}),
    permission,
  };
}

export function canReviewEligibility(actor: Actor | undefined): boolean {
  if (!actor || actor.type === "internal") return false;
  if (actor.type === "user" && actor.role !== "admin" && actor.role !== "operator") return false;
  return actor.scopes.includes("admin") || actor.scopes.includes("findings:write");
}

export function canRegisterMaterial(actor: Actor | undefined, scope: ProgramMaterialRegistrationRequest["scope"]): boolean {
  if (!actor || actor.type === "internal") return false;
  if (actor.type === "user" && actor.role !== "admin" && actor.role !== "operator") return false;
  if (actor.projectId && (scope.kind === "platform" || scope.project_id !== actor.projectId)) return false;
  if (scope.kind === "platform") return actor.scopes.includes("admin");
  return actor.scopes.includes("admin") || actor.scopes.includes("projects:write");
}

export function materialBinding(material: StoredProgramMaterial, request: ProgramEligibilityReviewRequest): ProgramEligibilityMaterialBinding | null {
  const target = material.request.targets.find((item) => item.id === request.target_id);
  if (!target || material.request.program_id !== request.program_id || material.request.version !== request.program_version
    || material.request.authority.source_sha256 !== request.program_source_sha256
    || target.reference !== request.target_reference || target.baseline !== request.baseline
    || material.material_id !== request.program_material_id) return null;
  return {
    material_id: material.material_id,
    scope: material.request.scope,
    program_id: material.request.program_id,
    version: material.request.version,
    source_sha256: material.request.authority.source_sha256,
    target_id: target.id,
    target_reference: target.reference,
    baseline: target.baseline,
  };
}

export function findingTargetMatches(request: ProgramEligibilityReviewRequest, finding: CurrentFindingBinding): boolean {
  return finding.target_reference !== null && finding.baseline !== null
    && finding.target_reference === request.target_reference
    && finding.baseline === request.baseline;
}

export function materialStatus(events: readonly {
  action: string;
  resourceId: string | null;
  after: Record<string, unknown>;
  at: string;
}[], materialId: string): { status: ProgramMaterialStatus; supersededBy: string | null; revokedAt: string | null } {
  let status: ProgramMaterialStatus = "active";
  let supersededBy: string | null = null;
  let revokedAt: string | null = null;
  for (const event of events) {
    if (event.resourceId !== materialId && String(event.after.material_id ?? "") !== materialId) continue;
    if (event.action === PROGRAM_ELIGIBILITY_ACTIONS.materialRevoke) {
      status = "revoked";
      revokedAt = event.at;
    } else if (event.action === PROGRAM_ELIGIBILITY_ACTIONS.materialSupersede) {
      status = "superseded";
      supersededBy = typeof event.after.replacement_material_id === "string" ? event.after.replacement_material_id : null;
    }
  }
  return { status, supersededBy, revokedAt };
}

function sameTechnicalBinding(review: ProgramEligibilityReviewRecord, current: CurrentFindingBinding): boolean {
  const binding = review.technical_binding;
  return Boolean(binding && current.technical_confirmation_digest
    && binding.finding_id === current.finding_id
    && binding.artifact_id === current.artifact_id
    && binding.artifact_revision === current.artifact_revision
    && binding.source_digest === current.source_digest
    && binding.target_reference === current.target_reference
    && binding.baseline === current.baseline
    && binding.verification_round_id === current.verification_round_id
    && binding.verification_attempt === current.verification_attempt
    && binding.confirmation_digest === current.technical_confirmation_digest);
}

function sameMaterialBinding(review: ProgramEligibilityReviewRecord, material: ProgramMaterialView): boolean {
  const target = material.request.targets.find((item) => item.id === review.request.target_id);
  return Boolean(target && review.material_binding && review.material_binding.material_id === material.material_id
    && review.material_binding.program_id === material.request.program_id
    && review.material_binding.version === material.request.version
    && review.material_binding.source_sha256 === material.request.authority.source_sha256
    && review.material_binding.target_id === target.id
    && review.material_binding.target_reference === target.reference
    && review.material_binding.baseline === target.baseline);
}

/**
 * Current eligibility is a projection over immutable reviews and current
 * Finding/material/evidence bindings. A stale positive record never survives
 * merely because it was once approved.
 */
export function projectProgramEligibility(input: EligibilityProjectionInput): EligibilityProjection {
  const historical = input.reviews.map((review) => review.review_id);
  const gaps = [...new Set([...input.technicalGaps, ...input.materialGaps])];
  if (!input.reviews.length) gaps.push("eligibility_review_missing");
  if (input.historyInvalid) {
    return {
      status: "blocked", finding_id: input.findingId, technical_status: input.technicalStatus,
      current_review_id: null, current_material_id: input.material?.material_id ?? null,
      gaps: [...new Set([...gaps, "eligibility_history_invalid"])], historical_review_ids: historical,
    };
  }
  if (!input.reviews.length) {
    return {
      status: "not_assessed", finding_id: input.findingId, technical_status: input.technicalStatus,
      current_review_id: null, current_material_id: input.material?.material_id ?? null,
      gaps: [...new Set(gaps)], historical_review_ids: historical,
    };
  }
  if (!input.technicalBinding || input.technicalGaps.length) {
    return {
      status: "blocked", finding_id: input.findingId, technical_status: input.technicalStatus,
      current_review_id: null, current_material_id: input.material?.material_id ?? null,
      gaps: [...new Set(gaps.length ? gaps : ["technical_confirmation_unavailable"])], historical_review_ids: historical,
    };
  }
  if (input.materialGaps.length) {
    return {
      status: "blocked", finding_id: input.findingId, technical_status: input.technicalStatus,
      current_review_id: null, current_material_id: input.material?.material_id ?? null,
      gaps: [...new Set(gaps)], historical_review_ids: historical,
    };
  }
  if (!input.material) {
    return {
      status: input.reviews.length ? "blocked" : "not_assessed", finding_id: input.findingId,
      technical_status: input.technicalStatus, current_review_id: null, current_material_id: null,
      gaps: [...new Set(gaps.length ? gaps : ["program_material_not_bound"])], historical_review_ids: historical,
    };
  }

  if (input.material.status !== "active") {
    return {
      status: "blocked", finding_id: input.findingId, technical_status: input.technicalStatus,
      current_review_id: null, current_material_id: input.material.material_id,
      gaps: [...new Set([...gaps, "program_material_not_current"])], historical_review_ids: historical,
    };
  }

  const matching = input.reviews.filter((review) => sameTechnicalBinding(review, input.technicalBinding!)
    && sameMaterialBinding(review, input.material!)
    && review.evidence_digest !== null
    && review.evidence_digest === (input.currentEvidenceDigests?.has(review.review_id)
      ? input.currentEvidenceDigests.get(review.review_id) ?? null
      : input.currentEvidenceDigest ?? null));
  if (!matching.length) {
    const evidenceUnavailable = input.reviews.length > 0
      && input.reviews.every((review) => (input.currentEvidenceDigests?.has(review.review_id)
        ? input.currentEvidenceDigests.get(review.review_id) ?? null
        : input.currentEvidenceDigest ?? null) === null);
    gaps.push(input.reviews.length ? (evidenceUnavailable ? "eligibility_evidence_unavailable" : "eligibility_review_stale_or_invalid") : "eligibility_review_missing");
    return {
      status: input.reviews.length ? "blocked" : "not_assessed", finding_id: input.findingId,
      technical_status: input.technicalStatus, current_review_id: null, current_material_id: input.material.material_id,
      gaps: [...new Set(gaps)], historical_review_ids: historical,
    };
  }
  const eligible = matching.filter((review) => review.status === "eligible");
  const ineligible = matching.filter((review) => review.status === "ineligible");
  const blocked = matching.filter((review) => review.status === "blocked");
  if (blocked.length || (eligible.length && ineligible.length)) {
    gaps.push(blocked.length ? "eligibility_review_blocked" : "eligibility_review_conflict");
    return {
      status: "blocked", finding_id: input.findingId, technical_status: input.technicalStatus,
      current_review_id: null, current_material_id: input.material.material_id,
      gaps: [...new Set(gaps)], historical_review_ids: historical,
    };
  }
  const winner = eligible[0] ?? ineligible[0]!;
  return {
    status: eligible.length ? "eligible" : "ineligible", finding_id: input.findingId,
    technical_status: input.technicalStatus, current_review_id: winner.review_id,
    current_material_id: input.material.material_id, gaps: [...new Set(gaps)], historical_review_ids: historical,
  };
}

export function assessProgramRules(
  material: StoredProgramMaterial,
  request: ProgramEligibilityReviewRequest,
): string[] {
  const rules = new Map(material.request.rules.map((rule) => [rule.id, rule]));
  const assessments = new Map(request.rule_assessments.map((item) => [item.rule_id, item]));
  const reasons: string[] = [];
  for (const ruleId of assessments.keys()) if (!rules.has(ruleId)) reasons.push("program_rule_unknown");
  for (const rule of material.request.rules) {
    const assessment = assessments.get(rule.id);
    if (!assessment) {
      reasons.push("program_rule_missing");
      continue;
    }
    if (assessment.result === "unknown") reasons.push("program_rule_unknown");
    if (!assessment.evidence_refs.length) reasons.push("program_rule_evidence_missing");
    if (rule.kind === "requirement" && assessment.result === "violated") reasons.push("program_requirement_not_met");
    if (rule.kind === "exclusion" && assessment.result === "violated") reasons.push("program_exclusion_applies");
  }
  return [...new Set(reasons)];
}
