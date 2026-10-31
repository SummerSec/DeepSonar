import { z } from "zod";

export const KNOWLEDGE_LIMITS = Object.freeze({ page: 20, readBytes: 12 * 1024, bundleBytes: 128 * 1024, files: 20, jobs: 32, revisions: 2, seconds: 1800 });
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().min(1).max(max);
const utf8 = (value: string) => new TextEncoder().encode(value).length;
export const ProjectKnowledgeKind = z.enum(["memory", "skill"]);
export type ProjectKnowledgeKind = z.infer<typeof ProjectKnowledgeKind>;
export const ProjectKnowledgeStatus = z.enum(["draft", "active", "stale", "retired", "revoked"]);
export type ProjectKnowledgeStatus = z.infer<typeof ProjectKnowledgeStatus>;
export const KnowledgeAction = z.enum(["reuse", "revise", "create", "merge", "retire"]);
export type KnowledgeAction = z.infer<typeof KnowledgeAction>;
export const KnowledgeWorkStage = z.enum(["discover", "propose", "evaluate", "review", "settle"]);
export type KnowledgeWorkStage = z.infer<typeof KnowledgeWorkStage>;
export const KNOWLEDGE_CASE_KINDS = ["target", "negative_trigger", "missing_input", "cross_project", "coexistence", "revocation"] as const;
export const KnowledgeCaseKind = z.enum(KNOWLEDGE_CASE_KINDS);
export const KnowledgeArm = z.enum(["without", "baseline", "candidate"]);
export type KnowledgeArm = z.infer<typeof KnowledgeArm>;

export function isKnowledgeTextPath(path: string): boolean {
  return path === "SKILL.md" || /^references\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:md|txt|json|yaml|yml|csv)$/u.test(path);
}
export const KnowledgeSkillBundle = z.record(z.string(), z.string()).superRefine((files, ctx) => {
  const entries = Object.entries(files);
  if (!files["SKILL.md"]?.trim()) ctx.addIssue({ code: "custom", message: "SKILL.md is required" });
  if (entries.length > KNOWLEDGE_LIMITS.files) ctx.addIssue({ code: "custom", message: "Skill file count exceeds 20" });
  if (entries.some(([path]) => !isKnowledgeTextPath(path))) ctx.addIssue({ code: "custom", message: "Only safe text paths are accepted" });
  if (entries.reduce((n, [path, content]) => n + utf8(path) + utf8(content), 0) > KNOWLEDGE_LIMITS.bundleBytes) {
    ctx.addIssue({ code: "custom", message: "Skill exceeds 131072 UTF-8 bytes" });
  }
});
export const KnowledgeSourceRef = z.object({ kind: z.enum(["evidence", "fact", "asset"]), ref: text(240), content_hash: hash }).strict();
export type KnowledgeSourceRef = z.infer<typeof KnowledgeSourceRef>;
export const KnowledgeBaseRef = z.object({ item_ref: uuid, version_ref: uuid, generation: z.number().int().nonnegative(), content_hash: hash }).strict();
export type KnowledgeBaseRef = z.infer<typeof KnowledgeBaseRef>;
export const KnowledgeCandidate = z.object({
  kind: ProjectKnowledgeKind,
  logical_key: text(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
  title: text(200), keywords: z.array(text(80)).max(20).default([]),
  content: z.string().optional(), files: KnowledgeSkillBundle.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "memory" && (!value.content?.trim() || value.files !== undefined || utf8(value.content) > KNOWLEDGE_LIMITS.readBytes)) {
    ctx.addIssue({ code: "custom", message: "Memory requires only content, at most 12288 UTF-8 bytes" });
  }
  if (value.kind === "skill" && (!value.files || value.content !== undefined)) ctx.addIssue({ code: "custom", message: "Skill requires only a validated files bundle" });
});
export type KnowledgeCandidate = z.infer<typeof KnowledgeCandidate>;
export const KnowledgeEvaluationCase = z.object({
  id: text(80), kind: KnowledgeCaseKind, prompt: text(6000), expected: text(2000), critical: z.boolean().default(true),
}).strict();
export type KnowledgeEvaluationCase = z.infer<typeof KnowledgeEvaluationCase>;
export const KnowledgeCaseResult = z.object({
  case_id: text(80), arm: KnowledgeArm, trial_job_ref: uuid, trial_attempt_ref: uuid,
  outcome: z.enum(["pass", "fail", "unexecuted"]), evidence_refs: z.array(text(240)).min(1).max(20),
  reason: text(2000),
}).strict();
export type KnowledgeCaseResult = z.infer<typeof KnowledgeCaseResult>;
export const RequestProjectKnowledgePayload = z.object({ source_refs: z.array(KnowledgeSourceRef).min(1).max(20), reason: text(2000) }).strict();
export const SearchProjectKnowledgePayload = z.object({
  kind: ProjectKnowledgeKind.optional(), query: z.string().max(200).optional(), keywords: z.array(text(80)).max(10).optional(),
  cursor: text(1000).optional(), limit: z.number().int().min(1).max(KNOWLEDGE_LIMITS.page).default(10),
}).strict();
export const ReadProjectMemoryPayload = z.object({ item_ref: uuid, version: z.number().int().positive(), expected_hash: hash }).strict();
export const ReadKnowledgeInputPayload = z.object({ work_ref: uuid, input_ref: text(240), expected_hash: hash, cursor: text(1000).optional() }).strict();
export const ProposeProjectKnowledgePayload = z.object({
  work_ref: uuid, action: KnowledgeAction, revision: z.number().int().min(1).max(3), parent_proposal_ref: uuid.optional(),
  base_refs: z.array(KnowledgeBaseRef).max(20), candidate: KnowledgeCandidate.optional(), source_refs: z.array(KnowledgeSourceRef).max(20),
  reason: text(2000), evaluation_plan: z.array(KnowledgeEvaluationCase).max(20).default([]),
}).strict().superRefine((input, ctx) => {
  if (["create", "revise", "merge"].includes(input.action) && !input.candidate) ctx.addIssue({ code: "custom", message: "Candidate required for this action" });
  if (input.action !== "create" && input.base_refs.length === 0) ctx.addIssue({ code: "custom", message: "Exact baseline references required" });
  if (input.action === "create" && input.base_refs.length > 0) ctx.addIssue({ code: "custom", message: "Create must not replace a baseline" });
});
export const SubmitKnowledgeEvaluationPayload = z.object({ proposal_ref: uuid, revision: z.number().int().positive(), input_digest: hash, case_results: z.array(KnowledgeCaseResult).min(1).max(100) }).strict();
export const ReviewProjectKnowledgePayload = z.object({
  proposal_ref: uuid, revision: z.number().int().positive(), input_digest: hash,
  decision: z.enum(["approve", "needs_eval", "reject"]), reason: text(2000), evidence_refs: z.array(text(240)).max(20), remaining_checks: z.array(text(200)).max(20),
}).strict();
export const RecordKnowledgeFeedbackPayload = z.object({
  usage_ref: uuid, outcome: z.enum(["success", "failure", "inapplicable"]), evidence_refs: z.array(KnowledgeSourceRef).min(1).max(20),
  next_action: z.enum(["reuse", "reevaluate", "revise", "merge", "retire"]), reason: text(2000),
}).strict();
export const GetKnowledgeReceiptPayload = z.object({ receipt_ref: uuid.optional(), idempotency_key: uuid.optional() }).strict()
  .refine((input) => Number(Boolean(input.receipt_ref)) + Number(Boolean(input.idempotency_key)) === 1, { message: "Exactly one receipt reference required" });

export const SkillSuggestionTarget = z.object({
  task_type: text(80), input_kind: text(80), target_version: text(160),
}).strict();
export const SkillApplicability = z.object({
  schema: z.literal("deepsonar.skill-applicability/v1"),
  task_types: z.array(text(80)).min(1).max(20), input_kinds: z.array(text(80)).min(1).max(20),
  target_versions: z.array(text(160)).min(1).max(20),
  runtime_digests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1).max(20),
  required_tools: z.array(text(80)).max(40), requires_network: z.boolean(),
  minimum_seconds: z.number().int().nonnegative().max(86400),
  minimum_tokens: z.number().int().nonnegative().max(10000000),
}).strict();
export const SuggestProjectSkillsPayload = z.object({
  target: SkillSuggestionTarget, limit: z.number().int().min(1).max(10).default(5),
  offset: z.number().int().min(0).max(20).default(0),
}).strict();
export const RecordSkillChoicePayload = SuggestProjectSkillsPayload.extend({
  policy_version: z.literal("deepsonar.skill-suggestions/v1"), context_hash: hash, catalog_hash: hash,
  decision: z.enum(["select", "reject", "none"]), selector: text(240).optional(),
  expected_content_hash: hash.optional(), reason: text(2000),
}).strict().superRefine((value, ctx) => {
  const exact = value.selector !== undefined && value.expected_content_hash !== undefined;
  if (value.decision === "none" ? value.selector !== undefined || value.expected_content_hash !== undefined : !exact)
    ctx.addIssue({ code: "custom", message: "Select/reject requires exact identity; none forbids it" });
});
export type SuggestProjectSkillsPayload = z.infer<typeof SuggestProjectSkillsPayload>;
export type RecordSkillChoicePayload = z.infer<typeof RecordSkillChoicePayload>;

export const KnowledgeControlPayloadSchemas = {
  suggest_project_skills: SuggestProjectSkillsPayload,
  record_skill_choice: RecordSkillChoicePayload,
  request_project_knowledge: RequestProjectKnowledgePayload,
  search_project_knowledge: SearchProjectKnowledgePayload,
  read_project_memory: ReadProjectMemoryPayload,
  read_knowledge_input: ReadKnowledgeInputPayload,
  propose_project_knowledge: ProposeProjectKnowledgePayload,
  submit_knowledge_evaluation: SubmitKnowledgeEvaluationPayload,
  review_project_knowledge: ReviewProjectKnowledgePayload,
  record_knowledge_feedback: RecordKnowledgeFeedbackPayload,
  get_knowledge_receipt: GetKnowledgeReceiptPayload,
} as const;
export const KNOWLEDGE_OPERATION_IDS = Object.keys(KnowledgeControlPayloadSchemas) as Array<keyof typeof KnowledgeControlPayloadSchemas>;
export const KNOWLEDGE_MUTATION_IDS = ["record_skill_choice", "request_project_knowledge", "propose_project_knowledge", "submit_knowledge_evaluation", "review_project_knowledge", "record_knowledge_feedback"] as const;
export const KnowledgeMutationPayload = z.object({ operation: z.enum(KNOWLEDGE_MUTATION_IDS), input: z.unknown() }).strict()
  .superRefine((value, ctx) => {
    const result = KnowledgeControlPayloadSchemas[value.operation].safeParse(value.input);
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: "custom", path: ["input", ...issue.path], message: "Knowledge operation input violates strict contract" });
  });
export type KnowledgeOperation = keyof typeof KnowledgeControlPayloadSchemas;
export type RequestProjectKnowledgePayload = z.infer<typeof RequestProjectKnowledgePayload>;
export type SearchProjectKnowledgePayload = z.infer<typeof SearchProjectKnowledgePayload>;
export type ReadProjectMemoryPayload = z.infer<typeof ReadProjectMemoryPayload>;
export type ReadKnowledgeInputPayload = z.infer<typeof ReadKnowledgeInputPayload>;
export type ProposeProjectKnowledgePayload = z.infer<typeof ProposeProjectKnowledgePayload>;
export type SubmitKnowledgeEvaluationPayload = z.infer<typeof SubmitKnowledgeEvaluationPayload>;
export type ReviewProjectKnowledgePayload = z.infer<typeof ReviewProjectKnowledgePayload>;
export type RecordKnowledgeFeedbackPayload = z.infer<typeof RecordKnowledgeFeedbackPayload>;
export type GetKnowledgeReceiptPayload = z.infer<typeof GetKnowledgeReceiptPayload>;

export interface KnowledgeInputManifestEntry {
  input_ref: string; kind: "evidence" | "fact" | "asset" | "candidate" | "evaluation";
  project_id: string; content_hash: string; bytes: number; blob_hash: string;
  audience: Array<"maker" | "evaluator" | "reviewer" | "trial">;
}
export interface KnowledgeJobAssignment {
  work_id: string; stage: "maker" | "evaluator" | "reviewer" | "trial";
  proposal_id?: string; input_digest?: string; case_id?: string; arm?: KnowledgeArm;
  inputs: KnowledgeInputManifestEntry[]; governance_hash: string;
}
export interface KnowledgeReceipt {
  id: string; project_id: string; job_id: string; operation: string; idempotency_key: string;
  input_digest: string; state: "settled"; result_json: Record<string, unknown>; event_id: string;
}
export interface ProjectKnowledgeListItem {
  id: string; project_id: string; kind: ProjectKnowledgeKind; logical_key: string; title: string;
  status: ProjectKnowledgeStatus; version: number; version_id: string; content_sha256: string; generation: number; keywords: string[];
}
export interface ProjectKnowledgeListResponse { items: ProjectKnowledgeListItem[]; next_cursor: string | null }
export interface ProjectKnowledgeDetail extends ProjectKnowledgeListItem {
  content: string | Record<string, string>; sources: KnowledgeSourceRef[]; versions: Record<string, unknown>[];
  proposals: Record<string, unknown>[]; evaluations: Record<string, unknown>[]; usages: Record<string, unknown>[];
}
