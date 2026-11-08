import { parseDeclaredQuantities } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { factQuantityParticipatesInGate } from "./fact-verification.js";
import { factEvidenceTraceInternals, loadFactEvidenceTrace } from "../../fact-evidence-trace.js";
import { readPlanAudit } from "../plan-protocol/application.js";
import { loadPlanCriteria } from "../plan-protocol/criterion-projection.js";
import { criterionEvidenceBudget } from "../plan-protocol/criterion-evidence.js";
import type { CriterionSource } from "../plan-protocol/criterion-source.js";
import { StoredPlanCriterionBinding, PLAN_BINDING_ACTION, type CriterionProjection } from "../plan-protocol/criterion-model.js";

type Db = typeof sql;
type FindingRecord = Record<string, unknown> & {
  id: string;
  verify_status: string;
  raw_json: unknown;
  requirements_json?: unknown;
  evidence_snapshot_json?: unknown;
};

export type FactUsageReason = string;
export type FactUsageIntegrityStatus = "not_applicable" | "not_checked" | "ok" | "blocked" | "unknown";
export type FactUsage = {
  kind: "observation" | "verification";
  finding_usage: "none" | "linked" | "used" | "unknown";
  attention_required: boolean;
  reasons: FactUsageReason[];
  next_action: "none" | "review_fact" | "inspect_finding" | "inspect_job" | "inspect_plan";
  report_quantity_gate: boolean;
  used_by_finding_ids: string[];
  used_by_findings_truncated: boolean;
  integrity: {
    status: FactUsageIntegrityStatus;
    blockers: Array<{ code: string; fact_id: string | null }>;
  };
  plan_usage?: Array<{
    plan_job_id: string | null;
    criterion_id: string | null;
    state: string;
    binding_state?: string;
    reasons: string[];
  }>;
  plan_usage_truncated?: boolean;
};

export type FactUsageInput = {
  id: string;
  verification_status: string;
  usage_evidence_kind?: unknown;
  verification?: unknown;
  quantities?: unknown;
  finding?: { id?: string | null; verify_status?: string | null } | null;
  job?: { status?: string | null } | null;
};

export type FactUsageBatch = {
  byFactId: Map<string, FactUsage>;
  findingsById: Map<string, FindingRecord>;
  truncated: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function factUsageKind(value: unknown): FactUsage["kind"] {
  if (typeof value === "string") return value === "review" || value === "test" ? "verification" : "observation";
  const verification = record(value);
  return verification.evidence_kind === "review" || verification.evidence_kind === "test" ? "verification" : "observation";
}

export function isStrictFactUsageUuid(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

export function normalizePlanCriterionId(value: unknown): string | null {
  const candidate = str(value);
  return /^(completion|output-(?:[0-9]|[12][0-9]|3[01]))$/.test(candidate) ? candidate : null;
}

function findingUsedFactIds(finding: FindingRecord): string[] {
  return factEvidenceTraceInternals.extractUsedFactIds(finding, finding.requirements_json || finding.evidence_snapshot_json
    ? [{
      final_outcome: "confirmed",
      requirements_json: finding.requirements_json,
      evidence_snapshot_json: finding.evidence_snapshot_json,
    }]
    : []);
}

function findingGateIncomplete(finding: FindingRecord): boolean {
  const state = record(record(finding.raw_json).verification_state);
  const gate = record(state.gate);
  const result = str(gate.result);
  const missing = Array.isArray(gate.missing) ? gate.missing.filter((item) => typeof item === "string" && item.trim()) : [];
  return (result.length > 0 && result !== "passed") || missing.length > 0;
}

export function factUsageNextAction(reasons: readonly string[]): FactUsage["next_action"] {
  if (reasons.includes("fact_needs_human")) return "review_fact";
  if (reasons.some((reason) => reason.startsWith("plan_binding_"))) return "inspect_plan";
  if (reasons.includes("source_job_needs_human") || reasons.includes("used_fact_source_unavailable")) return "inspect_job";
  if (reasons.includes("finding_usage_truncated") || reasons.includes("used_by_findings_truncated")) return "inspect_finding";
  if (reasons.some((reason) => reason.startsWith("finding_") || reason.startsWith("used_fact_"))) return "inspect_finding";
  return "none";
}

const attentionReasonCodes = new Set([
  "fact_needs_human", "source_job_needs_human", "finding_needs_human", "used_fact_gate_incomplete",
  "finding_usage_truncated", "used_fact_integrity_unknown", "used_by_findings_truncated", "plan_binding_unknown",
  "plan_binding_check_required", "plan_binding_truncated", "used_fact_integrity_failed",
  "used_fact_source_unavailable", "plan_binding_stale", "plan_binding_incomplete",
]);

function needsAttention(reasons: readonly string[]): boolean {
  return reasons.some((reason) => attentionReasonCodes.has(reason));
}

export function classifyFactFindingUsage(usedBy: readonly string[], linkedId: string | null, truncated: boolean) {
  return {
    finding_usage: usedBy.length > 0 ? "used" as const : truncated ? "unknown" as const : linkedId ? "linked" as const : "none" as const,
    used_by_findings_truncated: usedBy.length > 10 || truncated,
    reasons: [
      ...(truncated ? [usedBy.length > 0 ? "used_by_findings_truncated" : "finding_usage_truncated"] : []),
      ...(usedBy.length > 10 && !truncated ? ["used_by_findings_truncated"] : []),
    ],
  };
}

export function projectFactPlanUsageItem(
  planJobId: string,
  criterion: CriterionProjection | undefined,
  factId: string,
): NonNullable<FactUsage["plan_usage"]>[number] {
  if (!criterion) return { plan_job_id: planJobId, criterion_id: null, state: "stale", reasons: ["criterion_missing_from_current_plan"] };
  const current = criterion.bindings.find((entry) => entry.binding.fact_id === factId);
  if (!current) return {
    plan_job_id: planJobId, criterion_id: criterion.id, state: "unknown",
    reasons: [criterion.truncated ? "current_plan_projection_truncated" : "plan_binding_not_in_current_projection"],
  };
  return {
    plan_job_id: planJobId, criterion_id: criterion.id, state: criterion.state, binding_state: current.state,
    reasons: [...new Set([...current.reasons, ...(criterion.state !== current.state ? [`criterion_${criterion.state}`] : [])])],
  };
}

export function mergeFactPlanUsage(
  usage: FactUsage,
  items: NonNullable<FactUsage["plan_usage"]>,
  truncated: boolean,
): FactUsage {
  const stale = items.some((item) => item.state === "stale");
  const incomplete = items.some((item) => ["blocked", "insufficient", "conflict", "contradicted"].includes(item.state));
  const unknown = truncated || items.some((item) => item.state === "unknown");
  const planReasons = [
    ...(stale ? ["plan_binding_stale"] : []),
    ...(incomplete ? ["plan_binding_incomplete"] : []),
    ...(unknown ? ["plan_binding_truncated"] : []),
    ...(items.some((item) => item.state === "unknown") ? ["plan_binding_unknown"] : []),
  ];
  const reasons = [...new Set([
    ...usage.reasons.filter((reason) => reason !== "plan_binding_check_required"),
    ...planReasons,
  ])];
  return {
    ...usage,
    attention_required: needsAttention(reasons),
    reasons,
    next_action: stale || incomplete || unknown ? "inspect_plan" : factUsageNextAction(reasons),
    plan_usage: items,
    plan_usage_truncated: truncated,
  };
}

/** Resolve current authoritative usage for a bounded page. This query is canvas/project scoped and never reads retained bytes. */
export async function loadFactUsageBatch(
  db: Db,
  canvasId: string,
  projectId: string,
  facts: readonly FactUsageInput[],
): Promise<FactUsageBatch> {
  const ids = facts.map((fact) => fact.id);
  const linkedFindingIds = [...new Set(facts.map((fact) => fact.finding?.id).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return { byFactId: new Map(), findingsById: new Map(), truncated: false };

  // Candidate rows are selected only when their current state, latest confirmed round, or direct link can affect this page.
  // JSONB references are resolved before pagination; a bounded overflow is reported as unknown instead of a false `none`.
  const candidates = await db<FindingRecord[]>`
    SELECT f.id::text AS id, f.verify_status, f.raw_json,
           latest.requirements_json, latest.evidence_snapshot_json
    FROM findings f
    JOIN jobs origin ON origin.id = f.job_id AND origin.project_id = ${projectId} AND origin.canvas_id = ${canvasId}
    LEFT JOIN LATERAL (
      SELECT r.requirements_json, r.evidence_snapshot_json
      FROM finding_verification_rounds r
      WHERE r.finding_id = f.id AND r.final_outcome = 'confirmed'
        AND (
          jsonb_array_length(CASE WHEN jsonb_typeof(r.requirements_json->'used_fact_ids') = 'array' THEN r.requirements_json->'used_fact_ids' ELSE '[]'::jsonb END) > 0
          OR jsonb_array_length(CASE WHEN jsonb_typeof(r.requirements_json->'gate'->'used_fact_ids') = 'array' THEN r.requirements_json->'gate'->'used_fact_ids' ELSE '[]'::jsonb END) > 0
          OR jsonb_array_length(CASE WHEN jsonb_typeof(r.evidence_snapshot_json->'gate'->'used_fact_ids') = 'array' THEN r.evidence_snapshot_json->'gate'->'used_fact_ids' ELSE '[]'::jsonb END) > 0
        )
      ORDER BY r.attempt DESC, r.created_at DESC LIMIT 1
    ) latest ON true
    WHERE f.project_id = ${projectId}
      AND (
        f.id = ANY(${linkedFindingIds}::uuid[])
        OR COALESCE(f.raw_json #> '{verification_state,used_fact_ids}', '[]'::jsonb) ?| ${ids}::text[]
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(f.raw_json #> '{verification_state,confirm_trace,used_fact_replay}') = 'array'
              THEN f.raw_json #> '{verification_state,confirm_trace,used_fact_replay}' ELSE '[]'::jsonb END
          ) replay WHERE replay->>'ref_id' = ANY(${ids}::text[])
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(f.raw_json #> '{verification_state,used_fact_replay}') = 'array'
              THEN f.raw_json #> '{verification_state,used_fact_replay}' ELSE '[]'::jsonb END
          ) replay WHERE replay->>'ref_id' = ANY(${ids}::text[])
        )
        OR COALESCE(latest.requirements_json->'used_fact_ids', '[]'::jsonb) ?| ${ids}::text[]
        OR COALESCE(latest.requirements_json->'gate'->'used_fact_ids', '[]'::jsonb) ?| ${ids}::text[]
        OR COALESCE(latest.evidence_snapshot_json->'gate'->'used_fact_ids', '[]'::jsonb) ?| ${ids}::text[]
      )
    ORDER BY (f.id = ANY(${linkedFindingIds}::uuid[])) DESC, f.updated_at DESC, f.id
    LIMIT 501`;
  const truncated = candidates.length > 500;
  const scopedCandidates = candidates.slice(0, 500);
  const findingsById = new Map(scopedCandidates.map((finding) => [finding.id, finding]));
  const usedByFact = new Map(ids.map((id) => [id, [] as string[]]));
  for (const finding of scopedCandidates) {
    for (const id of findingUsedFactIds(finding)) {
      const usages = usedByFact.get(id);
      if (usages) usages.push(finding.id);
    }
  }

  const planAuditRows = await db<{ resource_id: string }[]>`
    SELECT DISTINCT resource_id::text AS resource_id FROM audit_logs
    WHERE project_id = ${projectId} AND resource_id = ANY(${ids}::text[])
      AND action = ${PLAN_BINDING_ACTION} AND result = 'ok'
    LIMIT 501`;
  const planBoundFactIds = new Set(planAuditRows.slice(0, 500).map((row) => row.resource_id));
  const planAuditTruncated = planAuditRows.length > 500;

  const byFactId = new Map<string, FactUsage>();
  for (const fact of facts) {
    const usedBy = [...new Set(usedByFact.get(fact.id) ?? [])].sort();
    const linkedId = fact.finding?.id ?? null;
    const relation = classifyFactFindingUsage(usedBy, linkedId, truncated);
    const findingUsage = relation.finding_usage;
    const reasons: string[] = [];
    if (fact.verification_status === "needs_human") reasons.push("fact_needs_human");
    if (fact.job?.status === "waiting_human") reasons.push("source_job_needs_human");
    const impactFindings = new Set([...usedBy, ...(linkedId ? [linkedId] : [])]);
    for (const findingId of impactFindings) {
      const finding = findingsById.get(findingId);
      if (finding?.verify_status === "needs_human") reasons.push("finding_needs_human");
    }
    for (const findingId of usedBy) {
      const finding = findingsById.get(findingId);
      if (finding && findingGateIncomplete(finding)) reasons.push("used_fact_gate_incomplete");
    }
    reasons.push(...relation.reasons);
    if (planBoundFactIds.has(fact.id)) reasons.push("plan_binding_check_required");
    if (planAuditTruncated) reasons.push("plan_binding_truncated");
    const integrityStatus: FactUsageIntegrityStatus = findingUsage === "used"
      ? "not_checked"
      : findingUsage === "unknown" ? "unknown" : "not_applicable";
    if (integrityStatus === "unknown") reasons.push("used_fact_integrity_unknown");
    const uniqueReasons = [...new Set(reasons)];
    byFactId.set(fact.id, {
      kind: factUsageKind(fact.verification ?? fact.usage_evidence_kind),
      finding_usage: findingUsage,
      attention_required: needsAttention(uniqueReasons),
      reasons: uniqueReasons,
      next_action: factUsageNextAction(uniqueReasons),
      report_quantity_gate: factQuantityParticipatesInGate(fact.verification_status)
        && parseDeclaredQuantities(fact.quantities).length > 0,
      used_by_finding_ids: usedBy.slice(0, 10),
      used_by_findings_truncated: relation.used_by_findings_truncated,
      integrity: { status: integrityStatus, blockers: [] },
    });
  }
  return { byFactId, findingsById, truncated };
}

export async function loadFactPlanUsage(
  db: Db,
  canvasId: string,
  projectId: string,
  factId: string,
  budget = criterionEvidenceBudget(),
): Promise<{ items: NonNullable<FactUsage["plan_usage"]>; truncated: boolean }> {
  const rows = await db<{ id: string; after_json: unknown }[]>`
    SELECT id::text AS id, after_json FROM (
      SELECT DISTINCT ON (after_json->>'plan_job_id', after_json->>'criterion_id') id, after_json
      FROM audit_logs
      WHERE project_id = ${projectId} AND resource_id = ${factId}
        AND action = ${PLAN_BINDING_ACTION} AND result = 'ok'
      ORDER BY after_json->>'plan_job_id', after_json->>'criterion_id', id DESC
    ) latest ORDER BY id DESC LIMIT 65`;
  let truncated = rows.length > 64;
  const latestRows = rows.slice(0, 64);
  const parsed = latestRows.map((row) => ({ row, binding: StoredPlanCriterionBinding.safeParse(row.after_json) }));
  const invalidPlanRows = parsed.filter(({ row, binding }) => {
    const value = binding.success ? binding.data.plan_job_id : str(record(row.after_json).plan_job_id);
    return !isStrictFactUsageUuid(value);
  });
  const planIds = [...new Set(parsed.map(({ row, binding }) => {
    const value = binding.success ? binding.data.plan_job_id : str(record(row.after_json).plan_job_id);
    return isStrictFactUsageUuid(value) ? value : "";
  }).filter(Boolean))];
  const processPlanIds = planIds.slice(0, 8);
  if (planIds.length > processPlanIds.length) truncated = true;
  const items: NonNullable<FactUsage["plan_usage"]> = [];
  for (const { row, binding } of invalidPlanRows) {
    const value = binding.success ? binding.data : record(row.after_json);
    items.push({ plan_job_id: null, criterion_id: normalizePlanCriterionId(value.criterion_id),
      state: "unknown", reasons: ["plan_job_id_invalid"] });
    truncated = true;
  }
  const cache = new Map<string, CriterionSource | null>();
  for (const planJobId of processPlanIds) {
    const [job] = await db`
      SELECT payload_json FROM jobs
      WHERE id = ${planJobId} AND canvas_id = ${canvasId} AND project_id = ${projectId} AND type <> 'report'`;
    const rawPlan = job ? readPlanAudit(job.payload_json)?.raw : null;
    const bindingsForPlan = parsed.filter(({ row, binding }) =>
      (binding.success ? binding.data.plan_job_id : str(record(row.after_json).plan_job_id)) === planJobId);
    if (!job || !rawPlan) {
      for (const { row, binding } of bindingsForPlan) {
        const value = binding.success ? binding.data : record(row.after_json);
        items.push({
          plan_job_id: planJobId,
          criterion_id: normalizePlanCriterionId(value.criterion_id),
          state: "stale",
          reasons: [!job ? "plan_job_missing_or_out_of_scope" : "current_plan_unavailable"],
        });
      }
      continue;
    }
    const projection = await loadPlanCriteria(db, canvasId, projectId, planJobId, rawPlan, budget, cache);
    for (const { row, binding } of bindingsForPlan) {
      if (!binding.success) {
        items.push({ plan_job_id: planJobId, criterion_id: normalizePlanCriterionId(record(row.after_json).criterion_id),
          state: "stale", reasons: ["plan_binding_invalid"] });
        continue;
      }
      const item = projection.find((criterion) => criterion.id === binding.data.criterion_id);
      if (item?.truncated) truncated = true;
      const projectionBudgetUnknown = item?.bindings.some((entry) => entry.reasons.includes("evidence_unavailable_or_budget_exceeded")) ?? false;
      const projected = projectFactPlanUsageItem(planJobId, item, factId);
      items.push(projectionBudgetUnknown ? {
        ...projected, state: "unknown", binding_state: "unknown", reasons: ["plan_usage_budget_exhausted"],
      } : projected);
    }
  }
  return { items, truncated };
}

/** Add byte-backed evidence diagnostics and current Plan projections for one detail response. */
export async function enrichFactUsageDetail(
  db: Db,
  canvasId: string,
  projectId: string,
  factId: string,
  usage: FactUsage,
  batch: FactUsageBatch,
  budget = criterionEvidenceBudget(),
): Promise<FactUsage> {
  let result = usage;
  if (usage.finding_usage === "used") {
    const candidateIds = usage.used_by_finding_ids.slice(0, 3);
    const diagnostics: Array<{ diagnostic?: { error_code: string | null; recheckability_reason?: string | null }; traceTruncated: boolean }> = [];
    for (const findingId of candidateIds) {
      const current = batch.findingsById.get(findingId);
      if (!current) {
        diagnostics.push({ traceTruncated: true });
        continue;
      }
      const rounds = current.requirements_json || current.evidence_snapshot_json
        ? [{ final_outcome: "confirmed", requirements_json: current.requirements_json, evidence_snapshot_json: current.evidence_snapshot_json }]
        : [];
      const trace = await loadFactEvidenceTrace(db, {
        ...current, id: findingId, project_id: projectId, canvas_id: canvasId,
      }, rounds, budget);
      diagnostics.push({
        diagnostic: trace.facts.find((item) => item.ref_id === factId),
        traceTruncated: trace.replay.blockers.includes("fact_evidence_trace_truncated"),
      });
    }
    const budgetLimited = diagnostics.some(({ diagnostic }) => diagnostic?.recheckability_reason === "evidence_unavailable_or_budget_exceeded");
    const blockers = diagnostics.flatMap(({ diagnostic }) => diagnostic?.error_code
      && !(diagnostic.error_code === "content_unreadable" && diagnostic.recheckability_reason === "evidence_unavailable_or_budget_exceeded")
      ? [{ code: diagnostic.error_code, fact_id: factId }]
      : []);
    const unknown = usage.used_by_findings_truncated || diagnostics.length < usage.used_by_finding_ids.length
      || budgetLimited || diagnostics.some(({ traceTruncated, diagnostic }) => traceTruncated || !diagnostic);
    const integrity: FactUsage["integrity"] = blockers.length > 0
      ? { status: "blocked", blockers }
      : unknown ? { status: "unknown", blockers: [] } : { status: "ok", blockers: [] };
    const sourceBlocker = blockers.some(({ code }) => [
      "source_job_missing", "source_job_failed", "attempt_missing", "content_unreadable", "expired_or_deleted",
    ].includes(code));
    const integrityReasons = blockers.length > 0
      ? [sourceBlocker ? "used_fact_source_unavailable" : "used_fact_integrity_failed"]
      : unknown ? ["used_fact_integrity_unknown"] : [];
    result = {
      ...result,
      reasons: [...new Set([...result.reasons, ...integrityReasons])],
      attention_required: needsAttention([...result.reasons, ...integrityReasons]),
      next_action: factUsageNextAction([...result.reasons, ...integrityReasons]),
      integrity,
    };
  }

  const planUsage = await loadFactPlanUsage(db, canvasId, projectId, factId, budget);
  return mergeFactPlanUsage(result, planUsage.items, planUsage.truncated);
}
