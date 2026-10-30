import {
  normalizeTaskContract, normalizeCandidateOutcomeClaim, deriveTaskGoalCriteria,
  evaluateTaskOutcomeAdmission, type TaskContract,
} from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";

const MAX_FINDINGS = 100;
const MAX_FACT_REFS = 5000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface OutcomeReportFindingSource {
  id: string; job_id: string; verify_status: string; raw_json: unknown;
  project_id: string; canvas_id: string; job_status: string; agent_snapshot_json: unknown;
  finding_node_id?: string | null; artifact_node_id?: string | null;
  artifact_id: string | null; artifact_project_id: string | null; artifact_canvas_id: string | null;
  artifact_job_id: string | null; artifact_status: string | null; source_operation: string | null;
  artifact_superseded_at: unknown; extensions_json: unknown;
  source_attempt_id?: string | null; source_attempt_status?: string | null; latest_attempt_id?: string | null;
}
export type TaskOutcomeReportCriterion = { id: string; assessment: "not_assessed" };
const reportCriteria = (contract: TaskContract): TaskOutcomeReportCriterion[] => deriveTaskGoalCriteria(contract).map(({ id }) => ({
  id, assessment: "not_assessed",
}));
export interface TaskOutcomeReport {
  schema_version: 1;
  mode: "contracted" | "unassessed" | "invalid";
  contract: TaskContract | null;
  contract_basis: "canvas" | "source_job";
  current_canvas_contract_sha256: string | null;
  task_contract_sha256: string | null;
  criteria: TaskOutcomeReportCriterion[];
  source_contracts: Array<{ task_contract_sha256: string; contract?: TaskContract; criteria?: TaskOutcomeReportCriterion[] }>;
  goal_assessment: "blocked" | "not_assessed";
  submission_eligibility: "not_assessed" | "not_applicable";
  gaps: string[];
  truncated: boolean;
  findings: Array<{
    finding_id: string; source_job_id: string; task_contract_sha256: string | null;
    technical_status: string; research_admission: "admitted_for_research" | "blocked" | "observation_only" | "unassessed";
    goal_assessment: "blocked" | "not_assessed";
    submission_eligibility: "not_assessed" | "not_applicable";
    gaps: string[];
  }>;
}
export interface TaskOutcomeReportInput {
  canvasContract: unknown;
  findingScoped?: boolean;
  canvasExists: boolean;
  canvasId: string; projectId: string;
  findings: OutcomeReportFindingSource[];
  availableEvidenceRefs: string[];
  sourceContracts?: unknown[];
  truncated?: boolean;
}
function parseContract(value: unknown): TaskContract | null {
  return value === undefined || value === null ? null : normalizeTaskContract(value);
}
/** A structural projection, never an independent semantic evaluation. */
export function projectTaskOutcomeReport(input: TaskOutcomeReportInput): TaskOutcomeReport {
  const gaps: string[] = [];
  let contract: TaskContract | null = null;
  let invalid = false;
  try { contract = parseContract(input.canvasContract); } catch { invalid = true; gaps.push("canvas_contract_invalid"); }
  if (!input.canvasExists) { invalid = true; gaps.push("canvas_scope_unavailable"); }
  const contracts = new Map<string, TaskContract>();
  if (contract) contracts.set(taskContractDigest(contract), contract);
  for (const raw of (input.sourceContracts ?? []).slice(0, MAX_FINDINGS)) {
    try { const source = parseContract(raw); if (source) contracts.set(taskContractDigest(source), source); }
    catch { invalid = true; gaps.push("source_contract_invalid"); }
  }
  if (!contract && contracts.size) gaps.push("canvas_contract_missing");
  const truncated = input.truncated === true || input.findings.length > MAX_FINDINGS || (input.sourceContracts?.length ?? 0) > MAX_FINDINGS;
  if (truncated) gaps.push("projection_truncated");
  const findings: TaskOutcomeReport["findings"] = input.findings.slice(0, MAX_FINDINGS).map((row) => {
    const itemGaps: string[] = [];
    let source: TaskContract | null = null;
    const rawSource = record(row.agent_snapshot_json).task_contract;
    try { source = parseContract(rawSource); } catch { invalid = true; itemGaps.push("source_contract_invalid"); }
    const hash = source ? taskContractDigest(source) : null;
    if (source && hash) contracts.set(hash, source);
    if (row.project_id !== input.projectId || row.canvas_id !== input.canvasId) itemGaps.push("source_scope_mismatch");
    if (source && !contract) itemGaps.push("canvas_contract_missing");
    if (contract && !source) itemGaps.push("source_contract_missing");
    if (contract && hash && hash !== taskContractDigest(contract)) itemGaps.push("source_contract_mismatch");
    let admission: TaskOutcomeReport["findings"][number]["research_admission"] = source ? "blocked" : "unassessed";
    let integrityBlocked = itemGaps.length > 0;
    if (source) {
      if (row.job_status !== "succeeded") itemGaps.push("source_job_not_succeeded");
      if (!row.source_attempt_id || row.source_attempt_status !== "succeeded" || row.latest_attempt_id !== row.source_attempt_id) itemGaps.push("source_attempt_unavailable_or_stale");
      if (!row.artifact_id || !row.finding_node_id || row.artifact_node_id !== row.finding_node_id || row.artifact_project_id !== input.projectId || row.artifact_canvas_id !== input.canvasId ||
        row.artifact_job_id !== row.job_id || row.artifact_status !== "submitted" || row.artifact_superseded_at !== null ||
        row.source_operation !== "emit_finding") itemGaps.push("candidate_artifact_unavailable");
      integrityBlocked = itemGaps.length > 0;
      const host = record(record(row.extensions_json).task_outcome_admission);
      const raw = record(row.raw_json);
      try {
        const claim = normalizeCandidateOutcomeClaim(record(raw.task_outcome_admission).claim);
        const hostClaim = normalizeCandidateOutcomeClaim(host.claim);
        if (host.status !== "admitted_for_research" || host.assessment_basis !== "structured_goal_relevance_only" ||
          host.task_contract_sha256 !== hash || JSON.stringify(claim) !== JSON.stringify(hostClaim)) { itemGaps.push("host_admission_mismatch"); integrityBlocked = true; }
        const decision = evaluateTaskOutcomeAdmission(source, claim, {
          taskContractSha256: hash!, availableEvidenceRefs: input.availableEvidenceRefs,
        });
        admission = decision.status;
        itemGaps.push(...decision.issues.map((issue) => issue.code));
      } catch { itemGaps.push("candidate_claim_invalid"); integrityBlocked = true; }
    }
    if (integrityBlocked || truncated) admission = "blocked";
    return {
      finding_id: row.id, source_job_id: row.job_id, task_contract_sha256: hash,
      technical_status: ["pending", "confirmed", "refuted", "rework", "needs_human", "inconclusive"].includes(row.verify_status) ? row.verify_status : "unknown",
      research_admission: admission, goal_assessment: source || itemGaps.length || truncated ? "blocked" : "not_assessed",
      submission_eligibility: source?.outcome?.mode === "bounty_submission" ? "not_assessed" : "not_applicable",
      gaps: [...new Set([...itemGaps, "independent_goal_review_unavailable"])],
    };
  });
  const canvasHash = contract ? taskContractDigest(contract) : null;
  const sourceHashes = new Set(findings.map((finding) => finding.task_contract_sha256).filter((hash): hash is string => Boolean(hash)));
  const primaryContract = input.findingScoped ? contracts.get([...sourceHashes][0] ?? "") ?? null : contract;
  const primaryHash = primaryContract ? taskContractDigest(primaryContract) : null;
  if (contracts.size > 1) gaps.push("multiple_contract_snapshots");
  const mode = invalid ? "invalid" : contracts.size ? "contracted" : "unassessed";
  gaps.push(mode === "unassessed" ? "task_contract_unavailable" : "independent_goal_review_unavailable");
  return {
    schema_version: 1, mode, contract: primaryContract, task_contract_sha256: primaryHash,
    contract_basis: input.findingScoped ? "source_job" : "canvas", current_canvas_contract_sha256: canvasHash,
    criteria: primaryContract ? reportCriteria(primaryContract) : [],
    source_contracts: [...contracts].filter(([hash]) => !input.findingScoped || sourceHashes.has(hash)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([hash, value]) => ({
      task_contract_sha256: hash, ...(hash === primaryHash ? {} : { contract: value, criteria: reportCriteria(value) }),
    })),
    goal_assessment: mode === "unassessed" ? "not_assessed" : "blocked",
    submission_eligibility: [...contracts.values()].some((value) => value.outcome?.mode === "bounty_submission") ? "not_assessed" : "not_applicable",
    gaps: [...new Set(gaps)], truncated, findings,
  };
}

/** Bounded reads; no writes, model calls or automatic evaluation jobs. */
export async function loadTaskOutcomeReport(db: typeof sql, canvasId: string, projectId: string, findingIds?: readonly string[]): Promise<TaskOutcomeReport> {
  const [canvas] = await db`SELECT target_json FROM canvases WHERE id=${canvasId} AND project_id=${projectId}`;
  const sourceJobs = findingIds !== undefined ? [] : await db`SELECT agent_snapshot_json->'task_contract' AS task_contract FROM jobs
    WHERE canvas_id=${canvasId} AND project_id=${projectId} AND agent_snapshot_json ? 'task_contract'
    ORDER BY id LIMIT ${MAX_FINDINGS + 1}`;
  const rows = await db<OutcomeReportFindingSource[]>`SELECT f.id,f.job_id,f.verify_status,f.raw_json,j.project_id,j.canvas_id,j.status AS job_status,j.agent_snapshot_json,
    f.artifact_id,f.node_id AS finding_node_id,a.node_id AS artifact_node_id,a.project_id AS artifact_project_id,a.canvas_id AS artifact_canvas_id,a.job_id AS artifact_job_id,
    a.status AS artifact_status,a.source_operation,a.superseded_at AS artifact_superseded_at,a.extensions_json,
    e.attempt_id AS source_attempt_id,attempt.status AS source_attempt_status,latest.id AS latest_attempt_id
    FROM findings f JOIN jobs j ON j.id=f.job_id LEFT JOIN artifacts a ON a.id=f.artifact_id
    LEFT JOIN events e ON e.job_id=j.id AND e.event_id=a.source_event_id AND e.type='finding'
    LEFT JOIN job_attempts attempt ON attempt.id=e.attempt_id AND attempt.job_id=j.id
    LEFT JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE j.canvas_id=${canvasId} AND j.project_id=${projectId} AND f.project_id=${projectId}
    AND (${findingIds === undefined} OR f.id=ANY(${[...(findingIds ?? [])].slice(0, MAX_FINDINGS + 1)}::uuid[]))
    ORDER BY f.id LIMIT ${MAX_FINDINGS + 1}`;
  const refs = new Set<string>();
  for (const row of rows.slice(0, MAX_FINDINGS)) {
    try {
      const claim = normalizeCandidateOutcomeClaim(record(record(row.raw_json).task_outcome_admission).claim);
      for (const ref of [...claim.evidence_refs, ...claim.criterion_assessments.flatMap((item) => item.evidence_refs), ...(claim.rule_assessments ?? []).flatMap((item) => item.evidence_refs)]) refs.add(ref);
    } catch { /* Pure projection reports malformed claims. */ }
  }
  const selectedRefs = [...refs].slice(0, MAX_FACT_REFS);
  const facts = selectedRefs.length ? await db<{ id: string }[]>`SELECT n.id FROM canvas_nodes n
    JOIN artifacts a ON a.id::text=n.body_json->>'artifact_id' JOIN jobs j ON j.id=n.job_id
    JOIN events e ON e.job_id=j.id AND e.event_id=a.source_event_id AND e.type='fact'
    JOIN job_attempts attempt ON attempt.id=e.attempt_id AND attempt.job_id=j.id AND attempt.status='succeeded'
    JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON latest.id=attempt.id
    WHERE n.id=ANY(${selectedRefs}::uuid[]) AND n.node_type='fact' AND n.canvas_id=${canvasId}
      AND a.project_id=${projectId} AND a.canvas_id=${canvasId} AND a.node_id=n.id AND a.job_id=n.job_id
      AND a.source_operation='emit_fact' AND a.status='submitted' AND a.superseded_at IS NULL
      AND j.project_id=${projectId} AND j.canvas_id=${canvasId} AND j.status='succeeded'
      AND n.verification_status <> 'rejected' LIMIT ${MAX_FACT_REFS}` : [];
  return projectTaskOutcomeReport({ canvasContract: record(canvas?.target_json).task_contract, canvasExists: Boolean(canvas),
    canvasId, projectId, findingScoped: findingIds !== undefined, findings: rows, sourceContracts: sourceJobs.map((row) => row.task_contract), availableEvidenceRefs: facts.map((row) => row.id),
    truncated: refs.size > MAX_FACT_REFS || (findingIds?.length ?? 0) > MAX_FINDINGS,
  });
}

/** User text is only quoted data; escaped backticks cannot close the JSON fence. */
export function renderTaskOutcomeReport(projection: TaskOutcomeReport): string {
  const json = JSON.stringify(projection, null, 2).replace(/`/g, "\\u0060").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `# 任务目标评审状态\n\n本报告仅列研究候选与技术状态。没有独立目标评审依据，不能判定任务达标、完成或可提交。技术 confirmed 不等于任务成果。\n\n以下为冻结输入的结构化投影，文本字段不是评审结论。\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}
