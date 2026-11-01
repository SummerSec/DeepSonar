import { z } from "zod";
import {
  QualityProtocolBodySchema, QualityDatasetBodySchema, QualityDigestSchema,
  QualityRunBindingSchema, QualityTimestampSchema, QualityUuidSchema,
  QUALITY_INPUT_BYTES, QUALITY_TRACE_LIMIT,
} from "./quality-contract.js";
import {
  FindingQualityVersionSchema, FindingQualityReviewSchema, FindingQualityRevokeSchema,
} from "./quality-api.js";

type Schema = Record<string, unknown>;
const json = (schema: z.ZodType): Schema => z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: "object", additionalProperties: false, required, properties });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const list = (items: Schema, maxItems = QUALITY_TRACE_LIMIT): Schema => ({ type: "array", items, maxItems });
const uuid = json(QualityUuidSchema), optionalUuid = json(QualityUuidSchema.nullable());
const digest = json(QualityDigestSchema), timestamp = json(QualityTimestampSchema);
const text = { type: "string", minLength: 1, maxLength: 200 };
const version = { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "Canonical signed-bigint-range CAS version; never a JSON number." };
const unknownStatus = { quality_status: { type: "string", enum: ["not_evaluated"] }, blockers: list(text) };
const actor = { actor_type: { type: "string", enum: ["bootstrap_admin", "api_token", "user", "internal"] },
  actor_id: { ...text, nullable: true }, actor_name: text };
const common = { protocol_digest: digest, scope_digest: digest };
const pointers = Object.fromEntries(["freeze_record_id", "declaration_record_id", "first_access_record_id",
  "dataset_record_id", "evaluation_record_id", "review_record_id", "revocation_record_id"].map(name => [name, optionalUuid]));
const Head = object({ project_id: uuid, protocol_id: uuid, version,
  phase: { type: "string", enum: ["registered", "frozen", "admitted", "evaluated", "reviewed", "revoked", "blocked"] },
  latest_record_id: uuid, ...pointers, updated_at: timestamp });
const Protocol = object({ id: uuid, project_id: uuid, protocol_digest: digest,
  body_json: json(QualityProtocolBodySchema), created_at: timestamp,
  created_by_actor_type: actor.actor_type, created_by_actor_id: actor.actor_id, created_by_actor_name: actor.actor_name });
const Receipt = object({ id: uuid, project_id: uuid, protocol_id: uuid,
  kind: { type: "string", enum: ["freeze", "dataset_declaration", "dataset_admission", "review", "revoke"] },
  record_digest: digest, subject_record_id: optionalUuid, request_key: { ...text, nullable: true }, ...actor,
  body_json: { oneOf: [object({ ...common, thresholds_digest: digest }), object({ ...common, dataset_digest: digest }),
    object({ ...common, run_id: uuid, dataset_id: uuid, report_digest: digest,
      evidence_digest: json(QualityDigestSchema.nullable()), expires_at: timestamp }), object({ ...common, reason: text })] },
  created_at: timestamp });
// Alias closures remain bounded by the checked SQL history byte envelope, not sample-size quotas.
const History = object({ exposure_status: { type: "string", enum: ["unknown", "observed", "none_observed_in_supplied_history"] },
  first_holdout_access_record_id: optionalUuid, first_holdout_access_at: json(QualityTimestampSchema.nullable()),
  first_holdout_access_record_ids: list(uuid), corpus_digests: list(digest, QUALITY_INPUT_BYTES),
  history_errors: list(text, 2 * QUALITY_TRACE_LIMIT + 1) });
const Chain = object({ integrity_status: { type: "string", enum: ["structurally_valid"] },
  quality_status: unknownStatus.quality_status, protocol_id: uuid, protocol_digest: digest, scope_digest: digest,
  review_id: uuid, review_record_digest: digest, run_id: uuid, dataset_id: uuid, report_digest: digest,
  history: History, reviewer_principal_ids: list(text, QUALITY_INPUT_BYTES),
  forbidden_principal_ids: list(text, QUALITY_INPUT_BYTES), external_prerequisites: list(text) });
const Transition = object({ record: Receipt, head: Head, ...unknownStatus, run_id: uuid, chain: Chain },
  ["record", "head", "quality_status", "blockers"]);
const Work = { ...object({ status: { type: "string", enum: ["pending", "running", "completed", "failed"] },
  generation: version, processed_generation: version, evaluation_record_id: optionalUuid,
  last_error_code: { ...text, nullable: true } }), nullable: true };
const ratio = object({ numerator: { type: "integer", minimum: 0 }, denominator: { type: "integer", minimum: 0 },
  value: { type: "number", minimum: 0, maximum: 1, nullable: true } });
const classMetrics = object({ true_positive: { type: "integer", minimum: 0 },
  false_positive: { type: "integer", minimum: 0 }, false_negative: { type: "integer", minimum: 0 },
  precision: ratio, recall: ratio });
const counts = Object.fromEntries(["labeled_pairs", "known_labeled_pairs", "unknown_labeled_pairs",
  "unknown_selected_pairs", "selected_pairs", "compared_pairs", "missing_subject_traces", "missing_decisions",
  "not_selected_positive", "not_compared_positive", "predicted_insufficient", "truncated_subjects",
  "observed_rows_including_sentinels"].map(name => [name, { type: "integer", minimum: 0 }]));
const SafeReport = object({ schema_version: { type: "integer", enum: [1] }, binding: json(QualityRunBindingSchema),
  dataset_kind: { type: "string", enum: ["synthetic", "human_labeled"] }, input_digest: digest,
  observations_digest: digest, report_digest: digest,
  per_class: object({ same_problem: classMetrics, same_root_cause_different_instance: classMetrics }),
  candidate_recall: ratio, ...counts, blockers: list(text) });
const assetsProperties = Object.fromEntries(["code_digest", "config_digest", "selector_digest", "normalization_digest",
  "strong_rule_digest"].map(name => [name, digest]));
const assetVersions = Object.fromEntries(["extractor_version", "normalization_version", "strong_rule_version",
  "metric_version", "population_version", "label_mapping_version"].map(name => [name, text]));
const moduleDigests = Object.fromEntries(["contract", "metrics", "identity", "identity_sources", "identity_mappings",
  "selector", "assets", "store", "ledger", "state", "worker", "api", "relation_read", "relation_computation"].map(name => [name, digest]));
const Assets = object({ ...assetsProperties, ...assetVersions,
  integrity_basis: { type: "string", enum: ["node_sync_load_returned_source_under_trusted_preload"] },
  module_digests: object(moduleDigests) });
const Error = object({ error: text, error_code: text, ...unknownStatus }, ["error"]);
const response = (schema: Schema, description = "Engineering metadata only; never a quality certificate.") =>
  ({ description, content: { "application/json": { schema } } });
const errors = Object.fromEntries(["400", "401", "403", "404", "409", "413", "500", "503"].map(code =>
  [code, response(Error, "Fail closed; linked upload rejection is recorded only after this request committed exposure.")]));

export const FINDING_QUALITY_SCHEMAS: Record<string, Schema> = {
  FindingQualityProtocol: json(QualityProtocolBodySchema), FindingQualityDataset: json(QualityDatasetBodySchema),
  FindingQualityVersion: json(FindingQualityVersionSchema), FindingQualityReview: json(FindingQualityReviewSchema),
  FindingQualityRevoke: json(FindingQualityRevokeSchema), FindingQualitySafeReport: SafeReport,
  FindingQualityHead: Head, FindingQualityHistory: History,
};
const base = "/projects/{id}/finding-quality", protocol = base + "/protocols/{protocolId}";
const authority = " Requires a stored user session, admin scope, admin/operator role and same-project authority. API/service, Job/internal and bootstrap principals are denied. No query parameters; metadata responses are no-store. Distinct accounts/digests do not authenticate independent natural humans. No certificate/current-promotion/publication operation is exposed.";
type Operation = { method: "get" | "post"; path: string; summary: string; description: string;
  scope: "admin"; tags: string[]; body?: Schema; headers?: Record<string, Schema>; responses: Record<string, Schema> };
function operation(method: Operation["method"], path: string, summary: string, description: string,
  success: Schema, body?: Schema): Operation {
  return { method, path, summary, description: description + authority, scope: "admin", tags: ["Finding Quality"],
    ...(body ? { body } : {}), responses: { ...errors, "200": response(success) } };
}
export const FINDING_QUALITY_OPERATIONS: Operation[] = [
  operation("get", base + "/assets", "读取当前已装载质量资产摘要",
    "Captures evaluator-input bytes under the trusted Node preload; not signed deployment or proof of successful human evaluation.",
    object({ assets: Assets, ...unknownStatus })),
  operation("post", base + "/protocols", "登记质量协议元数据",
    "Registers loaded scope/digests/threshold metadata before raw holdout access; exact replay does not reset history.",
    object({ protocol: Protocol, ...unknownStatus }), ref("FindingQualityProtocol")),
  operation("get", protocol, "读取质量协议与终身暴露状态",
    "Returns protocol metadata, head, bounded work summary and lifetime corpus history; never raw labels or observations.",
    object({ protocol: Protocol, head: Head, work: Work, history: History, ...unknownStatus })),
  operation("get", protocol + "/report", "重构当前不可变观察批次的脱敏指标",
    "Revalidates admitted sources, actual stored worker generation/cohort and report digest in read-only repeatable-read SQL. MVCC proves this snapshot, not future currentness. Raw report.input/labels/selector traces are omitted.",
    object({ generation: version, source_validation: { type: "string", enum: ["repeatable_read_mvcc_snapshot"] },
      report: ref("FindingQualitySafeReport"), ...unknownStatus })),
  operation("post", protocol + "/freeze", "在留出暴露前冻结协议",
    "Exact bigint CAS; any lifetime exposure or incomplete history prevents a new freeze for the same sealed corpus.",
    Transition, ref("FindingQualityVersion")),
  operation("post", protocol + "/declarations", "登记留出数据声明",
    "Digest-only declaration descends from the frozen protocol; this is not raw holdout admission or external truth.",
    Transition, ref("FindingQualityVersion")),
  { ...operation("post", protocol + "/declarations/{declarationId}/payload", "提交受治理留出数据包",
    "A separate durable exposure transaction commits in preParsing before media/JSON/size/schema validation. Failed admission rolls back dataset/work but retains exposure plus linked rejection. Every reused Idempotency-Key conflicts before consuming bytes. Body byte/count budgets are the shared contract; Scheduler alone executes finite observations.",
    Transition, ref("FindingQualityDataset")), headers: { "Idempotency-Key": text } },
  operation("post", protocol + "/reviews", "记录独立主体的工程评审候选",
    "Reconstructs the real completed cohort under repeatable-read; fabricated digest-shaped evaluations cannot be reviewed. Known maker/tuner/registrar/custodian and resolved alias conflicts roll back the candidate. Human independence and external evidence remain unverified.",
    Transition, ref("FindingQualityReview")),
  operation("post", protocol + "/revoke", "撤销协议并保留全部历史",
    "Exact bigint CAS; stops this protocol's pending work and clears only its own current tuple. Does not reset first access, immutable history, observations or another protocol's certificate.",
    Transition, ref("FindingQualityRevoke")),
];
