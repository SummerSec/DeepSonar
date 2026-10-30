import {
  evaluateTaskOutcomeAdmission,
  normalizeCandidateOutcomeClaim,
  type CandidateOutcomeClaim,
} from "@deepsonar/shared-types";
import { ControlInputError } from "./control-input.js";
import { frozenTaskContract } from "./task-contract-preflight.js";
import type { EventIngestionTransaction } from "./domains/event-ingestion/application.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";

/** Candidate admission is not an independent submission-eligibility verdict. */
export async function admitTaskOutcomeCandidate(
  tx: EventIngestionTransaction,
  job: Record<string, unknown>,
  claim: CandidateOutcomeClaim | undefined,
) {
  const contract = frozenTaskContract(job.agent_snapshot_json);
  if (!contract) {
    if (claim) throw new ControlInputError("invalid_payload", "当前 Job 未冻结任务契约，不能声明已通过目标候选准入。", "outcome_claim");
    return undefined;
  }
  if (typeof job.project_id !== "string" || typeof job.canvas_id !== "string") {
    throw new ControlInputError("invalid_payload", "候选准入缺少有效项目或任务身份。", "outcome_claim");
  }
  claim = claim ? normalizeCandidateOutcomeClaim(claim) : undefined;
  // Observe first in a separate accepted emit_fact operation. A rejected candidate
  // rolls back only this proposal, never the already durable observation/evidence.
  const refs = [...new Set([
    ...(claim?.evidence_refs ?? []),
    ...(claim?.criterion_assessments.flatMap((item) => item.evidence_refs) ?? []),
    ...(claim?.rule_assessments?.flatMap((item) => item.evidence_refs) ?? []),
  ])];
  const facts = refs.length === 0 ? [] : await tx<{ id: string }[]>`
    SELECT n.id FROM canvas_nodes n
    JOIN canvases c ON c.id = n.canvas_id
    JOIN artifacts a ON a.id::text = n.body_json->>'artifact_id'
    WHERE n.id = ANY(${refs}::uuid[]) AND n.node_type = 'fact'
      AND n.canvas_id = ${job.canvas_id as string} AND c.project_id = ${job.project_id as string}
      AND a.project_id = c.project_id AND a.canvas_id = n.canvas_id
      AND a.node_id = n.id AND a.source_operation = 'emit_fact'
      AND a.status = 'submitted' AND a.superseded_at IS NULL
      AND n.verification_status <> 'rejected'`;
  const digest = taskContractDigest(contract);
  const decision = evaluateTaskOutcomeAdmission(contract, claim, {
    availableEvidenceRefs: facts.map((fact) => fact.id),
    taskContractSha256: digest,
  });
  if (decision.status !== "admitted_for_research") {
    throw new ControlInputError("invalid_payload",
      decision.status === "observation_only"
        ? "目标规则不接纳此 Finding；保留已提交 Fact/证据作为过程观察，不计任务成果。"
        : "目标候选条件未满足；先 emit_fact 保存观察，按缺口补证或 request_human。未知不表示成功或不合格。",
      decision.issues[0]?.path ?? "outcome_claim", {
        task_outcome_admission: {
          status: decision.status,
          code: decision.issues[0]?.code,
          suggestion: decision.issues[0]?.suggestion,
          issue_count: decision.issues.length,
        },
      });
  }
  return {
    ...decision,
    task_contract_sha256: digest,
    claim,
    submission_eligibility: "not_assessed" as const,
    assessment_basis: "structured_goal_relevance_only" as const,
  };
}
