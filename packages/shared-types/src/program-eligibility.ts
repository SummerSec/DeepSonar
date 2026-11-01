import { z } from "zod";

const uuid = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const findingSourceDigest = z.string().regex(/^v1:[a-f0-9]{64}$/);
const identifier = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const text = z.string().trim().min(1).max(2_000);
const longText = z.string().trim().min(1).max(4_000);

const uniqueIds = (items: readonly { id: string }[], path: string, ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [path, index, "id"], message: "IDs must be unique" });
    seen.add(item.id);
  }
};

const uniqueStrings = (items: readonly string[], path: string, ctx: z.RefinementCtx) => {
  if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
    ctx.addIssue({ code: "custom", path: [path], message: "References must be unique" });
  }
};

const boundedBytes = (value: unknown, limit: number, ctx: z.RefinementCtx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limit) {
    ctx.addIssue({ code: "custom", message: `Payload exceeds ${limit} UTF-8 bytes` });
  }
};

/** A trusted program authority admitted by the platform or project operator. */
export const ProgramMaterialAuthority = z.object({
  kind: z.enum(["program_authority", "platform_curated"]),
  name: text.max(500),
  reference: text.max(2_000),
  source_sha256: digest,
}).strict();
export type ProgramMaterialAuthority = z.infer<typeof ProgramMaterialAuthority>;

export const ProgramMaterialTarget = z.object({
  id: identifier,
  type: z.enum(["web", "api", "repository", "binary", "other"]),
  reference: text,
  baseline: text,
}).strict();
export type ProgramMaterialTarget = z.infer<typeof ProgramMaterialTarget>;

export const ProgramMaterialRule = z.object({
  id: identifier,
  kind: z.enum(["requirement", "exclusion"]),
  description: text,
}).strict();
export type ProgramMaterialRule = z.infer<typeof ProgramMaterialRule>;

/**
 * Management input for a trusted material admission. There is deliberately no
 * reviewer identity, trust flag, or `operator_supplied` provenance field here:
 * the Scheduler derives admission and identity from the authenticated actor.
 */
export const ProgramMaterialRegistrationRequest = z.object({
  schema_version: z.literal(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("platform") }).strict(),
    z.object({ kind: z.literal("project"), project_id: uuid }).strict(),
  ]),
  program_id: identifier,
  version: text.max(100),
  authority: ProgramMaterialAuthority,
  targets: z.array(ProgramMaterialTarget).min(1).max(50),
  rules: z.array(ProgramMaterialRule).min(1).max(100),
  supersedes_material_id: uuid.optional(),
  idempotency_key: uuid,
}).strict().superRefine((value, ctx) => {
  uniqueIds(value.targets, "targets", ctx);
  uniqueIds(value.rules, "rules", ctx);
  boundedBytes(value, 30_000, ctx);
});
export type ProgramMaterialRegistrationRequest = z.infer<typeof ProgramMaterialRegistrationRequest>;

export const ProgramMaterialRevokeRequest = z.object({
  schema_version: z.literal(1),
  reason: longText,
  idempotency_key: uuid,
}).strict().superRefine((value, ctx) => boundedBytes(value, 8_000, ctx));
export type ProgramMaterialRevokeRequest = z.infer<typeof ProgramMaterialRevokeRequest>;

export const ProgramEligibilityRuleAssessment = z.object({
  rule_id: identifier,
  result: z.enum(["satisfied", "violated", "unknown"]),
  evidence_refs: z.array(uuid).max(20),
}).strict();
export type ProgramEligibilityRuleAssessment = z.infer<typeof ProgramEligibilityRuleAssessment>;

/**
 * Human/operator review input. Reviewer identity and permission are absent by
 * design; the HTTP handler freezes them from `req.actor`.
 */
export const ProgramEligibilityReviewRequest = z.object({
  schema_version: z.literal(1),
  finding_id: uuid,
  finding_artifact_id: uuid,
  finding_artifact_revision: z.number().int().positive(),
  finding_source_digest: findingSourceDigest,
  program_material_id: uuid,
  program_id: identifier,
  program_version: text.max(100),
  program_source_sha256: digest,
  target_id: identifier,
  target_reference: text,
  baseline: text,
  decision: z.enum(["approve", "reject"]),
  rule_assessments: z.array(ProgramEligibilityRuleAssessment).min(1).max(100),
  evidence_refs: z.array(uuid).min(1).max(100),
  reason: longText,
  idempotency_key: uuid,
}).strict().superRefine((value, ctx) => {
  const ids = value.rule_assessments.map((item) => item.rule_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["rule_assessments"], message: "Rule assessments must be unique" });
  uniqueStrings(value.evidence_refs, "evidence_refs", ctx);
  const evidence = new Set(value.evidence_refs.map((ref) => ref.toLowerCase()));
  value.rule_assessments.forEach((item, index) => {
    if (item.evidence_refs.some((ref) => !evidence.has(ref.toLowerCase()))) {
      ctx.addIssue({ code: "custom", path: ["rule_assessments", index, "evidence_refs"], message: "Rule evidence must be listed in evidence_refs" });
    }
  });
  boundedBytes(value, 40_000, ctx);
});
export type ProgramEligibilityReviewRequest = z.infer<typeof ProgramEligibilityReviewRequest>;

export const ProgramEligibilityReviewer = z.object({
  actor_type: z.enum(["bootstrap_admin", "api_token", "user"]),
  actor_id: text.max(200),
  actor_name: text.max(200),
  role: z.enum(["admin", "operator"]).optional(),
  permission: z.enum(["admin", "findings:write"]),
}).strict();
export type ProgramEligibilityReviewer = z.infer<typeof ProgramEligibilityReviewer>;

export const ProgramEligibilityEvidenceBinding = z.object({
  ref: uuid,
  kind: z.enum(["fact", "artifact_evidence"]),
  artifact_id: uuid,
  artifact_revision: z.number().int().positive(),
  fingerprint: digest,
}).strict();
export type ProgramEligibilityEvidenceBinding = z.infer<typeof ProgramEligibilityEvidenceBinding>;

export const ProgramEligibilityTechnicalBinding = z.object({
  finding_id: uuid,
  artifact_id: uuid,
  artifact_revision: z.number().int().positive(),
  source_digest: findingSourceDigest,
  target_reference: text,
  baseline: text.nullable(),
  verification_round_id: uuid,
  verification_attempt: z.number().int().positive(),
  confirmation_digest: digest,
}).strict();
export type ProgramEligibilityTechnicalBinding = z.infer<typeof ProgramEligibilityTechnicalBinding>;

export const ProgramEligibilityMaterialBinding = z.object({
  material_id: uuid,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("platform") }).strict(),
    z.object({ kind: z.literal("project"), project_id: uuid }).strict(),
  ]),
  program_id: identifier,
  version: text.max(100),
  source_sha256: digest,
  target_id: identifier,
  target_reference: text,
  baseline: text,
}).strict();
export type ProgramEligibilityMaterialBinding = z.infer<typeof ProgramEligibilityMaterialBinding>;

/** Scheduler-owned immutable audit record. */
export const ProgramEligibilityReviewRecord = z.object({
  schema_version: z.literal(1),
  review_id: uuid,
  request: ProgramEligibilityReviewRequest,
  reviewer: ProgramEligibilityReviewer,
  reviewed_at: z.string().datetime({ offset: true }),
  status: z.enum(["eligible", "ineligible", "blocked"]),
  reason_codes: z.array(identifier).max(30),
  technical_binding: ProgramEligibilityTechnicalBinding.nullable(),
  material_binding: ProgramEligibilityMaterialBinding.nullable(),
  evidence_bindings: z.array(ProgramEligibilityEvidenceBinding).max(100),
  evidence_digest: digest.nullable(),
  request_digest: digest,
}).strict();
export type ProgramEligibilityReviewRecord = z.infer<typeof ProgramEligibilityReviewRecord>;

export const ProgramEligibilityStatus = z.enum(["not_assessed", "eligible", "ineligible", "blocked"]);
export type ProgramEligibilityStatus = z.infer<typeof ProgramEligibilityStatus>;

export const ProgramEligibilityProjection = z.object({
  status: ProgramEligibilityStatus,
  finding_id: uuid,
  technical_status: z.string().min(1).max(50),
  current_review_id: uuid.nullable(),
  current_material_id: uuid.nullable(),
  gaps: z.array(identifier).max(50),
  historical_review_ids: z.array(uuid).max(100),
}).strict();
export type ProgramEligibilityProjection = z.infer<typeof ProgramEligibilityProjection>;

export function normalizeProgramMaterialRegistration(input: unknown): ProgramMaterialRegistrationRequest {
  const value = ProgramMaterialRegistrationRequest.parse(input);
  return {
    ...value,
    program_id: value.program_id.trim(),
    version: value.version.trim(),
    targets: [...value.targets].sort((a, b) => a.id.localeCompare(b.id)),
    rules: [...value.rules].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function normalizeProgramEligibilityReview(input: unknown): ProgramEligibilityReviewRequest {
  const value = ProgramEligibilityReviewRequest.parse(input);
  return {
    ...value,
    program_id: value.program_id.trim(),
    program_version: value.program_version.trim(),
    target_id: value.target_id.trim(),
    target_reference: value.target_reference.trim(),
    baseline: value.baseline.trim(),
    rule_assessments: [...value.rule_assessments].sort((a, b) => a.rule_id.localeCompare(b.rule_id)).map((item) => ({
      ...item,
      evidence_refs: [...item.evidence_refs].map((ref) => ref.toLowerCase()).sort(),
    })),
    evidence_refs: [...value.evidence_refs].map((ref) => ref.toLowerCase()).sort(),
  };
}
