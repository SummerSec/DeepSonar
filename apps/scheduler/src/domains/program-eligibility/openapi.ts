import type { Op } from "../../openapi.js";

const Uuid = { type: "string", format: "uuid" };
const Digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
const FindingDigest = { type: "string", pattern: "^v1:[a-f0-9]{64}$" };
const MaterialScope = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: ["platform"] } } },
    { type: "object", additionalProperties: false, required: ["kind", "project_id"], properties: { kind: { type: "string", enum: ["project"] }, project_id: Uuid } },
  ],
};
const MaterialTarget = {
  type: "object", additionalProperties: false, required: ["id", "type", "reference", "baseline"],
  properties: { id: { type: "string" }, type: { type: "string", enum: ["web", "api", "repository", "binary", "other"] }, reference: { type: "string" }, baseline: { type: "string" } },
};
const MaterialRule = {
  type: "object", additionalProperties: false, required: ["id", "kind", "description"],
  properties: { id: { type: "string" }, kind: { type: "string", enum: ["requirement", "exclusion"] }, description: { type: "string" } },
};
const MaterialRegistration = {
  type: "object", additionalProperties: false,
  required: ["schema_version", "scope", "program_id", "version", "authority", "targets", "rules", "idempotency_key"],
  properties: {
    schema_version: { type: "integer", enum: [1] }, scope: MaterialScope, program_id: { type: "string" }, version: { type: "string" },
    authority: { type: "object", additionalProperties: false, required: ["kind", "name", "reference", "source_sha256"], properties: {
      kind: { type: "string", enum: ["program_authority", "platform_curated"] }, name: { type: "string" }, reference: { type: "string" }, source_sha256: Digest,
    } },
    targets: { type: "array", minItems: 1, items: MaterialTarget }, rules: { type: "array", minItems: 1, items: MaterialRule },
    supersedes_material_id: { ...Uuid, nullable: true }, idempotency_key: Uuid,
  },
};
const Review = {
  type: "object", additionalProperties: false,
  required: ["schema_version", "finding_id", "finding_artifact_id", "finding_artifact_revision", "finding_source_digest", "program_material_id", "program_id", "program_version", "program_source_sha256", "target_id", "target_reference", "baseline", "decision", "rule_assessments", "evidence_refs", "reason", "idempotency_key"],
  properties: {
    schema_version: { type: "integer", enum: [1] }, finding_id: Uuid, finding_artifact_id: Uuid, finding_artifact_revision: { type: "integer", minimum: 1 }, finding_source_digest: FindingDigest,
    program_material_id: Uuid, program_id: { type: "string" }, program_version: { type: "string" }, program_source_sha256: Digest,
    target_id: { type: "string" }, target_reference: { type: "string" }, baseline: { type: "string" }, decision: { type: "string", enum: ["approve", "reject"] },
    rule_assessments: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["rule_id", "result", "evidence_refs"], properties: {
      rule_id: { type: "string" }, result: { type: "string", enum: ["satisfied", "violated", "unknown"] }, evidence_refs: { type: "array", items: Uuid },
    } } }, evidence_refs: { type: "array", minItems: 1, items: Uuid }, reason: { type: "string" }, idempotency_key: Uuid,
  },
};
const Reviewer = {
  type: "object", additionalProperties: false, required: ["actor_type", "actor_id", "actor_name", "permission"],
  properties: {
    actor_type: { type: "string", enum: ["bootstrap_admin", "api_token", "user"] }, actor_id: { type: "string" }, actor_name: { type: "string" },
    role: { type: "string", enum: ["admin", "operator"] }, permission: { type: "string", enum: ["admin", "findings:write"] },
  },
};
const EvidenceBinding = {
  type: "object", additionalProperties: false, required: ["ref", "kind", "artifact_id", "artifact_revision", "fingerprint"],
  properties: { ref: Uuid, kind: { type: "string", enum: ["fact", "artifact_evidence"] }, artifact_id: Uuid, artifact_revision: { type: "integer", minimum: 1 }, fingerprint: Digest },
};
const TechnicalBinding = {
  type: "object", additionalProperties: false, required: ["finding_id", "artifact_id", "artifact_revision", "source_digest", "target_reference", "baseline", "verification_round_id", "verification_attempt", "confirmation_digest"],
  properties: { finding_id: Uuid, artifact_id: Uuid, artifact_revision: { type: "integer", minimum: 1 }, source_digest: FindingDigest,
    target_reference: { type: "string" }, baseline: { type: "string", nullable: true }, verification_round_id: Uuid,
    verification_attempt: { type: "integer", minimum: 1 }, confirmation_digest: Digest },
};
const MaterialBinding = {
  type: "object", additionalProperties: false, required: ["material_id", "scope", "program_id", "version", "source_sha256", "target_id", "target_reference", "baseline"],
  properties: { material_id: Uuid, scope: MaterialScope, program_id: { type: "string" }, version: { type: "string" }, source_sha256: Digest, target_id: { type: "string" }, target_reference: { type: "string" }, baseline: { type: "string" } },
};
const MaterialView = {
  type: "object", additionalProperties: false,
  required: ["schema_version", "material_id", "request", "registered_at", "registered_by", "registration_digest", "status", "superseded_by", "revoked_at"],
  properties: {
    schema_version: { type: "integer", enum: [1] }, material_id: Uuid, request: { $ref: "#/components/schemas/ProgramMaterialRegistration" },
    registered_at: { type: "string", format: "date-time" }, registered_by: { type: "object", additionalProperties: false, required: ["actor_type", "actor_id", "actor_name", "permission"], properties: {
      actor_type: { type: "string", enum: ["bootstrap_admin", "api_token", "user"] }, actor_id: { type: "string" }, actor_name: { type: "string" }, permission: { type: "string", enum: ["admin", "projects:write"] },
    } }, registration_digest: Digest, status: { type: "string", enum: ["active", "revoked", "superseded"] }, superseded_by: { ...Uuid, nullable: true }, revoked_at: { type: "string", format: "date-time", nullable: true },
  },
};
const ReviewRecord = {
  type: "object", additionalProperties: false,
  required: ["schema_version", "review_id", "request", "reviewer", "reviewed_at", "status", "reason_codes", "technical_binding", "material_binding", "evidence_bindings", "evidence_digest", "request_digest"],
  properties: {
    schema_version: { type: "integer", enum: [1] }, review_id: Uuid, request: { $ref: "#/components/schemas/ProgramEligibilityReview" }, reviewer: Reviewer,
    reviewed_at: { type: "string", format: "date-time" }, status: { type: "string", enum: ["eligible", "ineligible", "blocked"] }, reason_codes: { type: "array", items: { type: "string" } },
    technical_binding: { ...TechnicalBinding, nullable: true }, material_binding: { ...MaterialBinding, nullable: true }, evidence_bindings: { type: "array", items: EvidenceBinding }, evidence_digest: { ...Digest, nullable: true }, request_digest: Digest,
  },
};
const MaterialResult = { type: "object", additionalProperties: false, required: ["material", "duplicate"], properties: { material: MaterialView, duplicate: { type: "boolean" } } };
const ReviewResult = { type: "object", additionalProperties: false, required: ["record", "duplicate"], properties: { record: ReviewRecord, duplicate: { type: "boolean" } } };
const EligibilityHistoryDetail = {
  type: "object", additionalProperties: false, required: ["schema_version", "finding_id", "projection", "reviews", "material", "invalid_history_count", "history_incomplete"], properties: {
    schema_version: { type: "integer", enum: [1] }, finding_id: Uuid, projection: { $ref: "#/components/schemas/ProgramEligibilityProjection" }, reviews: { type: "array", items: ReviewRecord }, material: { ...MaterialView, nullable: true },
    invalid_history_count: { type: "integer", minimum: 0 }, history_incomplete: { type: "boolean" },
  },
};
const EligibilityDetail = {
  type: "object", additionalProperties: false,
  required: ["schema_version", "status", "finding_id", "technical_status", "current_review_id", "current_material_id", "gaps", "historical_review_ids", "reviews", "material", "invalid_history_count", "history_incomplete"],
  properties: {
    schema_version: { type: "integer", enum: [1] }, status: { type: "string", enum: ["not_assessed", "eligible", "ineligible", "blocked"] }, finding_id: Uuid,
    technical_status: { type: "string" }, current_review_id: { ...Uuid, nullable: true }, current_material_id: { ...Uuid, nullable: true },
    gaps: { type: "array", items: { type: "string" } }, historical_review_ids: { type: "array", items: Uuid },
    reviews: { type: "array", items: ReviewRecord }, material: { ...MaterialView, nullable: true },
    invalid_history_count: { type: "integer", minimum: 0 }, history_incomplete: { type: "boolean" },
  },
};

export const PROGRAM_ELIGIBILITY_SCHEMAS: Record<string, unknown> = {
  ProgramMaterialRegistration: MaterialRegistration,
  ProgramMaterialView: MaterialView,
  ProgramMaterialRevoke: { type: "object", additionalProperties: false, required: ["schema_version", "reason", "idempotency_key"], properties: { schema_version: { type: "integer", enum: [1] }, reason: { type: "string" }, idempotency_key: Uuid } },
  ProgramEligibilityReview: Review,
  ProgramEligibilityReviewRecord: ReviewRecord,
  ProgramMaterialResult: MaterialResult,
  ProgramEligibilityReviewResult: ReviewResult,
  ProgramEligibilityHistoryDetail: EligibilityHistoryDetail,
  ProgramEligibilityDetail: EligibilityDetail,
  ProgramEligibilityProjection: { type: "object", additionalProperties: false, required: ["status", "finding_id", "technical_status", "current_review_id", "current_material_id", "gaps", "historical_review_ids"], properties: {
    status: { type: "string", enum: ["not_assessed", "eligible", "ineligible", "blocked"] }, finding_id: Uuid, technical_status: { type: "string" }, current_review_id: { ...Uuid, nullable: true }, current_material_id: { ...Uuid, nullable: true }, gaps: { type: "array", items: { type: "string" } }, historical_review_ids: { type: "array", items: Uuid },
  } },
};

export const PROGRAM_ELIGIBILITY_OPERATIONS: Op[] = [
  { method: "get", path: "/program-materials", summary: "查询可信程序材料", description: "只返回由管理面登记的可信程序规则材料；任务契约中的 operator_supplied 规则不自动进入此目录。include_history=true 可查看已撤销或被替代的历史材料。历史读取截断或超出字节预算时 history_incomplete=true，当前资格必须保持 blocked。", scope: "projects:read", tags: ["Program Eligibility"], query: { project_id: Uuid, include_history: { type: "boolean" } }, responses: { "200": { type: "object", required: ["schema_version", "items", "invalid_history_count", "history_incomplete"], properties: { schema_version: { type: "integer", enum: [1] }, items: { type: "array", items: { $ref: "#/components/schemas/ProgramMaterialView" } }, invalid_history_count: { type: "integer" }, history_incomplete: { type: "boolean" } } } } },
  { method: "get", path: "/program-materials/{id}", summary: "查询单个可信程序材料", scope: "projects:read", tags: ["Program Eligibility"], responses: { "200": { type: "object", required: ["schema_version", "material", "invalid_history_count", "history_incomplete"], properties: { schema_version: { type: "integer", enum: [1] }, material: { $ref: "#/components/schemas/ProgramMaterialView" }, invalid_history_count: { type: "integer" }, history_incomplete: { type: "boolean" } } } } },
  { method: "post", path: "/program-materials", summary: "登记可信程序材料", description: "显式管理面准入；服务端从 req.actor 冻结登记者与权限，不接受 Agent 或请求体自报信任身份。", scope: "projects:write", tags: ["Program Eligibility"], body: MaterialRegistration, successStatus: "201", responses: { "201": MaterialResult, "200": MaterialResult, "409": { type: "object" }, "503": { type: "object" } } },
  { method: "post", path: "/program-materials/{id}/revoke", summary: "撤销可信程序材料", description: "撤销是 append-only 事件；历史评审仍可查询，但不再贡献当前资格。", scope: "projects:write", tags: ["Program Eligibility"], body: { $ref: "#/components/schemas/ProgramMaterialRevoke" }, successStatus: "201", responses: { "201": MaterialResult, "200": MaterialResult } },
  { method: "post", path: "/findings/{id}/program-eligibility/reviews", summary: "提交 Finding 程序资格评审", description: "评审必须绑定当前 Finding Artifact revision/source digest、当前 Verify confirmed round、可信材料 version/hash/target、可重读证据、理由与 actor 权限。没有当前证据、程序排除、版本或目标不符时 fail closed。Agent/internal actor 不能批准。", scope: "findings:write", tags: ["Program Eligibility"], body: Review, successStatus: "201", responses: { "201": ReviewResult, "200": ReviewResult, "409": { type: "object" } } },
  { method: "get", path: "/findings/{id}/program-eligibility/reviews", summary: "查询 Finding 的历史资格评审", description: "返回 append-only 历史评审与当前投影；失效记录不被删除。", scope: "findings:read", tags: ["Program Eligibility"], responses: { "200": { $ref: "#/components/schemas/ProgramEligibilityHistoryDetail" } } },
  { method: "get", path: "/findings/{id}/program-eligibility", summary: "查询 Finding 当前程序资格", description: "eligible 只表示当前绑定仍有效的独立资格评审；technical_status=confirmed 仍是独立技术状态，不能反向推导资格。", scope: "findings:read", tags: ["Program Eligibility"], responses: { "200": EligibilityDetail } },
];

export const PROGRAM_ELIGIBILITY_OPENAPI_SCHEMAS = PROGRAM_ELIGIBILITY_SCHEMAS;
