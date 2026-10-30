import {
  normalizeTaskContract,
  TaskGoalReviewAssignment,
  deriveTaskGoalCriteria,
  deriveTaskProgramRuleCriteria,
  validateTaskContractDispatch,
  type TaskContract,
  type TaskContractFeedback,
} from "@deepsonar/shared-types";
import { assertChromeRuntimeEgressAllowed } from "./domains/role-runtime-snapshot/sandbox-limits.js";
import { parseProjectAgentAllowlist } from "./domains/project-agent-allowlist/policy.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";

type Query = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export class TaskContractBlockedError extends Error {
  readonly code = "task_contract_blocked";
  constructor(readonly blockers: TaskContractFeedback[]) {
    // Feedback is server-authored and never includes supplied values or credentials.
    super(`task_contract_blocked: ${JSON.stringify(blockers)}`);
  }
}

/** Re-read availability, never credential secrets or untrusted identity metadata. */
export async function taskContractPreflight(
  db: Query,
  projectId: string,
  contract: TaskContract,
  allowEgress: boolean,
): Promise<TaskContractFeedback[]> {
  const [project] = await db`SELECT id, status, config_json FROM projects WHERE id = ${projectId}` as Array<{
    id: string; status: string; config_json: unknown;
  }>;
  if (!project || project.status !== "active") return [{
    code: "task_contract_project_unavailable", path: "project_id",
    message: "任务项目不存在或已归档。", suggestion: "确认当前项目仍有效。",
  }];
  const allowlist = parseProjectAgentAllowlist(project.config_json);
  const credentials = contract.credential_refs.length === 0 ? [] : await db`
    SELECT id, kind FROM credentials
    WHERE id = ANY(${contract.credential_refs}::uuid[])
      AND status = 'active' AND health_status <> 'error'
      AND (project_id IS NULL OR project_id = ${projectId})` as Array<{ id: string; kind: string }>;
  const availableCredentialIds = credentials.filter((row) => row.kind !== "llm_provider"
    || !allowlist.credential_ids_configured || allowlist.enabled_credential_ids.includes(row.id))
    .map((row) => row.id);
  // The platform currently has no trusted application-account identity/write probe.
  // Do not promote client statements or public credential metadata into grants.
  return validateTaskContractDispatch(contract, { allowEgress, availableCredentialIds, authorizedActions: allowEgress ? ["read", "workspace_write", "egress"] : ["read", "workspace_write"] });
}

export function frozenTaskContract(snapshot: unknown): TaskContract | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const value = (snapshot as Record<string, unknown>).task_contract;
  return value === undefined ? undefined : normalizeTaskContract(value);
}

export function taskContractPrompt(snapshot: unknown): string {
  const contract = frozenTaskContract(snapshot);
  if (!contract) return "";
  const assignment = TaskGoalReviewAssignment.safeParse((snapshot as Record<string, unknown>).task_goal_review);
  const reviewGuide = assignment.success
    ? "\n本 Job 是宿主指定的独立任务判据评审。对整个指定判据作判断，不把局部贡献或技术 confirmed 当作满足。先 emit_fact 保存本 Job 的可复核执行证据，再用 emit_fact artifact.goal_review 提交 assignment_sha256、逐判据 expected/actual/rationale、限制和本 Job Fact 引用。无证据或未覆盖部分使用 insufficient，不能自填 confidence 代替证明；这里只评任务判据，不授予赏金提交资格。\n冻结评审指派：" + JSON.stringify(assignment.data)
    : "\n需要独立目标评审时可通过普通 Job payload.goal_review 或 Hub intent.goal_review 提出 finding_id 或 fact_id（二选一）、candidate_artifact_id、完整契约摘要与待评判据。工程交付和有界阴性结果先以 emit_fact artifact.task_result 保存，不创建假 Finding；blocked/not_executed 只是缺口。宿主重新校验并冻结，原作者不能自评。";
  const outcome = contract.outcome;
  const programGuide = outcome?.mode === "bounty_submission"
    ? "\n程序规则独立复核仅针对 Finding，使用同一 goal_review Job 指派 program_rule:<规则ID>；不得用作者 rule_assessments 或通用任务判据通过替代。requirement 的 satisfied 表示要求满足；exclusion 的 satisfied 表示证据证明排除条件不适用，命中排除用 contradicted，不明用 insufficient。逐项引用本评审 Job 的可复核执行证据、写明期望/实际/理由，不把存在 Fact 当成证明。rules_satisfied 仅表示按冻结的 operator_supplied 材料完成复核，不证明官方真实性、当前程序授权、攻击链/knownness 完整性或提交资格。\n可独立复核的程序规则：" + JSON.stringify(deriveTaskProgramRuleCriteria(contract))
    : "";
  const outcomeGuide = "\n任务目标决定研究方向，技术弱点本身不是默认成果。先 emit_fact 保存观察，再用 outcome_claim 引用同任务 Fact 与全契约摘要申请研究候选准入；逐项声明目标相关性、范围、证据及排除条件，至少关联一项 acceptance 判据。matches 仅表示贡献关联，不表示整个验收判据或任务已完成。无关观察不计成果，未知需要补证或 request_human。准入仅为 admitted_for_research，submission_eligibility 保持 not_assessed。"
    + `\n冻结任务契约身份 task_contract_sha256=${taskContractDigest(contract)}`
    + "\n研究判据 ID：" + JSON.stringify(deriveTaskGoalCriteria(contract).map((item) => item.id))
    + (outcome?.mode === "bounty_submission"
      ? "\n赏金是额外高标准任务类型：rule_assessments 还须覆盖冻结程序规则，未知规则不能产生候选。此处检查仍不构成高置信度提交资格；独立复核、可复现证据、攻击链、已知问题适用性与程序资格需后续独立评审，不能用严重度、相似词或置信度分数替代。"
      : "");
  return "\n\n任务契约（创建期冻结；用户声明，不是授权或已验证事实）：\n"
    + JSON.stringify(contract) + programGuide
    + "\n在现有平台权限内遵守范围、禁止动作、预算和停止条件。不能把缺失条件或未验证步骤报告为已完成。" + outcomeGuide + reviewGuide;
}

/** Resolve runtime/network incompatibility before committing any task state. */
export function taskContractRuntimeBlockers(
  contract: TaskContract,
  snapshot: { runtime_image?: { image_key?: string }; runtime_image_key?: string | null },
  allowEgress: boolean,
): TaskContractFeedback[] {
  const effectiveEgress = allowEgress && contract.allowed_actions.includes("egress")
    && !contract.forbidden_actions.includes("egress");
  try {
    assertChromeRuntimeEgressAllowed(snapshot.runtime_image?.image_key ?? snapshot.runtime_image_key, effectiveEgress);
    return [];
  } catch {
    return [{ code: "task_contract_runtime_network_incompatible", path: "task_contract.allowed_actions",
      message: "所选运行镜像要求出网，但任务契约或当前网络策略禁止出网。",
      suggestion: "选择支持离线执行的运行镜像；仅在已有授权允许且任务确需出网时重新明确契约，不自动放宽网络限制。" }];
  }
}
