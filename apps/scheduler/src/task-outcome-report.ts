import {
  normalizeTaskContract, normalizeCandidateOutcomeClaim, deriveTaskGoalCriteria,
  evaluateTaskOutcomeAdmission, normalizeTaskResultProposal, type TaskContract,
} from "@deepsonar/shared-types";
import { loadTaskGoalReviews } from "./task-goal-review.js";
import { applyTaskGoalReviews } from "./task-goal-review-report.js";
import type { sql } from "./db.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import { loadTaskResultDeclaration, loadTaskResultSource } from "./task-result-source.js";
import { criterionEvidenceBudget, type EvidenceReadBudget } from "./domains/plan-protocol/criterion-evidence.js";
import { ControlInputError } from "./control-input.js";
import { isRetryableDatabaseConflict } from "./db-conflict-retry.js";
import type { TaskProgramRuleReview } from "./task-program-rule-report.js";
import type { ProgramEligibilityProjection } from "@deepsonar/shared-types";
import { loadProgramEligibilityProjections } from "./domains/program-eligibility/store.js";
import { applyProgramEligibilityProjections } from "./domains/program-eligibility/report.js";

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
export type TaskOutcomeReportCriterion = { id: string; assessment: "not_assessed" | "satisfied" | "contradicted" | "insufficient" | "conflict"; review_indexes?: number[] };
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
  goal_assessment: "blocked" | "not_assessed" | "partially_satisfied" | "criteria_satisfied";
  submission_eligibility: "not_assessed" | "not_applicable" | "eligible" | "ineligible" | "blocked";
  gaps: string[];
  truncated: boolean;
  review_records?: Array<{ artifact_id: string; gaps?: string[] }>;
  task_results?: Array<{
    artifact_id: string; fact_id: string; source_job_id: string; source_attempt_id: string | null; artifact_revision?: number;
    kind: "delivery" | "negative_result" | "blocked" | "not_executed" | "unknown";
    task_contract_sha256: string | null; assessment: TaskOutcomeReport["goal_assessment"]; gaps: string[];
    limitations: string[]; limitations_truncated?: boolean;
  }>;
  findings: Array<{
    program_rule_review?: TaskProgramRuleReview;
    program_eligibility?: ProgramEligibilityProjection;
    finding_id: string; source_job_id: string; task_contract_sha256: string | null;
    technical_status: string; research_admission: "admitted_for_research" | "blocked" | "observation_only" | "unassessed";
    goal_assessment: "blocked" | "not_assessed" | "partially_satisfied" | "criteria_satisfied";
    submission_eligibility: "not_assessed" | "not_applicable" | "eligible" | "ineligible" | "blocked";
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
    gaps: [...new Set(gaps)], truncated, findings, task_results: [],
  };
}

/** Bounded source scan; independent reviews, not result labels, decide criterion satisfaction. */
async function loadReportTaskResults(db: typeof sql, projectId: string, canvasId: string, report: TaskOutcomeReport, budget: EvidenceReadBudget) {
  const rows = await db`SELECT a.id,a.node_id,a.job_id,a.extensions_json FROM artifacts a
    JOIN jobs j ON j.id=a.job_id
    WHERE a.project_id=${projectId} AND a.canvas_id=${canvasId} AND j.project_id=${projectId} AND j.canvas_id=${canvasId}
      AND a.source_operation='emit_fact' AND a.extensions_json ? 'task_result'
    ORDER BY a.id LIMIT ${MAX_FINDINGS + 1}`;
  if (rows.length > MAX_FINDINGS) { report.truncated = true; report.gaps.push("task_result_projection_truncated"); }
  for (const row of rows.slice(0, MAX_FINDINGS)) {
    const result: NonNullable<TaskOutcomeReport["task_results"]>[number] = { artifact_id: String(row.id), fact_id: String(row.node_id ?? ""),
      source_job_id: String(row.job_id), source_attempt_id: null, kind: "unknown", task_contract_sha256: null, assessment: "blocked", gaps: [], limitations: [] };
    try {
      const proposal = normalizeTaskResultProposal(record(record(row.extensions_json).task_result).proposal);
      const request = { schema_version: 1, fact_id: result.fact_id, candidate_artifact_id: result.artifact_id,
        task_contract_sha256: proposal.task_contract_sha256, criterion_ids: proposal.criterion_ids };
      const declaration = await loadTaskResultDeclaration(db, projectId, canvasId, request);
      result.kind = declaration.proposal.kind; result.task_contract_sha256 = declaration.proposal.task_contract_sha256;
      result.source_attempt_id = declaration.trace.attempt_id; result.artifact_revision = declaration.trace.artifact_revision;
      result.limitations = declaration.proposal.limitations.slice(0, 3).map((text) => text.slice(0, 200));
      if (declaration.proposal.limitations.length > 3 || declaration.proposal.limitations.some((text) => text.length > 200)) result.limitations_truncated = true;
      result.gaps.push(...declaration.executionReasons);
      if (proposal.task_contract_sha256 !== report.current_canvas_contract_sha256) result.gaps.push("source_contract_mismatch");
      if (proposal.kind === "blocked" || proposal.kind === "not_executed") result.gaps.push("task_result_not_reviewable");
      if (result.gaps.length) { report.task_results!.push(result); continue; }
      const source = await loadTaskResultSource(db, projectId, canvasId, request, budget);
      if (!report.source_contracts.some((item) => item.task_contract_sha256 === proposal.task_contract_sha256)) {
        report.source_contracts.push({ task_contract_sha256: proposal.task_contract_sha256, contract: source.contract, criteria: reportCriteria(source.contract) });
      }
      result.assessment = "not_assessed";
    } catch (error) {
      // #945 review P2: a retryable lock conflict must reach the transaction
      // retry boundary instead of being flattened into a business gap. Once the
      // transaction is aborted every later query only reports 25P02, which is
      // correctly not retried, so swallowing the original conflict here would
      // silently disable the recovery this slice adds.
      if (isRetryableDatabaseConflict(error)) throw error;
      const code = error instanceof ControlInputError ? record(error.details?.task_goal_review).code : undefined;
      const reason = typeof code === "string" ? code : "task_result_validation_unavailable";
      result.gaps.push(reason);
      if (reason.includes("budget_exceeded")) { report.truncated = true; report.gaps.push("task_result_projection_incomplete"); }
    }
    report.task_results!.push(result);
  }
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
  const projection = projectTaskOutcomeReport({ canvasContract: record(canvas?.target_json).task_contract, canvasExists: Boolean(canvas),
    canvasId, projectId, findingScoped: findingIds !== undefined, findings: rows, sourceContracts: sourceJobs.map((row) => row.task_contract), availableEvidenceRefs: facts.map((row) => row.id),
    truncated: refs.size > MAX_FACT_REFS || (findingIds?.length ?? 0) > MAX_FINDINGS,
  });
  const budget = criterionEvidenceBudget();
  if (findingIds === undefined) await loadReportTaskResults(db, projectId, canvasId, projection, budget);
  const reviewed = applyTaskGoalReviews(projection, await loadTaskGoalReviews(db, projectId, canvasId, findingIds, budget));
  const eligibility = await loadProgramEligibilityProjections(db, projectId, reviewed.findings.map((finding) => finding.finding_id));
  return applyProgramEligibilityProjections(reviewed, eligibility);
}

/**
 * #1250：报告开头用读者能懂的中文交代结果与下一步；术语与完整 JSON 全部下沉到
 * 详细数据区。所有句子只写投影里真实存在的字段，缺记录就显式说缺，不反推。
 */
const TECHNICAL_STATUS_LABELS: Record<string, string> = {
  confirmed: "已确认", refuted: "已反驳", rework: "待修正重验",
  needs_human: "需人工判断", inconclusive: "证据不足",
  pending: "尚未完成自动验证", unknown: "状态未知",
};
const TASK_RESULT_LABELS: Record<string, string> = {
  delivery: "交付", negative_result: "阴性结论", blocked: "受阻", not_executed: "未执行", unknown: "状态未知",
};
const TOP_GAP_GUIDANCE: Record<string, string> = {
  independent_goal_review_unavailable: "还缺少独立的目标评审记录；评审由平台在验证与审查轮次处理，或由管理员在任务详情里发起，不再收集证据时不自动收口。",
  task_contract_unavailable: "任务创建时没有声明目标契约：结果仍按漏洞正文阅读，但目标是否达成无法判断；这需要任务创建方补契约（Agent 侧改写无用）。",
  canvas_contract_missing: "画布没有自己的目标契约，来源 Job 的契约仍被记录；判断达成需要先核对来源契约，详见投影的契约表。",
  canvas_contract_invalid: "画布上的目标契约无法解析：需要任务创建方修正契约本身。",
  canvas_scope_unavailable: "画布记录不可用，报告无法对应到当前目标：需要平台核对画布归属与权限。",
  source_contract_invalid: "部分来源 Job 的契约无法解析：相应来源不计入目标口径，原始记录保留。",
  multiple_contract_snapshots: "同一任务记录到多份来源契约：需要平台核对契约绑定是否失效，此前结论都保持保守。",
  candidate_artifact_unavailable: "部分候选的提交载体不完整或已过期：平台继续按现有验证流程处理，详情见对应 Finding。",
  projection_truncated: "数据超过展示上限被截断：完整口径应读投影与 SARIF 附属，不因截断给出更积极或更消极的结论。",
};
function gapGuidance(code: string): string {
  if (TOP_GAP_GUIDANCE[code]) return TOP_GAP_GUIDANCE[code]!;
  if (code.endsWith("_truncated")) return `数据超过展示上限（${code}）：完整口径可见投影，不因截断改变判断。`;
  if (code === "task_result_projection_truncated" ) return "任务结果声明超过投影上限：完整口径以详细数据区的 JSON 为准。";
  if (code === "task_result_projection_incomplete") return "证据预算不足，部分任务结果声明缺少完整依据：结论保持保守，不当作已核实。";
  if (code === "task_contract_unavailable") return TOP_GAP_GUIDANCE.task_contract_unavailable!;
  return `原因代码 ${code} 暂无通俗解释：以详细数据区的原始记录为准，不影响本报告对已有记录的陈述。`;
}
const GOAL_ASSESSMENT_TEXT: Record<TaskOutcomeReport["goal_assessment"], string> = {
  not_assessed: "还没有独立评审覆盖目标判据，达成情况未知（不是失败，也不是已满足）。",
  blocked: "目标评审被阻塞；达成情况未知，阻塞原因见「下一步」。",
  partially_satisfied: "独立评审覆盖到的判据里只有一部分满足；其余判据未获评审或被阻塞。",
  criteria_satisfied: "已获独立评审的判据全部满足。这只覆盖被评审过的判据，不代表任务整体结束或全部证据完备。",
};
export function renderTaskOutcomeReport(projection: TaskOutcomeReport): string {
  const statusCounts = new Map<string, number>();
  for (const finding of projection.findings) statusCounts.set(finding.technical_status, (statusCounts.get(finding.technical_status) ?? 0) + 1);
  const resultKinds = new Map<string, number>();
  for (const result of projection.task_results ?? []) resultKinds.set(result.kind, (resultKinds.get(result.kind) ?? 0) + 1);
  const findingSummary = projection.findings.length
    ? Object.entries(TECHNICAL_STATUS_LABELS).map(([key, label]) => `${label} ${statusCounts.get(key) ?? 0}`).join("、")
    : "本画布没有与目标相关的漏洞记录";
  const resultSummary = projection.task_results?.length
    ? Object.entries(TASK_RESULT_LABELS).map(([key, label]) => `${label} ${resultKinds.get(key) ?? 0}`).join("、")
    : "本画布没有记录到 task_result 声明";
  const criteriaTotal = projection.criteria.length;
  const criteriaSatisfied = projection.criteria.filter((criterion) => criterion.assessment === "satisfied").length;
  const goalText = criteriaTotal
    ? `${GOAL_ASSESSMENT_TEXT[projection.goal_assessment]}判据 ${criteriaSatisfied} / ${criteriaTotal} 被评审为满足。`
    : GOAL_ASSESSMENT_TEXT[projection.goal_assessment];
  const lines = [
    "## 任务结果与验证状态（摘要）", "",
    "本节由调度器在结算时生成，只写有记录支持的内容，缺什么评审记录会如实标注。",
    "报告生成成功只表示报告写出来了，不等于任务执行成功或目标达成；漏洞验证与目标评审是两个独立口径，分开陈述。", "",
    `- **漏洞验证**：${findingSummary}。只有"已确认"代表有可信证据支持漏洞真实存在；其他状态既不能排除也不证明漏洞。`,
    `- **任务结果声明**：${resultSummary}。这些是 Agent 声明的执行记录，平台核对到证据的才进入后续评审。`,
    `- **目标评审**：${goalText}`,
  ];
  const gapGuides = [...new Set(projection.gaps)].map((code) => `- ${gapGuidance(code)}`);
  if (gapGuides.length) {
    lines.push("", "### 下一步", "", ...gapGuides, "");
    lines.push("以上「谁负责」只描述现有职责边界；缺少明确记录时，本报告不冒充能自动完成人或平台才能做的事。");
  }
  lines.push("", "### 评审状态投影（详细数据）", "",
    "以下 JSON 是冻结输入的结构化投影，文本字段不是评审结论；只有有效评审覆盖的判据可以 satisfied，技术 confirmed 不等于程序 eligible。", "");
  // #1250：转义写成运行时拼接，源码里不再出现 \u 序列（它会被静默解成反引号，围栏就失效）。
  const json = JSON.stringify(projection, null, 2).split("`").join("\\u0060").split("<").join("\\u003c").split(">").join("\\u003e");
  lines.push("```json", json, "```");
  return lines.join("\n") + "\n";
}
