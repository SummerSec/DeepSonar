import { randomUUID } from "node:crypto";
import type { Actor } from "../../auth.js";
import { sql } from "../../db.js";
import {
  ProgramEligibilityReviewRecord,
  ProgramMaterialRevokeRequest,
  normalizeCandidateOutcomeClaim,
} from "@deepsonar/shared-types";
import type {
  ProgramMaterialRegistrationRequest,
} from "@deepsonar/shared-types";
import { frozenTaskContract } from "../../task-contract-preflight.js";
import { taskContractDigest } from "../../task-outcome-snapshot.js";
import {
  PROGRAM_ELIGIBILITY_ACTIONS,
  actorId,
  assessProgramRules,
  canRegisterMaterial,
  canReviewEligibility,
  findingTargetMatches,
  jsonDigest,
  materialBinding,
  materialRequestDigest,
  materialStatus,
  normalizeMaterial,
  normalizeReview,
  projectProgramEligibility,
  requestDigest,
  reviewerFromActor,
  type CurrentEvidenceBinding,
  type CurrentFindingBinding,
  type EligibilityProjection,
  type EligibilityProjectionInput,
  type ProgramMaterialStatus,
  type ProgramMaterialView,
  type StoredProgramMaterial,
} from "./model.js";

type Db = typeof sql;
type JsonRecord = Record<string, unknown>;
const MATERIAL_LIFECYCLE_LOCK = "program-material:lifecycle";
const MAX_MATERIAL_AUDIT_ROWS = 1_000;
const MAX_MATERIAL_AUDIT_BYTES = 4 * 1024 * 1024;
const MAX_MATERIAL_EVENT_BYTES = 64 * 1024;
const MAX_REVIEW_AUDIT_ROWS = 100;
const MAX_REVIEW_AUDIT_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_EVENT_BYTES = 64 * 1024;
const MAX_PROJECTION_FINDINGS = 100;

export class ProgramEligibilityStoreError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
    this.name = "ProgramEligibilityStoreError";
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.includes("T") && !Number.isNaN(Date.parse(value));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function collectActorRefs(value: unknown): string[] {
  const refs: string[] = [];
  const visit = (item: unknown, depth: number): void => {
    if (depth > 2 || !item || typeof item !== "object" || Array.isArray(item)) return;
    const object = item as Record<string, unknown>;
    for (const key of ["actor_id", "creator_id", "created_by", "owner_actor_id", "maker_actor_id", "submitted_by", "author_id"]) {
      if (typeof object[key] === "string" && object[key].trim()) refs.push(object[key].trim());
    }
    for (const key of ["actor", "creator", "owner", "maker", "author"]) visit(object[key], depth + 1);
  };
  visit(value, 0);
  return [...new Set(refs)];
}

function actorMatchesMaker(actor: Actor, finding: CurrentFindingBinding): boolean {
  const actorRefs = [actor.id, actor.name, actorId(actor)].filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.toLowerCase());
  const makerRefs = [finding.source_job_id, `job:${finding.source_job_id}`, ...(finding.source_maker_actor_ids ?? [])]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.toLowerCase());
  return actorRefs.some((item) => makerRefs.includes(item));
}

function auditActor(actor: Actor, permission: "admin" | "projects:write" | "findings:write") {
  if (actor.type === "internal") throw new ProgramEligibilityStoreError("ELIGIBILITY_AGENT_ACTOR_FORBIDDEN", "Agent/internal actors cannot create trusted eligibility records", 403);
  return { actor_type: actor.type, actor_id: actorId(actor), actor_name: actor.name, permission };
}

function parseMaterial(after: unknown): StoredProgramMaterial | null {
  const value = record(after);
  const request = value.request;
  const registeredBy = record(value.registered_by);
  if (!isUuid(value.material_id) || !isTimestamp(value.registered_at) || !isDigest(value.registration_digest)) return null;
  if (!(["bootstrap_admin", "api_token", "user"] as string[]).includes(String(registeredBy.actor_type))
    || typeof registeredBy.actor_id !== "string" || typeof registeredBy.actor_name !== "string"
    || !(["admin", "projects:write"] as string[]).includes(String(registeredBy.permission))) return null;
  try {
    const normalized = normalizeMaterial(request);
    if (materialRequestDigest(normalized) !== value.registration_digest) return null;
    return {
      schema_version: 1,
      material_id: value.material_id,
      request: normalized,
      registered_at: value.registered_at,
      registered_by: registeredBy as StoredProgramMaterial["registered_by"],
      registration_digest: value.registration_digest,
    };
  } catch {
    return null;
  }
}

interface MaterialAuditEvent {
  action: string;
  resourceId: string | null;
  after: JsonRecord;
  at: string;
}

interface MaterialAuditRead {
  events: MaterialAuditEvent[];
  incomplete: boolean;
}

async function materialAuditRows(db: Db, scopeProjectId: string | null | undefined): Promise<MaterialAuditRead> {
  const rows = await db`
    SELECT action, resource_id,
           CASE WHEN octet_length(COALESCE(after_json::text, '')) <= ${MAX_MATERIAL_EVENT_BYTES}
                THEN after_json ELSE NULL END AS after_json,
           octet_length(COALESCE(after_json::text, '')) AS payload_bytes, at
    FROM audit_logs
    WHERE action = ANY(${[PROGRAM_ELIGIBILITY_ACTIONS.materialRegister, PROGRAM_ELIGIBILITY_ACTIONS.materialRevoke, PROGRAM_ELIGIBILITY_ACTIONS.materialSupersede]})
      AND result = 'ok'
      AND (
        ${scopeProjectId === undefined}
        OR (${scopeProjectId === null} AND project_id IS NULL)
        OR (${scopeProjectId !== null && scopeProjectId !== undefined} AND (project_id IS NULL OR project_id = ${scopeProjectId ?? null}))
      )
    ORDER BY id ASC
    LIMIT ${MAX_MATERIAL_AUDIT_ROWS + 1}`;
  let incomplete = rows.length > MAX_MATERIAL_AUDIT_ROWS;
  let bytes = 0;
  const events: MaterialAuditEvent[] = [];
  for (const row of rows.slice(0, MAX_MATERIAL_AUDIT_ROWS)) {
    const payloadBytes = Number(row.payload_bytes ?? 0);
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > MAX_MATERIAL_EVENT_BYTES || row.after_json === null) {
      incomplete = true;
      continue;
    }
    bytes += payloadBytes;
    if (bytes > MAX_MATERIAL_AUDIT_BYTES) {
      incomplete = true;
      break;
    }
    const eventDate = new Date(String(row.at));
    if (Number.isNaN(eventDate.getTime())) {
      incomplete = true;
      continue;
    }
    events.push({ action: String(row.action), resourceId: text(row.resource_id), after: record(row.after_json), at: eventDate.toISOString() });
  }
  return { events, incomplete };
}

function materialViews(events: readonly MaterialAuditEvent[]): { materials: ProgramMaterialView[]; invalid: number } {
  const registrations = new Map<string, StoredProgramMaterial>();
  const registrationOrder = new Map<string, number>();
  const validEvents: MaterialAuditEvent[] = [];
  let invalid = 0;
  const state = new Map<string, ProgramMaterialStatus>();
  for (const [index, event] of events.entries()) {
    if (event.action === PROGRAM_ELIGIBILITY_ACTIONS.materialRegister) {
      const material = parseMaterial(event.after);
      if (!material || event.resourceId !== material.material_id || registrations.has(material.material_id)) {
        invalid++;
        continue;
      }
      registrations.set(material.material_id, material);
      registrationOrder.set(material.material_id, index);
      state.set(material.material_id, "active");
      validEvents.push(event);
      continue;
    }
    if (event.action !== PROGRAM_ELIGIBILITY_ACTIONS.materialRevoke && event.action !== PROGRAM_ELIGIBILITY_ACTIONS.materialSupersede) continue;
    const after = event.after;
    const materialId = text(after.material_id);
    const current = materialId ? registrations.get(materialId) : undefined;
    const validBase = Boolean(materialId && isUuid(materialId) && event.resourceId === materialId && current
      && state.get(materialId) === "active");
    if (!validBase) {
      invalid++;
      continue;
    }
    if (event.action === PROGRAM_ELIGIBILITY_ACTIONS.materialRevoke) {
      if (!isTimestamp(after.revoked_at) || !isUuid(after.idempotency_key) || !isDigest(after.request_digest)
        || !text(after.reason)) {
        invalid++;
        continue;
      }
      state.set(materialId!, "revoked");
      validEvents.push(event);
      continue;
    }
    const replacementId = text(after.replacement_material_id);
    const replacement = replacementId ? registrations.get(replacementId) : undefined;
    const replacementOrder = replacementId ? registrationOrder.get(replacementId) : undefined;
    const transitionReason = text(after.reason);
    if (!replacement || !isUuid(replacementId) || replacementId === materialId || replacementOrder === undefined || replacementOrder > index
      || !isTimestamp(after.superseded_at) || !transitionReason
      || !["explicit_replacement", "newer_material_for_target"].includes(transitionReason)
      || replacement.request.program_id !== current!.request.program_id
      || !sameScope(current!, replacement.request)
      || (transitionReason !== "explicit_replacement" && !overlappingTarget(current!, replacement.request))) {
      invalid++;
      continue;
    }
    state.set(materialId!, "superseded");
    validEvents.push(event);
  }
  const materials = [...registrations.values()].map((material) => {
    const status = materialStatus(validEvents, material.material_id);
    return { ...material, status: status.status, superseded_by: status.supersededBy, revoked_at: status.revokedAt };
  });
  return { materials, invalid };
}

export async function loadProgramMaterials(db: Db, projectId?: string): Promise<{ materials: ProgramMaterialView[]; invalid: number; incomplete: boolean }> {
  const history = await materialAuditRows(db, projectId);
  const view = materialViews(history.events);
  return { materials: view.materials, invalid: view.invalid, incomplete: history.incomplete };
}

async function insertAudit(tx: Db, input: {
  actor: Actor;
  action: string;
  projectId: string | null;
  resourceType: string;
  resourceId: string;
  after: unknown;
}) {
  const actorValue = auditActor(input.actor, input.action === PROGRAM_ELIGIBILITY_ACTIONS.review ? "findings:write" : "projects:write");
  const [row] = await tx`
    INSERT INTO audit_logs (
      actor_type, actor_id, action, project_id, resource_type, resource_id,
      after_json, result
    ) VALUES (
      ${actorValue.actor_type}, ${actorValue.actor_id}, ${input.action}, ${input.projectId},
      ${input.resourceType}, ${input.resourceId}, ${tx.json(input.after as never)}, 'ok'
    )
    RETURNING id, at`;
  return { id: String(row.id), at: new Date(String(row.at)).toISOString() };
}

function scopeProjectId(request: ProgramMaterialRegistrationRequest): string | null {
  return request.scope.kind === "project" ? request.scope.project_id : null;
}

function sameScope(left: StoredProgramMaterial, request: ProgramMaterialRegistrationRequest): boolean {
  return left.request.scope.kind === request.scope.kind
    && (request.scope.kind === "platform" || (left.request.scope.kind === "project" && left.request.scope.project_id === request.scope.project_id));
}

function overlappingTarget(left: StoredProgramMaterial, request: ProgramMaterialRegistrationRequest): boolean {
  if (left.request.program_id !== request.program_id || !sameScope(left, request)) return false;
  const targets = new Set(request.targets.map((target) => `${target.type}:${target.reference}`));
  return left.request.targets.some((target) => targets.has(`${target.type}:${target.reference}`));
}

interface FindingTargetResolution {
  target_reference: string | null;
  baseline: string | null;
  reasons: string[];
  maker_actor_ids: string[];
}

/**
 * Resolve the Finding target only from Scheduler-owned admission and the
 * immutable source Job snapshot. A request body cannot introduce a target
 * that was not admitted for the frozen bounty contract.
 */
function resolveFindingTarget(row: Record<string, unknown>): FindingTargetResolution {
  const reasons: string[] = [];
  const sourceSnapshot = row.source_job_snapshot;
  const makerActorIds = [...new Set([
    ...stringArray(row.source_maker_actor_ids),
    ...collectActorRefs(sourceSnapshot),
    ...collectActorRefs(row.source_job_payload),
  ])];
  let targetReference: string | null = null;
  let baseline: string | null = null;
  let contract: ReturnType<typeof frozenTaskContract>;
  try {
    contract = frozenTaskContract(sourceSnapshot);
  } catch {
    contract = undefined;
  }
  if (!contract) {
    reasons.push("finding_task_contract_missing_or_invalid");
    return { target_reference: null, baseline: null, reasons, maker_actor_ids: makerActorIds };
  }

  const digest = taskContractDigest(contract);
  const artifactAdmission = record(record(row.artifact_extensions_json).task_outcome_admission);
  const findingAdmission = record(record(row.finding_raw_json).task_outcome_admission);
  let claim: ReturnType<typeof normalizeCandidateOutcomeClaim> | null = null;
  try {
    if (artifactAdmission.status !== "admitted_for_research"
      || artifactAdmission.assessment_basis !== "structured_goal_relevance_only"
      || artifactAdmission.submission_eligibility !== "not_assessed"
      || artifactAdmission.task_contract_sha256 !== digest) throw new Error("host admission metadata mismatch");
    const artifactClaim = normalizeCandidateOutcomeClaim(artifactAdmission.claim);
    const findingClaim = normalizeCandidateOutcomeClaim(findingAdmission.claim);
    if (artifactClaim.task_contract_sha256 !== digest || !sameJson(artifactClaim, findingClaim)) throw new Error("host admission claim mismatch");
    claim = artifactClaim;
  } catch {
    reasons.push("finding_task_outcome_admission_invalid");
  }

  const outcome = contract.outcome;
  if (outcome?.mode !== "bounty_submission") reasons.push("finding_program_mode_not_bounty_submission");
  if (outcome?.mode !== "bounty_submission" || outcome.rules_status !== "supplied" || !outcome.rule_snapshot) {
    reasons.push("finding_program_rules_unavailable");
  }
  if (claim) {
    targetReference = claim.target;
    baseline = claim.baseline ?? null;
    if (!contract.targets.includes(claim.target)) reasons.push("finding_target_not_in_frozen_contract");
    if (contract.baseline !== undefined && claim.baseline !== contract.baseline) reasons.push("finding_baseline_mismatch");
    const ruleTarget = outcome?.mode === "bounty_submission" && outcome.rules_status === "supplied" && outcome.rule_snapshot
      ? outcome.rule_snapshot.targets.find((target) => target.reference === claim!.target)
      : undefined;
    if (!ruleTarget) reasons.push("finding_target_not_in_frozen_program_rules");
    else if (!claim.baseline || claim.baseline !== ruleTarget.baseline) reasons.push("finding_baseline_mismatch");
  }
  if (!targetReference || !baseline) reasons.push("finding_target_binding_unavailable");
  return { target_reference: targetReference, baseline, reasons: [...new Set(reasons)], maker_actor_ids: makerActorIds };
}

export async function registerProgramMaterial(db: Db, actor: Actor, raw: unknown): Promise<{
  material: ProgramMaterialView;
  duplicate: boolean;
}> {
  const request = normalizeMaterial(raw);
  if (!canRegisterMaterial(actor, request.scope)) {
    throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_PERMISSION_REQUIRED", "operator is not authorized for this material scope", 403);
  }
  const digest = materialRequestDigest(request);
  const result = await db.begin(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"program-material:" + request.idempotency_key}))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MATERIAL_LIFECYCLE_LOCK}))`;
    const [existing] = await tx`
      SELECT after_json FROM audit_logs
      WHERE action=${PROGRAM_ELIGIBILITY_ACTIONS.materialRegister} AND result='ok'
        AND after_json->'request'->>'idempotency_key'=${request.idempotency_key}`;
    if (existing) {
      const material = parseMaterial(existing.after_json);
      if (!material || material.registration_digest !== digest) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_IDEMPOTENCY_CONFLICT", "Material idempotency key was already used for different content");
      const materialHistory = await materialAuditRows(tx, request.scope.kind === "platform" ? null : request.scope.project_id);
      const views = materialViews(materialHistory.events);
      if (materialHistory.incomplete || views.invalid) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_HISTORY_INVALID", "Stored material history is incomplete or invalid");
      const view = views.materials.find((item) => item.material_id === material.material_id);
      if (!view) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_HISTORY_INVALID", "Stored material history is invalid");
      return { material: view, duplicate: true };
    }

    const scopeId = scopeProjectId(request);
    const materialHistory = await materialAuditRows(tx, scopeId);
    const history = materialViews(materialHistory.events);
    if (materialHistory.incomplete || history.invalid) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_HISTORY_INVALID", "Trusted material history is incomplete or invalid; refusing new admission", 503);
    const explicit = request.supersedes_material_id
      ? history.materials.find((item) => item.material_id === request.supersedes_material_id)
      : undefined;
    if (request.supersedes_material_id && (!explicit || explicit.status !== "active" || !sameScope(explicit, request) || explicit.request.program_id !== request.program_id)) {
      throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_SUPERSEDE_INVALID", "Only an active material in the same program and scope can be superseded");
    }
    const toSupersede = history.materials.filter((item) => item.status === "active" && overlappingTarget(item, request)
      && item.material_id !== request.supersedes_material_id);
    if (explicit && !toSupersede.some((item) => item.material_id === explicit.material_id)) toSupersede.push(explicit);
    const materialId = randomUUID();
    const registeredAt = new Date().toISOString();
    const materialRecord: StoredProgramMaterial = {
      schema_version: 1,
      material_id: materialId,
      request,
      registered_at: registeredAt,
      registered_by: auditActor(actor, "projects:write") as StoredProgramMaterial["registered_by"],
      registration_digest: digest,
    };
    await insertAudit(tx, {
      actor, action: PROGRAM_ELIGIBILITY_ACTIONS.materialRegister, projectId: scopeId,
      resourceType: "program_material", resourceId: materialId,
      after: materialRecord,
    });
    for (const previous of toSupersede) {
      await insertAudit(tx, {
        actor, action: PROGRAM_ELIGIBILITY_ACTIONS.materialSupersede, projectId: scopeProjectId(previous.request),
        resourceType: "program_material", resourceId: previous.material_id,
        after: {
          schema_version: 1, material_id: previous.material_id, replacement_material_id: materialId,
          reason: request.supersedes_material_id === previous.material_id ? "explicit_replacement" : "newer_material_for_target",
          superseded_at: new Date().toISOString(),
        },
      });
    }
    return {
      duplicate: false,
      material: { ...materialRecord, status: "active" as const, superseded_by: null, revoked_at: null },
    };
  }) as unknown as { material: ProgramMaterialView; duplicate: boolean };
  return result;
}

export async function revokeProgramMaterial(db: Db, actor: Actor, materialId: string, raw: unknown): Promise<{
  material: ProgramMaterialView;
  duplicate: boolean;
}> {
  const request = ProgramMaterialRevokeRequest.parse(raw);
  const digest = jsonDigest(request);
  if (actor.type === "internal" || (!actor.scopes.includes("admin") && !actor.scopes.includes("projects:write"))) {
    throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_PERMISSION_REQUIRED", "operator is not authorized to revoke trusted program material", 403);
  }
  // SAFETY: postgres.js returns this callback's material result unchanged;
  // its transaction handle exposes the same tagged-query API used below.
  return db.begin(async (txRaw) => {
    // SAFETY: only tagged SQL calls are used on this transaction handle.
    const tx = txRaw as unknown as Db;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"program-material-revoke:" + materialId}))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MATERIAL_LIFECYCLE_LOCK}))`;
    const [existing] = await tx`
      SELECT after_json FROM audit_logs
      WHERE action=${PROGRAM_ELIGIBILITY_ACTIONS.materialRevoke} AND result='ok'
        AND after_json->>'idempotency_key'=${request.idempotency_key}
        AND resource_id=${materialId}`;
    if (existing) {
      if (record(existing.after_json).request_digest !== digest) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_IDEMPOTENCY_CONFLICT", "Material revoke idempotency key was already used for different content");
      const materialHistory = await materialAuditRows(tx, actor.projectId ?? undefined);
      const views = materialViews(materialHistory.events);
      const loaded = views.materials.find((item) => item.material_id === materialId);
      if (materialHistory.incomplete || views.invalid) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_HISTORY_INVALID", "Stored material history is incomplete or invalid; refusing idempotent revoke", 503);
      if (!loaded) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_HISTORY_INVALID", "Stored material history is invalid");
      if (!canRegisterMaterial(actor, loaded.request.scope)) {
        throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_PERMISSION_REQUIRED", "operator is not authorized for this material scope", 403);
      }
      return { material: loaded, duplicate: true };
    }
    const materialHistory = await materialAuditRows(tx, actor.projectId ?? undefined);
    const views = materialViews(materialHistory.events);
    if (materialHistory.incomplete || views.invalid) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_HISTORY_INVALID", "Trusted material history is incomplete or invalid; refusing revoke", 503);
    const material = views.materials.find((item) => item.material_id === materialId);
    if (!material) throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_NOT_FOUND", "Program material not found", 404);
    if (!canRegisterMaterial(actor, material.request.scope)) {
      throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_PERMISSION_REQUIRED", "operator is not authorized for this material scope", 403);
    }
    if (material.status !== "active") throw new ProgramEligibilityStoreError("PROGRAM_MATERIAL_NOT_CURRENT", "Only the current active material can be revoked");
    const revokedAt = new Date().toISOString();
    await insertAudit(tx, {
      actor, action: PROGRAM_ELIGIBILITY_ACTIONS.materialRevoke, projectId: scopeProjectId(material.request),
      resourceType: "program_material", resourceId: materialId,
      after: { schema_version: 1, material_id: materialId, reason: request.reason, idempotency_key: request.idempotency_key, request_digest: digest, revoked_at: revokedAt },
    });
    return {
      duplicate: false,
      material: { ...material, status: "revoked" as const, revoked_at: revokedAt },
    };
  }) as unknown as { material: ProgramMaterialView; duplicate: boolean };
}

export async function loadCurrentFindingBinding(db: Db, findingId: string): Promise<CurrentFindingBinding | null> {
  const [row] = await db`
    SELECT f.id AS finding_id, f.project_id, f.source_digest, f.verify_status, f.raw_json AS finding_raw_json,
           source_job.id AS source_job_id, source_job.status AS source_job_status, source_job.canvas_id,
           source_job.agent_snapshot_json AS source_job_snapshot, source_job.payload_json AS source_job_payload,
           source_attempt.id AS source_attempt_id, source_attempt.status AS source_attempt_status,
           source_latest.id AS source_latest_attempt_id,
           art.id AS artifact_id, art.revision AS artifact_revision, art.status AS artifact_status,
           art.superseded_at AS artifact_superseded_at, art.extensions_json AS artifact_extensions_json,
           vr.id AS verification_round_id, vr.attempt AS verification_attempt,
           vr.status AS verification_round_status, vr.final_outcome AS verification_round_outcome,
           verify_job.status AS verify_job_status, verify_attempt.id AS verify_attempt_id,
           verify_attempt.status AS verify_attempt_status, verify_latest.id AS verify_latest_attempt_id,
           EXISTS(SELECT 1 FROM job_attempt_effects fx WHERE fx.job_id=source_job.id AND fx.status IN ('unknown','effect_pending')) AS source_unsafe_effect,
           EXISTS(SELECT 1 FROM job_attempt_effects fx WHERE fx.job_id=verify_job.id AND fx.status IN ('unknown','effect_pending')) AS verify_unsafe_effect,
           vr.requirements_json, vr.evidence_snapshot_json,
           ARRAY(SELECT DISTINCT al.actor_id FROM audit_logs al
                 WHERE al.resource_type='job' AND al.resource_id=source_job.id::text
                   AND al.action='task.create' AND al.result='ok') AS source_maker_actor_ids
    FROM findings f
    JOIN jobs source_job ON source_job.id=f.job_id AND source_job.project_id=f.project_id
    LEFT JOIN artifacts art ON art.id=f.artifact_id AND art.project_id=f.project_id
      AND art.job_id=source_job.id AND art.canvas_id=source_job.canvas_id
    LEFT JOIN events source_event ON source_event.job_id=source_job.id AND source_event.event_id=art.source_event_id AND source_event.type='finding'
    LEFT JOIN job_attempts source_attempt ON source_attempt.id=source_event.attempt_id AND source_attempt.job_id=source_job.id
    LEFT JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=source_job.id ORDER BY attempt_no DESC LIMIT 1) source_latest ON true
    LEFT JOIN LATERAL (
      SELECT id, attempt, verify_job_id, status, final_outcome, requirements_json, evidence_snapshot_json
      FROM finding_verification_rounds WHERE finding_id=f.id ORDER BY attempt DESC, created_at DESC LIMIT 1
    ) vr ON true
    LEFT JOIN jobs verify_job ON verify_job.id=vr.verify_job_id
      AND verify_job.project_id=f.project_id AND verify_job.canvas_id=source_job.canvas_id
      AND verify_job.finding_id=f.id AND verify_job.type='verify_finding'
    LEFT JOIN LATERAL (SELECT id,status FROM job_attempts WHERE job_id=verify_job.id ORDER BY attempt_no DESC LIMIT 1) verify_attempt ON true
    LEFT JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=verify_job.id ORDER BY attempt_no DESC LIMIT 1) verify_latest ON true
    WHERE f.id=${findingId}`;
  if (!row) return null;
  const reasons: string[] = [];
  const artifactId = text(row.artifact_id);
  const sourceDigest = text(row.source_digest);
  if (!artifactId) reasons.push("finding_artifact_missing");
  if (row.artifact_status !== "submitted" || row.artifact_superseded_at !== null) reasons.push("finding_artifact_not_current");
  if (!sourceDigest || !/^v1:[a-f0-9]{64}$/.test(sourceDigest)) reasons.push("finding_source_digest_missing");
  if (row.source_job_status !== "succeeded") reasons.push("finding_source_job_not_succeeded");
  if (!row.source_attempt_id || row.source_attempt_status !== "succeeded" || row.source_latest_attempt_id !== row.source_attempt_id) reasons.push("finding_source_attempt_not_current");
  if (row.source_unsafe_effect) reasons.push("finding_source_effect_unknown");
  if (row.verify_status !== "confirmed") reasons.push("finding_verify_not_confirmed");
  if (!row.verification_round_id || row.verification_round_status !== "confirmed" || row.verification_round_outcome !== "confirmed") reasons.push("finding_confirmation_round_missing_or_stale");
  if (!row.verify_attempt_id || row.verify_job_status !== "succeeded" || row.verify_attempt_status !== "succeeded" || row.verify_latest_attempt_id !== row.verify_attempt_id) reasons.push("finding_confirmation_attempt_not_current");
  if (row.verify_unsafe_effect) reasons.push("finding_confirmation_effect_unknown");
  const target = resolveFindingTarget(row as Record<string, unknown>);
  reasons.push(...target.reasons);
  const technicalDigest = artifactId && sourceDigest && row.verification_round_id
    ? jsonDigest({ finding_id: String(row.finding_id), artifact_id: artifactId, artifact_revision: Number(row.artifact_revision), source_digest: sourceDigest,
      verification_round_id: String(row.verification_round_id), verification_attempt: Number(row.verification_attempt),
      source_attempt_id: text(row.source_attempt_id), verify_attempt_id: text(row.verify_attempt_id),
      requirements: jsonDigest(row.requirements_json), evidence_snapshot: jsonDigest(row.evidence_snapshot_json) }) : null;
  return {
    finding_id: String(row.finding_id), project_id: String(row.project_id), canvas_id: text(row.canvas_id), source_job_id: String(row.source_job_id),
    source_job_status: String(row.source_job_status), source_attempt_id: text(row.source_attempt_id), source_attempt_status: text(row.source_attempt_status),
    source_latest_attempt_id: text(row.source_latest_attempt_id), artifact_id: artifactId, artifact_revision: row.artifact_revision === null ? null : Number(row.artifact_revision),
    artifact_status: text(row.artifact_status), artifact_superseded_at: row.artifact_superseded_at === null ? null : String(row.artifact_superseded_at),
    source_digest: sourceDigest, target_reference: target.target_reference, baseline: target.baseline,
    source_maker_actor_ids: target.maker_actor_ids, verify_status: String(row.verify_status), verification_round_id: text(row.verification_round_id),
    verification_attempt: row.verification_attempt === null ? null : Number(row.verification_attempt), verification_round_status: text(row.verification_round_status),
    verification_round_outcome: text(row.verification_round_outcome), technical_confirmation_digest: technicalDigest, reasons: [...new Set(reasons)],
  };
}

async function loadEvidenceBindings(db: Db, finding: CurrentFindingBinding, refs: readonly string[]): Promise<{
  bindings: CurrentEvidenceBinding[];
  digest: string | null;
  reasons: string[];
}> {
  if (!refs.length || !finding.canvas_id) return { bindings: [], digest: null, reasons: ["eligibility_evidence_missing"] };
  const rows = await db`
    SELECT ref_id, kind, artifact_id, artifact_revision, artifact_status, artifact_superseded_at,
           source_operation, job_id, job_status, attempt_id, attempt_status, latest_attempt_id,
           unsafe_effect, node_verification_status, evidence_sha256, evidence_kind, evidence_polarity,
           evidence_statement, evidence_payload
    FROM (
      SELECT n.id::text AS ref_id, 'fact'::text AS kind, a.id::text AS artifact_id, a.revision AS artifact_revision,
             a.status AS artifact_status, a.superseded_at AS artifact_superseded_at, a.source_operation,
             j.id::text AS job_id, j.status AS job_status, ev.attempt_id::text AS attempt_id,
             attempt.status AS attempt_status, latest.id::text AS latest_attempt_id,
             EXISTS(SELECT 1 FROM job_attempt_effects fx WHERE fx.job_id=j.id AND fx.status IN ('unknown','effect_pending')) AS unsafe_effect,
             n.verification_status AS node_verification_status, NULL::text AS evidence_sha256,
             'fact'::text AS evidence_kind, NULL::text AS evidence_polarity,
             NULL::text AS evidence_statement, n.body_json AS evidence_payload
      FROM canvas_nodes n
      JOIN artifacts a ON a.id::text=n.body_json->>'artifact_id' AND a.node_id=n.id
      JOIN jobs j ON j.id=n.job_id AND j.project_id=${finding.project_id} AND j.canvas_id=${finding.canvas_id}
      LEFT JOIN events ev ON ev.job_id=j.id AND ev.event_id=a.source_event_id AND ev.type='fact'
      LEFT JOIN job_attempts attempt ON attempt.id=ev.attempt_id AND attempt.job_id=j.id
      LEFT JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
      WHERE n.id=ANY(${refs}::uuid[]) AND n.node_type='fact'
        AND (n.body_json #>> '{verification,finding_id}'=${finding.finding_id} OR n.body_json->>'finding_id'=${finding.finding_id})
      UNION ALL
      SELECT e.id::text AS ref_id, 'artifact_evidence'::text AS kind, a.id::text AS artifact_id, a.revision AS artifact_revision,
             a.status AS artifact_status, a.superseded_at AS artifact_superseded_at, a.source_operation,
             j.id::text AS job_id, j.status AS job_status, ev.attempt_id::text AS attempt_id,
             attempt.status AS attempt_status, latest.id::text AS latest_attempt_id,
             EXISTS(SELECT 1 FROM job_attempt_effects fx WHERE fx.job_id=j.id AND fx.status IN ('unknown','effect_pending')) AS unsafe_effect,
             NULL::text AS node_verification_status, e.sha256 AS evidence_sha256,
             e.kind AS evidence_kind, e.polarity AS evidence_polarity, e.statement AS evidence_statement, e.payload_json AS evidence_payload
      FROM artifact_evidence e
      JOIN artifacts a ON a.id=e.artifact_id AND a.project_id=${finding.project_id} AND a.canvas_id=${finding.canvas_id}
      JOIN jobs j ON j.id=a.job_id AND j.project_id=${finding.project_id} AND j.canvas_id=${finding.canvas_id}
      LEFT JOIN events ev ON ev.job_id=j.id AND ev.event_id=a.source_event_id
      LEFT JOIN job_attempts attempt ON attempt.id=ev.attempt_id AND attempt.job_id=j.id
      LEFT JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
      WHERE e.id=ANY(${refs}::uuid[])
        AND (a.id=${finding.artifact_id ?? null} OR a.body_json #>> '{verification,finding_id}'=${finding.finding_id}
          OR EXISTS(SELECT 1 FROM canvas_nodes related WHERE related.id=a.node_id
            AND (related.body_json #>> '{verification,finding_id}'=${finding.finding_id} OR related.body_json->>'finding_id'=${finding.finding_id})) )
    ) evidence
    ORDER BY ref_id`;
  const reasons: string[] = [];
  const bindings: CurrentEvidenceBinding[] = [];
  const byRef = new Map(rows.map((row) => [String(row.ref_id).toLowerCase(), row]));
  for (const ref of refs) {
    const row = byRef.get(ref.toLowerCase());
    if (!row) {
      reasons.push("eligibility_evidence_unavailable");
      continue;
    }
    if (row.artifact_status !== "submitted" || row.artifact_superseded_at !== null || row.job_status !== "succeeded"
      || !row.attempt_id || row.attempt_status !== "succeeded" || row.attempt_id !== row.latest_attempt_id || row.unsafe_effect
      || (row.kind === "fact" && row.node_verification_status === "rejected")) {
      reasons.push("eligibility_evidence_not_current");
      continue;
    }
    const artifactId = String(row.artifact_id);
    const fingerprint = jsonDigest({ ref: ref.toLowerCase(), kind: String(row.kind), artifact_id: artifactId,
      artifact_revision: Number(row.artifact_revision), source_operation: String(row.source_operation), evidence_sha256: row.evidence_sha256 ?? null,
      evidence_kind: row.evidence_kind ?? null, evidence_polarity: row.evidence_polarity ?? null,
      evidence_statement: jsonDigest(row.evidence_statement ?? null), evidence_payload: jsonDigest(row.evidence_payload ?? null) });
    bindings.push({ ref: ref.toLowerCase(), kind: String(row.kind) as CurrentEvidenceBinding["kind"], artifact_id: artifactId,
      artifact_revision: Number(row.artifact_revision), fingerprint });
  }
  if (reasons.length || bindings.length !== refs.length) return { bindings, digest: null, reasons: [...new Set(reasons.length ? reasons : ["eligibility_evidence_unavailable"])] };
  return { bindings, digest: jsonDigest(bindings), reasons: [] };
}

/**
 * Freeze the complete review input set inside the same transaction that writes
 * the immutable review. The second read after these locks is the authoritative
 * preflight; an evidence or Verify mutation cannot commit between validation
 * and the audit append.
 */
async function lockReviewInputs(tx: Db, finding: CurrentFindingBinding, refs: readonly string[]): Promise<void> {
  const [roundInfo] = await tx`
    SELECT id, verify_job_id FROM finding_verification_rounds
    WHERE finding_id=${finding.finding_id}
    ORDER BY attempt DESC, created_at DESC LIMIT 1`;
  const evidenceJobs = await tx`
    SELECT DISTINCT a.job_id AS id
    FROM artifacts a
    WHERE a.id::text IN (
      SELECT n.body_json->>'artifact_id' FROM canvas_nodes n WHERE n.id=ANY(${refs}::uuid[])
      UNION
      SELECT e.artifact_id::text FROM artifact_evidence e WHERE e.id=ANY(${refs}::uuid[])
    )`;

  await tx`SELECT id FROM jobs WHERE id=${finding.source_job_id} FOR UPDATE`;
  const [findingRow] = await tx`SELECT id, artifact_id FROM findings WHERE id=${finding.finding_id} FOR UPDATE`;
  const [sourceArtifact] = findingRow?.artifact_id
    ? await tx`SELECT id, source_event_id, job_id FROM artifacts WHERE id=${findingRow.artifact_id} FOR UPDATE`
    : [];
  if (sourceArtifact?.source_event_id) {
    const [sourceEvent] = await tx`SELECT id, attempt_id FROM events
      WHERE job_id=${sourceArtifact.job_id} AND event_id=${sourceArtifact.source_event_id} FOR UPDATE`;
    if (sourceEvent?.attempt_id) await tx`SELECT id FROM job_attempts WHERE id=${sourceEvent.attempt_id} FOR UPDATE`;
  }
  await tx`SELECT id FROM job_attempts WHERE job_id=${finding.source_job_id} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;

  if (roundInfo?.verify_job_id) {
    await tx`SELECT id FROM jobs WHERE id=${roundInfo.verify_job_id} FOR UPDATE`;
    await tx`SELECT id FROM job_attempts WHERE job_id=${roundInfo.verify_job_id} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
  }
  if (roundInfo?.id) await tx`SELECT id FROM finding_verification_rounds WHERE id=${roundInfo.id} FOR UPDATE`;

  for (const row of evidenceJobs) {
    const jobId = text(row.id);
    if (jobId) await tx`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
  }
  await tx`SELECT id FROM canvas_nodes WHERE id=ANY(${refs}::uuid[]) FOR UPDATE`;
  const evidenceRows = await tx`SELECT id, artifact_id FROM artifact_evidence WHERE id=ANY(${refs}::uuid[]) FOR UPDATE`;
  const factRows = await tx`SELECT body_json->>'artifact_id' AS artifact_id FROM canvas_nodes WHERE id=ANY(${refs}::uuid[])`;
  const candidateArtifactIds = [
    ...evidenceRows.map((row) => text(row.artifact_id)),
    ...factRows.map((row) => text(row.artifact_id)),
    finding.artifact_id,
  ];
  const evidenceArtifactIds = [...new Set(candidateArtifactIds.filter((id): id is string => Boolean(id && isUuid(id))))];
  await tx`SELECT id FROM artifacts WHERE id=ANY(${evidenceArtifactIds}::uuid[]) FOR UPDATE`;
}

export async function submitProgramEligibilityReview(db: Db, actor: Actor, raw: unknown): Promise<{
  record: ProgramEligibilityReviewRecord;
  duplicate: boolean;
}> {
  const request = normalizeReview(raw);
  const digest = requestDigest(request);
  if (!canReviewEligibility(actor)) {
    throw new ProgramEligibilityStoreError("PROGRAM_ELIGIBILITY_REVIEW_PERMISSION_REQUIRED", "only an authenticated authorized operator may review eligibility", 403);
  }
  const reviewer = reviewerFromActor(actor);
  // SAFETY: this transaction returns the declared review object; postgres.js
  // generics cannot express that shape, and its tx has the same SQL tag API.
  return db.begin(async (txRaw) => {
    // SAFETY: only the shared tagged-query interface is used on this handle.
    const tx = txRaw as unknown as Db;
    const [owner] = await tx`SELECT f.project_id,j.canvas_id FROM findings f
      JOIN jobs j ON j.id=f.job_id AND j.project_id=f.project_id WHERE f.id=${request.finding_id}`;
    if (!owner) throw new ProgramEligibilityStoreError("FINDING_NOT_FOUND", "Finding not found", 404);
    if (actor.projectId && actor.projectId !== owner.project_id) {
      throw new ProgramEligibilityStoreError("PROJECT_SCOPE_FORBIDDEN", "reviewer project scope does not include this Finding", 403);
    }
    // Match ingestion/convergence lock order, before material and Job locks.
    if (owner.canvas_id) await tx`SELECT id FROM canvases WHERE id=${owner.canvas_id} FOR UPDATE`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MATERIAL_LIFECYCLE_LOCK}))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"program-eligibility-review:" + request.finding_id}))`;
    const [existing] = await tx`
      SELECT after_json FROM audit_logs
      WHERE action=${PROGRAM_ELIGIBILITY_ACTIONS.review} AND result='ok'
        AND project_id=(SELECT project_id FROM findings WHERE id=${request.finding_id})
        AND after_json->'request'->>'idempotency_key'=${request.idempotency_key}`;
    if (existing) {
      const parsed = parseReview(existing.after_json);
      if (!parsed || parsed.request_digest !== digest) throw new ProgramEligibilityStoreError("PROGRAM_ELIGIBILITY_IDEMPOTENCY_CONFLICT", "Eligibility review idempotency key was already used for different content");
      return { record: parsed, duplicate: true };
    }
    const initialFinding = await loadCurrentFindingBinding(tx, request.finding_id);
    if (!initialFinding) throw new ProgramEligibilityStoreError("FINDING_NOT_FOUND", "Finding not found", 404);
    let finding = initialFinding;
    const projectId = finding?.project_id ?? null;
    if (!projectId) throw new ProgramEligibilityStoreError("FINDING_NOT_FOUND", "Finding not found", 404);
    if (actor.projectId && actor.projectId !== projectId) {
      throw new ProgramEligibilityStoreError("PROJECT_SCOPE_FORBIDDEN", "reviewer project scope does not include this Finding", 403);
    }
    if (request.decision === "approve" && actorMatchesMaker(actor, finding)) {
      throw new ProgramEligibilityStoreError("PROGRAM_ELIGIBILITY_MAKER_SELF_APPROVAL", "the Finding maker cannot approve its own program eligibility", 403);
    }
    await lockReviewInputs(tx, finding, request.evidence_refs);
    const currentFinding = await loadCurrentFindingBinding(tx, request.finding_id);
    if (!currentFinding) throw new ProgramEligibilityStoreError("FINDING_NOT_FOUND", "Finding not found", 404);
    finding = currentFinding;
    if (actor.projectId && actor.projectId !== finding.project_id) {
      throw new ProgramEligibilityStoreError("PROJECT_SCOPE_FORBIDDEN", "reviewer project scope does not include this Finding", 403);
    }
    const materialAudit = await materialAuditRows(tx, projectId);
    const materialHistory = materialViews(materialAudit.events);
    const material = materialHistory.materials.find((item) => item.material_id === request.program_material_id) ?? null;
    const reasons: string[] = [...(finding?.reasons ?? [])];
    if (materialHistory.invalid) reasons.push("program_material_history_invalid");
    if (materialAudit.incomplete) reasons.push("program_material_history_incomplete");
    if (!material) reasons.push("program_material_not_found");
    else {
      if (material.status !== "active") reasons.push("program_material_not_current");
      if (material.request.scope.kind === "project" && material.request.scope.project_id !== projectId) reasons.push("program_material_scope_mismatch");
    }
    const materialBound = material ? materialBinding(material, request) : null;
    if (material && !materialBound) reasons.push("program_material_binding_mismatch");
    if (finding?.artifact_id !== request.finding_artifact_id || finding?.artifact_revision !== request.finding_artifact_revision
      || finding?.source_digest !== request.finding_source_digest) reasons.push("finding_binding_mismatch");
    if (!finding || !findingTargetMatches(request, finding)) reasons.push("finding_target_binding_mismatch");
    const evidence = finding ? await loadEvidenceBindings(tx, finding, request.evidence_refs) : { bindings: [], digest: null, reasons: ["eligibility_evidence_unavailable"] };
    reasons.push(...evidence.reasons);
    const ruleReasons = material ? assessProgramRules(material, request) : ["program_material_not_found"];
    reasons.push(...ruleReasons);
    const ineligibilityReasons = new Set(["program_exclusion_applies", "program_requirement_not_met"]);
    const structuralReasons = reasons.filter((code) => !ineligibilityReasons.has(code));
    const status = request.decision === "reject" && structuralReasons.length === 0 ? "ineligible" as const
      : request.decision === "approve" && reasons.length === 0 ? "eligible" as const : "blocked" as const;
    if (request.decision === "reject") reasons.push("eligibility_rejected_by_reviewer");
    const technicalBinding = finding.reasons.length === 0 && finding.artifact_id && finding.artifact_revision && finding.source_digest
      && finding.target_reference && finding.baseline && finding.verification_round_id && finding.verification_attempt && finding.technical_confirmation_digest
      ? { finding_id: finding.finding_id, artifact_id: finding.artifact_id, artifact_revision: finding.artifact_revision, source_digest: finding.source_digest,
        target_reference: finding.target_reference, baseline: finding.baseline,
        verification_round_id: finding.verification_round_id, verification_attempt: finding.verification_attempt, confirmation_digest: finding.technical_confirmation_digest } : null;
    const review: ProgramEligibilityReviewRecord = {
      schema_version: 1, review_id: randomUUID(), request, reviewer, reviewed_at: new Date().toISOString(), status,
      reason_codes: [...new Set(reasons)], technical_binding: technicalBinding, material_binding: materialBound,
      evidence_bindings: evidence.bindings, evidence_digest: evidence.digest, request_digest: digest,
    };
    const [auditRow] = await tx`
      SELECT f.project_id FROM findings f WHERE f.id=${request.finding_id}`;
    await insertAudit(tx, {
      actor, action: PROGRAM_ELIGIBILITY_ACTIONS.review, projectId: String(auditRow.project_id),
      resourceType: "finding_program_eligibility", resourceId: review.review_id, after: review,
    });
    return { record: review, duplicate: false };
  }) as unknown as { record: ProgramEligibilityReviewRecord; duplicate: boolean };
}

function parseReview(after: unknown): ProgramEligibilityReviewRecord | null {
  try {
    // Runtime validation is intentionally repeated on every read. Audit rows
    // are durable history, but malformed history must never become authority.
    const parsed = ProgramEligibilityReviewRecord.safeParse(after);
    if (!parsed.success) return null;
    const reviewer = parsed.data.reviewer;
    const reviewerValid = reviewer.actor_type === "bootstrap_admin"
      ? reviewer.permission === "admin" && reviewer.role === undefined
      : reviewer.actor_type === "user"
        ? (reviewer.role === "admin" ? reviewer.permission === "admin" || reviewer.permission === "findings:write" : reviewer.role === "operator" && (reviewer.permission === "admin" || reviewer.permission === "findings:write"))
        : reviewer.role === undefined;
    const bindingComplete = parsed.data.technical_binding !== null && parsed.data.material_binding !== null && parsed.data.evidence_digest !== null;
    const statusConsistent = parsed.data.status === "blocked" || (bindingComplete && parsed.data.request.decision === (parsed.data.status === "eligible" ? "approve" : "reject")
      && (parsed.data.status === "eligible" || parsed.data.reason_codes.includes("eligibility_rejected_by_reviewer")));
    if (!reviewerValid || !statusConsistent || requestDigest(parsed.data.request) !== parsed.data.request_digest) return null;
    if (parsed.data.evidence_digest !== null && jsonDigest(parsed.data.evidence_bindings) !== parsed.data.evidence_digest) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function loadProgramEligibilityReviews(db: Db, projectId: string, findingIds?: readonly string[]): Promise<{
  reviews: ProgramEligibilityReviewRecord[];
  invalid: number;
  incomplete: boolean;
}> {
  if (findingIds !== undefined && findingIds.length === 0) return { reviews: [], invalid: 0, incomplete: false };
  const maxRows = findingIds === undefined ? MAX_REVIEW_AUDIT_ROWS : Math.min(MAX_REVIEW_AUDIT_ROWS, Math.max(1, findingIds.length * MAX_REVIEW_AUDIT_ROWS));
  const queryLimit = maxRows + 1;
  const rows = await db`
    SELECT CASE WHEN octet_length(COALESCE(after_json::text, '')) <= ${MAX_REVIEW_EVENT_BYTES}
                THEN after_json ELSE NULL END AS after_json,
           octet_length(COALESCE(after_json::text, '')) AS payload_bytes
    FROM audit_logs
    WHERE action=${PROGRAM_ELIGIBILITY_ACTIONS.review} AND result='ok' AND project_id=${projectId}
      AND (${findingIds === undefined} OR after_json->'request'->>'finding_id'=ANY(${[...(findingIds ?? [])]}::text[]))
    ORDER BY id ASC
    LIMIT ${queryLimit}`;
  const reviews: ProgramEligibilityReviewRecord[] = [];
  let invalid = 0;
  let incomplete = rows.length > maxRows;
  let bytes = 0;
  for (const row of rows.slice(0, maxRows)) {
    const payloadBytes = Number(row.payload_bytes ?? 0);
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > MAX_REVIEW_EVENT_BYTES || row.after_json === null) {
      invalid++;
      incomplete = true;
      continue;
    }
    bytes += payloadBytes;
    if (bytes > MAX_REVIEW_AUDIT_BYTES) {
      incomplete = true;
      break;
    }
    const parsed = parseReview(row.after_json);
    if (parsed) reviews.push(parsed); else invalid++;
  }
  return { reviews, invalid, incomplete };
}

async function currentEvidenceDigestForReview(db: Db, finding: CurrentFindingBinding | null, review: ProgramEligibilityReviewRecord): Promise<string | null> {
  if (!finding) return null;
  return (await loadEvidenceBindings(db, finding, review.request.evidence_refs)).digest;
}

export interface ProgramEligibilityDetail {
  projection: EligibilityProjection;
  reviews: ProgramEligibilityReviewRecord[];
  material: ProgramMaterialView | null;
  invalid_history_count: number;
  history_incomplete: boolean;
}

async function loadProgramEligibilityDetailInSnapshot(db: Db, projectId: string | undefined, findingId: string): Promise<ProgramEligibilityDetail | null> {
  const finding = await loadCurrentFindingBinding(db, findingId);
  if (!finding || projectId && finding.project_id !== projectId) return null;
  const ownerProjectId = finding.project_id;
  const loaded = await loadProgramEligibilityReviews(db, ownerProjectId, [findingId]);
  const reviews = loaded.reviews.filter((review) => review.request.finding_id === findingId);
  const materialHistory = await loadProgramMaterials(db, ownerProjectId);
  const materials = materialHistory.materials;
  const referenced = [...new Set(reviews.map((review) => review.request.program_material_id))]
    .map((id) => materials.find((material) => material.material_id === id)).filter((material): material is ProgramMaterialView => Boolean(material));
  const active = referenced.filter((material) => material.status === "active");
  const material = active.length === 1 ? active[0]! : null;
  const materialGaps = active.length > 1 ? ["program_material_ambiguous"] : material ? [] : reviews.length ? ["program_material_not_current"] : [];
  const evidenceDigests = new Map<string, string | null>();
  for (const review of reviews) evidenceDigests.set(review.review_id, await currentEvidenceDigestForReview(db, finding, review));
  const input: EligibilityProjectionInput & { currentEvidenceDigests: ReadonlyMap<string, string | null> } = {
    findingId, technicalStatus: finding.verify_status, technicalBinding: finding, technicalGaps: finding.reasons,
    material, materialGaps, currentEvidenceDigest: material && reviews.length === 1 ? evidenceDigests.get(reviews[0]!.review_id) ?? null : null,
    currentEvidenceDigests: evidenceDigests, reviews,
    historyInvalid: loaded.invalid > 0 || loaded.incomplete || materialHistory.invalid > 0 || materialHistory.incomplete,
  };
  const projection = projectProgramEligibility(input);
  return {
    projection, reviews, material, invalid_history_count: loaded.invalid + materialHistory.invalid,
    history_incomplete: loaded.incomplete || materialHistory.incomplete,
  };
}

async function withEligibilityRead<T>(db: Db, read: (tx: Db) => Promise<T>): Promise<T> {
  if (typeof db.begin === "function") {
    // SAFETY: postgres.js preserves the callback result T; its transaction
    // supports the same SQL tag used by read(), with no nested begin call.
    return db.begin("isolation level repeatable read read only", (tx) => read(tx as unknown as Db)) as unknown as Promise<T>;
  }
  // Report/convergence callers already hold their Canvas input lock. Keep
  // program admission stable in that transaction, in the same lock order.
  await db`SELECT pg_advisory_xact_lock_shared(hashtext(${MATERIAL_LIFECYCLE_LOCK}))`;
  return read(db);
}

export async function loadProgramEligibilityDetail(db: Db, projectId: string | undefined, findingId: string): Promise<ProgramEligibilityDetail | null> {
  return withEligibilityRead(db, (tx) => loadProgramEligibilityDetailInSnapshot(tx, projectId, findingId));
}

export async function loadProgramEligibilityProjections(db: Db, projectId: string, findingIds: readonly string[]): Promise<Map<string, EligibilityProjection>> {
  return withEligibilityRead(db, async (tx) => {
    const output = new Map<string, EligibilityProjection>();
    const uniqueIds = [...new Set(findingIds)];
    for (const findingId of uniqueIds.slice(0, MAX_PROJECTION_FINDINGS)) {
      const detail = await loadProgramEligibilityDetailInSnapshot(tx, projectId, findingId);
      if (detail) output.set(findingId, detail.projection);
    }
    for (const findingId of uniqueIds.slice(MAX_PROJECTION_FINDINGS)) {
      output.set(findingId, { status: "blocked", finding_id: findingId, technical_status: "unknown", current_review_id: null,
        current_material_id: null, gaps: ["eligibility_projection_limit_exceeded"], historical_review_ids: [] });
    }
    return output;
  });
}
